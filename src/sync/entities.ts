import type { Json, PlayerId, PlayerInfo } from '@gamerelay/protocol/types';
import type { Warn } from '../debug/warnings';
import { SampleBuffer } from '../core/buffer';
import { DelayEstimator } from '../core/clock';
import {
  FULL,
  HOST,
  LEAVE_HOST,
  REMOVE,
  SPAWN,
  TELEPORT,
  bufferKind,
  checkValue,
  compileSchema,
  decodeChanges,
  encodeChanges,
  isEntry,
  type Entry,
  type FieldInput,
  type KindSchema,
} from '../core/codec';
import { createIdAllocator, kindOf } from '../core/ids';
import { GameRelayError } from '../errors';
import type { SyncTransport } from './transport';

/**
 * What every entity has besides its fields. Entities are live objects (Proxies): read and write
 * fields directly; copy one with `{ ...entity }` (structuredClone can't copy a Proxy). Key your own
 * game data by `entity.id`, or by `entity.owner.id` for "that player's ship".
 */
export interface EntityBase {
  readonly id: string;
  readonly kind: string;
  /** The player who writes it (for host entities: whoever is host now). */
  readonly owner: PlayerInfo;
  /** True if you write it. */
  readonly mine: boolean;
  /**
   * The next update is a jump: everyone snaps to it instead of sliding (respawns, portals). Call it
   * in the same frame as the position write, before or after.
   */
  teleport(): void;
  remove(): void;
}
export interface Entity extends EntityBase {
  [field: string]: unknown;
}
export type RemoveReason = 'removed' | 'left' | 'expired';
export interface SpawnOptions {
  /** `'host'`: the entity belongs to the host role, not a player; whoever is host writes it. */
  owner?: 'host';
  /**
   * `'host'`: when you leave for good, the host keeps it (a carried flag stays in the world)
   * instead of it disappearing with you.
   */
  onLeave?: 'host';
}
export interface DefineOptions {
  /** Updates per second (1–60, default 20). */
  rate?: number;
}
export interface EntityHooks {
  onSpawn?(entity: Entity): void;
  onRemove?(entity: Entity, reason: RemoveReason): void;
  warn?: Warn;
}

export const MAX_OWN = 256;
export const MAX_ROOM = 1024;
/** Split outgoing updates well under the server's 16 KB message limit. */
export const MAX_MESSAGE_BYTES = 8_000;
const KEYFRAME_MS = 1000;
const STAMP_SLACK_MS = 1000;
const PENDING_PER_KIND = 256;
/** A connected owner sends at least a keyframe a second; this much silence means the entity is gone. */
const EXPIRE_MS = 3000;
/** How often (ms) the timeline is advanced at most: reads within one frame share it. */
const ADVANCE_MS = 4;
/** A gap this long between our own advances means *we* were frozen (a suspended page), not them. */
const OWN_STALL_MS = 1000;
const utf8 = new TextEncoder();
const sessionOf = (id: string) => id.split(':')[1] ?? '';
/** Only these fields can trip the unannounced-jump snap: positions jump, velocities just change. */
const POSITION_FIELDS = new Set(['x', 'y', 'z']);
/** `Remote.owner` for host-owned entities: the host role, not a player. */
const HOST_OWNER = '\u0000host';

/** What an entity object reads and writes through; swapped in place on a host handover. */
interface Slot {
  rec: { id: string; schema: KindSchema; values: unknown[] };
  mine: () => boolean;
  owner: () => PlayerInfo;
  write: (index: number, value: unknown) => void;
  teleport: () => void;
  remove: () => void;
  refresh: () => void;
}

interface Local {
  id: string;
  schema: KindSchema;
  values: unknown[];
  sent: unknown[];
  spawned: boolean;
  teleport: boolean;
  removed: boolean;
  nextSend: number;
  nextKey: number;
  /** The last send carried changes: the next quiet tick sends a "still here" sample. */
  moved: boolean;
  /** When a field last changed (server clock): the moment the values describe, not when they're sent. */
  writtenAt: number;
  /** The usual time between the game's writes (its simulation step), smoothed; 0 until known. */
  writeGap: number;
  /** A write that no update has carried yet (a flag, not a time: write times are scheduled step times, a clock sends don't share). */
  unsent: boolean;
  /** Host-owned: written by whoever is host (that's us, while it's local). */
  host: boolean;
  /** Handed to the host when we leave (`onLeave: 'host'`). */
  leaveHost: boolean;
  slot: Slot;
  obj: Entity;
}
interface Remote {
  id: string;
  schema: KindSchema;
  owner: PlayerId;
  buffer: SampleBuffer;
  values: unknown[];
  firstAt: number;
  visible: boolean;
  removedAt?: number;
  reason?: RemoveReason;
  /** Local time of the last update from the owner (for expiry). */
  lastSeen: number;
  /** Timeline time `values` were read at; `Infinity` once removed (values frozen). */
  readAt: number;
  host: boolean;
  /** Becomes a host entity when its owner leaves, instead of going with them. */
  leaveHost: boolean;
  slot: Slot;
  obj: Entity;
}

const bad = (message: string) => new GameRelayError('bad_request', message);
const unknownField = (kind: string, key: string) => `${kind} has no field '${key}'; add it to room.define('${kind}', { … })`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class EntityStore {
  readonly delay = new DelayEstimator();
  readonly #t: SyncTransport;
  readonly #hooks: EntityHooks;
  readonly #newId: (kind: string) => string;
  readonly #schemas = new Map<string, KindSchema>();
  readonly #local = new Map<string, Local>();
  readonly #remote = new Map<string, Remote>();
  readonly #pending = new Map<string, { entry: Entry; from: PlayerId; t: number }[]>();
  /** Which player first sent each id session: nobody else may create ids in it. */
  readonly #sessions = new Map<string, PlayerId>();
  #lastAdvance = -Infinity;
  /** When we last advanced while online: silence is only judged while we're listening. */
  #listening = Number.NaN;
  #lastT = 0;
  #down = false;
  readonly #warnedKinds = new Set<string>();
  /** The last stamp sent: stamps never run backwards. */
  #lastStamp = Number.NEGATIVE_INFINITY;

  constructor(t: SyncTransport, hooks: EntityHooks = {}, newId: (kind: string) => string = createIdAllocator()) {
    this.#t = t;
    this.#hooks = hooks;
    this.#newId = newId;
  }

  renderTime(): number {
    return this.#t.now() - this.delay.ms;
  }

  define(kind: string, fields: Record<string, FieldInput>, options: DefineOptions = {}): void {
    const schema = compileSchema(kind, fields, options.rate);
    const had = this.#schemas.get(kind);
    if (had) {
      if (had.hash !== schema.hash || had.rate !== schema.rate) throw bad(`room.define('${kind}') was already called with different fields`);
      return;
    }
    this.#schemas.set(kind, schema);
    const waiting = this.#pending.get(kind) ?? [];
    this.#pending.delete(kind);
    for (const p of waiting) this.#apply(p.entry, p.from, p.t);
  }

  spawn(kind: string, initial: Record<string, unknown>, options: SpawnOptions = {}): Entity {
    const schema = this.#schemas.get(kind);
    if (!schema) throw bad(`room.spawn('${kind}'): call room.define('${kind}', { … }) first`);
    const host = options.owner === 'host';
    if (host && this.#t.hostId?.() !== this.#t.me) {
      throw bad(`room.spawn('${kind}', …, { owner: 'host' }): only the host can create host entities; check room.isHost first (or create them in room.on('host', …))`);
    }
    if (this.#local.size >= MAX_OWN) throw bad(`room.spawn: at most ${MAX_OWN} entities per player; remove some first`);
    if (this.#local.size + this.#remote.size >= MAX_ROOM) throw bad(`room.spawn: this room is at its ${MAX_ROOM}-entity limit`);
    for (const key of Object.keys(initial ?? {})) if (!schema.index.has(key)) throw bad(unknownField(kind, key));
    const values = schema.fields.map((f) => {
      const v = initial?.[f.name];
      if (v === undefined) throw bad(`room.spawn('${kind}'): give a starting value for '${f.name}'`);
      checkValue(kind, f, v);
      return v;
    });
    const now = this.#t.now();
    const rec = this.#makeLocal(this.#newId(kind), schema, values, host, now);
    rec.nextKey = now + KEYFRAME_MS;
    rec.spawned = false;
    rec.leaveHost = !host && options.onLeave === 'host';
    this.#local.set(rec.id, rec);
    this.#hooks.onSpawn?.(rec.obj);
    return rec.obj;
  }

  all(kind: string): Entity[] {
    if (!this.#schemas.has(kind)) this.#unknownKind(kind);
    this.#advance();
    const out: Entity[] = [];
    for (const r of this.#local.values()) if (r.schema.kind === kind && !r.removed) out.push(r.obj);
    for (const r of this.#remote.values()) if (r.visible && r.schema.kind === kind) out.push(r.obj);
    return out;
  }

  /** Warn once per name about a kind nobody defined (usually a typo), naming the closest one. */
  #unknownKind(kind: string): void {
    if (this.#warnedKinds.has(kind) || this.#pending.has(kind)) return;
    this.#warnedKinds.add(kind);
    let best = '';
    let bestD = 3;
    for (const name of this.#schemas.keys()) {
      const d = editDistance(kind, name);
      if (d < bestD) [best, bestD] = [name, d];
    }
    this.#hooks.warn?.(
      'kind',
      `kind:${kind}`,
      `room.all('${kind}'): no kind '${kind}' is defined${best ? `; did you mean '${best}'?` : ''} Call room.define('${kind}', { … }) first; it returns a handle whose .all() can't be misspelled`,
    );
  }

  get(id: string): Entity | undefined {
    const l = this.#local.get(id);
    if (l) return l.removed ? undefined : l.obj;
    this.#advance();
    const r = this.#remote.get(id);
    return r?.visible ? r.obj : undefined;
  }

  /** Host entities per kind (debug and the eval scorer: they must survive the host leaving). */
  hostedCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.#local.values()) if (!r.removed && r.host) out[r.schema.kind] = (out[r.schema.kind] ?? 0) + 1;
    for (const r of this.#remote.values()) if (r.visible && r.host) out[r.schema.kind] = (out[r.schema.kind] ?? 0) + 1;
    return out;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.#local.values()) if (!r.removed) out[r.schema.kind] = (out[r.schema.kind] ?? 0) + 1;
    for (const r of this.#remote.values()) if (r.visible) out[r.schema.kind] = (out[r.schema.kind] ?? 0) + 1;
    return out;
  }

  /** Called by the room about 60 times a second: sends what's due, then advances the timeline. */
  tick(): void {
    const now = this.#t.now();
    if (!(this.#t.ready?.() ?? true)) {
      // Offline: send nothing (it would only pile up), and start over with full updates.
      this.#down = true;
      this.#advance();
      return;
    }
    if (this.#down) {
      this.#down = false;
      for (const rec of this.#local.values()) {
        rec.nextSend = now;
        rec.nextKey = now;
      }
    }
    // Each message is stamped with when its values were written (the game's simulation step), not
    // when it's sent: a 30 Hz simulation sent on a 20 Hz grid would otherwise carry one step in some
    // updates and two in others, at evenly spaced stamps, and others would see the speed pulse.
    const out = {
      own: { entries: [] as Entry[], reliable: false, t: Number.NEGATIVE_INFINITY },
      host: { entries: [] as Entry[], reliable: false, t: Number.NEGATIVE_INFINITY },
    };
    for (const rec of [...this.#local.values()]) {
      const group = rec.host ? out.host : out.own;
      const entries = group.entries;
      const hf = rec.host ? HOST : 0;
      if (rec.removed) {
        if (rec.spawned) {
          // Last changes first (a ship that died, then despawned), then the removal.
          const { pairs } = encodeChanges(rec.schema, rec.values, rec.sent, false);
          if (pairs.length > 0) entries.push([rec.id, hf, pairs]);
          entries.push([rec.id, REMOVE | hf, []]);
          group.reliable = true;
          group.t = Math.max(group.t, now);
        }
        this.#local.delete(rec.id);
        continue;
      }
      // It stopped: one "still here" sample, so others stop where it did instead of overshooting.
      // "Stopped" means quiet for longer than its usual step, so a game simulating slower than we
      // send (15 Hz, say) is between two steps, not stopped; and it goes out as soon as that's
      // clear, off the send grid, before others' timelines run past the last position.
      if (rec.moved && !rec.teleport && !rec.unsent && now - rec.writtenAt >= this.#quietAfter(rec)) {
        entries.push([rec.id, hf, []]);
        group.t = Math.max(group.t, now);
        rec.moved = false;
        continue;
      }
      if (now < rec.nextSend) continue;
      // Every entity of a rate sends on one shared grid, so a tick's changes go out as one message.
      const interval = 1000 / rec.schema.rate;
      rec.nextSend = (Math.floor(now / interval) + 1) * interval;
      const full = !rec.spawned || now >= rec.nextKey;
      // Half an interval of slack so the keyframe lands on the send nearest the second mark.
      if (full) rec.nextKey = now + KEYFRAME_MS - interval / 2;
      // Did anything actually change since the last send? (A keyframe resends everything anyway.)
      const changed = !full || encodeChanges(rec.schema, rec.values, rec.sent.slice(), false).pairs.length > 0;
      const { pairs, discrete } = encodeChanges(rec.schema, rec.values, rec.sent, full);
      if (pairs.length === 0 && !rec.teleport) {
        rec.unsent = false; // what was written rounds to what's already sent
        continue; // nothing new (a "still here" sample, when due, went out above)
      }
      rec.moved = changed && pairs.length > 0;
      rec.unsent = false;
      const flags = (rec.spawned ? 0 : SPAWN) | (full ? FULL | (rec.leaveHost ? LEAVE_HOST : 0) : 0) | (rec.teleport ? TELEPORT : 0) | hf;
      entries.push(full ? [rec.id, flags, pairs, rec.schema.hash] : [rec.id, flags, pairs]);
      // A teleport must arrive: lost, the next plain update reads as a slide across the map.
      if (full || discrete || rec.teleport) group.reliable = true;
      // Fresh changes are stamped when they were written; a keyframe with nothing new is "as of now".
      group.t = Math.max(group.t, changed && rec.spawned ? rec.writtenAt : now);
      rec.spawned = true;
      rec.teleport = false;
    }
    this.#flush(out.own.entries, out.own.reliable, undefined, false, out.own.t);
    this.#flush(out.host.entries, out.host.reliable, undefined, true, out.host.t);
    this.#advance();
  }

  receive(data: unknown, from: PlayerId, at: number): boolean {
    if (!isObj(data) || data.$gr !== 'u') return false;
    if (from === this.#t.me || !Array.isArray(data.e)) return true;
    const t = typeof data.t === 'number' && Math.abs(data.t - at) <= STAMP_SLACK_MS ? data.t : at;
    let interval = 50;
    for (const entry of data.e) {
      if (!isEntry(entry)) continue;
      const schema = this.#apply(entry, from, t);
      if (schema) interval = 1000 / schema.rate;
    }
    this.delay.observe(this.#t.now() - t, interval);
    return true;
  }

  /** Someone joined: send them a full update of everything you own. */
  playerJoined(id: PlayerId): void {
    if (id === this.#t.me) return;
    const own: Entry[] = [];
    const hosted: Entry[] = [];
    for (const rec of this.#local.values()) {
      if (rec.removed || !rec.spawned) continue;
      const { pairs } = encodeChanges(rec.schema, rec.values, [], true);
      (rec.host ? hosted : own).push([rec.id, SPAWN | FULL | (rec.host ? HOST : 0) | (rec.leaveHost ? LEAVE_HOST : 0), pairs, rec.schema.hash]);
    }
    this.#flush(own, true, id);
    this.#flush(hosted, true, id, true);
  }

  /**
   * The host role moved. Becoming host: every host entity becomes ours to write, continuing from the
   * last values received (not the smoothed ones, which lag). Losing it: ours become read-only and
   * follow the new host. The entity objects stay the same either way.
   */
  hostChanged(hostId: PlayerId, previous: PlayerId): void {
    const now = this.#t.now();
    const me = this.#t.me;
    if (hostId === me && previous !== me) {
      for (const r of [...this.#remote.values()]) {
        if (r.host && r.removedAt === undefined) this.#takeOver(r, now);
      }
    } else if (previous === me && hostId !== me) {
      for (const l of [...this.#local.values()]) {
        if (!l.host) continue;
        this.#local.delete(l.id);
        // Seeded at the moment we're showing, so it glides on to the new host's updates.
        if (!l.removed) this.#remote.set(l.id, this.#makeRemote(l.id, l.schema, HOST_OWNER, this.renderTime(), true, l));
      }
    }
    for (const r of this.#remote.values()) if (r.host) r.lastSeen = now;
  }

  /**
   * Someone left for good: their entities go once the timeline reaches their last update, except
   * `onLeave: 'host'` ones, which become host entities (the same objects, carrying on).
   */
  playerLeft(id: PlayerId): void {
    const now = this.#t.now();
    for (const r of [...this.#remote.values()]) {
      if (r.host || r.owner !== id || r.removedAt !== undefined) continue; // host entities outlive any host
      if (r.leaveHost) {
        this.#adopt(r, now);
        continue;
      }
      r.removedAt = r.buffer.latestTime ?? now;
      r.reason = 'left';
    }
    for (const [kind, list] of this.#pending) this.#pending.set(kind, list.filter((p) => p.from !== id));
    for (const [session, owner] of this.#sessions) if (owner === id) this.#sessions.delete(session);
  }

  /** A remote host entity becomes ours to write, from the last values received (same object). */
  #takeOver(r: Remote, now: number): void {
    this.#remote.delete(r.id);
    const l = this.#makeLocal(r.id, r.schema, r.buffer.latest() ?? r.values.slice(), true, now, r);
    this.#local.set(l.id, l);
    if (!r.visible) this.#hooks.onSpawn?.(l.obj);
  }

  /** A leaver's `onLeave: 'host'` entity joins the host's: ours if we host, else following the host. */
  #adopt(r: Remote, now: number): void {
    if (this.#t.hostId?.() === this.#t.me) return this.#takeOver(r, now);
    const n = this.#makeRemote(r.id, r.schema, HOST_OWNER, r.firstAt, true, r, r.buffer);
    Object.assign(n, { visible: r.visible, readAt: r.readAt, lastSeen: now });
    this.#remote.set(n.id, n);
  }

  /** How long an entity must go unwritten to count as stopped: 1.5 of its usual steps, or one send interval until we know them. */
  #quietAfter(rec: Local): number {
    return rec.writeGap > 0 ? rec.writeGap * 1.5 : 1000 / rec.schema.rate;
  }

  #flush(entries: Entry[], reliable: boolean, to?: PlayerId, host = false, stamp?: number): void {
    if (entries.length === 0) return;
    const now = this.#t.now();
    // Between the last stamp and now: never backwards (receivers treat time as ordered), never ahead.
    const t = Math.round(Math.min(now, Math.max(stamp ?? now, this.#lastStamp)));
    if (to === undefined) this.#lastStamp = t;
    let chunk: Entry[] = [];
    let size = 0;
    const send = () => {
      if (chunk.length > 0) this.#t.send({ $gr: 'u', t, e: chunk } as unknown as Json, { to, reliable, ...(host ? { host } : {}) });
      chunk = [];
      size = 0;
    };
    for (const entry of entries) {
      const n = utf8.encode(JSON.stringify(entry)).byteLength + 1;
      if (size + n > MAX_MESSAGE_BYTES) send();
      chunk.push(entry);
      size += n;
    }
    send();
  }

  #apply(entry: Entry, from: PlayerId, t: number): KindSchema | undefined {
    const [id, flags, pairs, hash] = entry;
    const kind = kindOf(id);
    const schema = this.#schemas.get(kind);
    if (!schema) {
      if (!kind) return undefined;
      const list = this.#pending.get(kind) ?? [];
      list.push({ entry, from, t });
      if (list.length > PENDING_PER_KIND) list.shift();
      this.#pending.set(kind, list);
      return undefined;
    }
    let rec = this.#remote.get(id);
    if (this.#local.has(id)) return schema;
    const hosted = rec ? rec.host : (flags & HOST) !== 0;
    // Host entities take updates from the current host only; the rest from their owner only.
    if (hosted ? from !== this.#t.hostId?.() : rec !== undefined && rec.owner !== from) return schema;
    if (rec) rec.lastSeen = this.#t.now();
    if (rec && flags & LEAVE_HOST && !rec.host) rec.leaveHost = true;
    if (flags & REMOVE) {
      if (rec && rec.removedAt === undefined) {
        rec.removedAt = Math.max(t, rec.buffer.latestTime ?? t);
        rec.reason = 'removed';
      }
      return schema;
    }
    if (!rec) {
      if (!(flags & FULL)) return schema; // wait for a full update
      if (hash !== schema.hash) {
        this.#hooks.warn?.(
          'fields',
          `fields:${kind}`,
          `${kind} fields differ between players: are they on different builds? Ignoring ${this.#info(from).name || from}'s ${kind} updates`,
        );
        return schema;
      }
      if (this.#local.size + this.#remote.size >= MAX_ROOM) {
        this.#hooks.warn?.(
          'room_full',
          'room_full',
          `this room holds ${MAX_ROOM} entities, the most it can: new ones from other players are ignored until some are removed (remove bullets and effects when they're done)`,
        );
        return schema;
      }
      const session = sessionOf(id);
      const claimed = this.#sessions.get(session);
      // (Host entities keep the ids their first host minted, so they're exempt.)
      if (!hosted && claimed !== undefined && claimed !== from) return schema; // someone else's id space
      if (!hosted && claimed === undefined) {
        this.#sessions.set(session, from);
        // A new session from this owner means it reloaded or reconnected afresh: its old entities are gone.
        for (const r of this.#remote.values()) {
          if (r.host || r.owner !== from || r.removedAt !== undefined || sessionOf(r.id) === session) continue;
          r.removedAt = r.buffer.latestTime ?? t;
          r.reason = 'expired';
        }
      }
      const created = this.#makeRemote(id, schema, hosted ? HOST_OWNER : from, t, hosted);
      created.leaveHost = !hosted && (flags & LEAVE_HOST) !== 0;
      this.#remote.set(id, created);
      rec = created;
    } else if (rec.removedAt !== undefined) {
      return schema;
    }
    const values = decodeChanges(schema, pairs);
    if (!values) return schema;
    const jumped = rec.buffer.push(t, values, (flags & TELEPORT) !== 0);
    if (jumped && (schema.index.has('x') || schema.index.has('y'))) {
      this.#hooks.warn?.(
        'jump',
        `jump:${kind}`,
        `${kind} jumped across the map without teleport(): call entity.teleport() when respawning so everyone snaps instead of sliding`,
      );
    }
    return schema;
  }

  #advance(): number {
    const now = this.#t.now();
    if (now - this.#lastAdvance < ADVANCE_MS) return this.#lastT;
    this.#lastAdvance = now;
    const t = (this.#lastT = now - this.delay.ms);
    const online = this.#t.ready?.() ?? true;
    // Coming back from our own outage (offline, or our page frozen): nobody went silent, we did.
    const resumed = online && !(now - this.#listening <= OWN_STALL_MS);
    this.#listening = online ? now : Number.NaN;
    for (const r of this.#remote.values()) {
      if (resumed) r.lastSeen = now;
      if (r.removedAt === undefined && online) {
        // Silence only counts while the owner is connected (a disconnected owner's entities freeze).
        const ownerId = r.host ? this.#t.hostId?.() : r.owner;
        if (ownerId !== undefined && this.#t.player(ownerId)?.connected === false) r.lastSeen = now;
        else if (now - r.lastSeen > EXPIRE_MS) {
          r.removedAt = r.buffer.latestTime ?? t;
          r.reason = 'expired';
        }
      }
      if (!r.visible && t >= r.firstAt && (r.removedAt === undefined || t < r.removedAt)) {
        r.visible = true;
        this.#hooks.onSpawn?.(r.obj);
      }
      if (r.removedAt !== undefined && t >= r.removedAt) {
        this.#remote.delete(r.id);
        r.values = r.buffer.read(r.removedAt); // its final state, for the remove handler
        r.readAt = Number.POSITIVE_INFINITY;
        if (r.visible) this.#hooks.onRemove?.(r.obj, r.reason ?? 'removed');
      }
    }
    return t;
  }

  /** Remote values are read lazily, once per frame, at the render time. */
  #refresh(r: Remote): void {
    if (r.readAt === Number.POSITIVE_INFINITY) return;
    const t = this.#advance();
    if (r.readAt === t || r.readAt === Number.POSITIVE_INFINITY) return;
    r.values = r.buffer.read(t);
    r.readAt = t;
  }

  #removeLocal(rec: Local): void {
    if (rec.removed) return;
    rec.removed = true;
    this.#hooks.onRemove?.(rec.obj, 'removed');
  }

  /**
   * A write that can't be applied: warn once per key and skip it. Throwing would repeat every frame
   * inside a game loop and stop the rest of it (the eval's most common failure).
   */
  #skip(key: string, message: string): void {
    this.#hooks.warn?.('write', key, `${message} (this write was skipped; the rest of your code keeps running)`);
  }

  #info(id: PlayerId): PlayerInfo {
    return this.#t.player(id) ?? { id, name: '', avatar: null, joinedAt: 0, connected: false, slot: -1 };
  }

  #ownerInfo(host: boolean, owner: PlayerId): PlayerInfo {
    return this.#info(host ? (this.#t.hostId?.() ?? owner) : owner);
  }

  /** A record we write. `from` (a remote being taken over) keeps its object and slot. */
  #makeLocal(id: string, schema: KindSchema, values: unknown[], host: boolean, now: number, from?: Remote): Local {
    const rec: Local = {
      id,
      schema,
      values,
      sent: [],
      spawned: true,
      teleport: false,
      removed: false,
      nextSend: now,
      nextKey: now,
      moved: false,
      writtenAt: now,
      writeGap: 0,
      unsent: false,
      host,
      leaveHost: false,
      slot: from?.slot ?? (undefined as unknown as Slot),
      obj: from?.obj ?? (undefined as unknown as Entity),
    };
    const slot: Partial<Slot> = rec.slot ?? {};
    Object.assign(slot, {
      rec,
      mine: () => true,
      owner: () => this.#ownerInfo(host, this.#t.me),
      write: (i: number, v: unknown) => {
        if (rec.removed) return this.#skip(`write:${schema.kind}:removed`, `${rec.id} was removed; spawn a new one`);
        try {
          checkValue(schema.kind, schema.fields[i]!, v);
        } catch (err) {
          return this.#skip(`write:${schema.kind}:${schema.fields[i]!.name}`, (err as Error).message);
        }
        if (rec.values[i] !== v) {
          const now = this.#t.writeTime?.() ?? this.#t.now();
          const gap = now - rec.writtenAt;
          // Writes in one simulation step land together; the gap between steps is what we learn.
          if (gap > 2 && gap < KEYFRAME_MS) rec.writeGap = rec.writeGap === 0 ? gap : rec.writeGap * 0.8 + gap * 0.2;
          rec.writtenAt = now;
          rec.unsent = true;
        }
        rec.values[i] = v;
      },
      teleport: () => {
        rec.teleport = true;
      },
      remove: () => this.#removeLocal(rec),
      refresh: () => {},
    } satisfies Slot);
    rec.slot = slot as Slot;
    rec.obj ??= this.#entity(rec.slot);
    return rec;
  }

  /** A record someone else writes, seeded with one sample when it was ours (`from`). */
  #makeRemote(
    id: string,
    schema: KindSchema,
    owner: PlayerId,
    t: number,
    host: boolean,
    from?: { values: unknown[]; slot: Slot; obj: Entity },
    buffer?: SampleBuffer,
  ): Remote {
    const r: Remote = {
      id,
      schema,
      owner,
      buffer:
        buffer ??
        new SampleBuffer(
          schema.fields.map((f) => ({ kind: bufferKind(f.type), smooth: f.smooth })),
          { jumpFields: schema.fields.map((f) => POSITION_FIELDS.has(f.name)) },
        ),
      values: from ? from.values.slice() : [],
      firstAt: t,
      visible: from !== undefined,
      lastSeen: this.#t.now(),
      readAt: Number.NaN,
      host,
      leaveHost: false,
      slot: from?.slot ?? (undefined as unknown as Slot),
      obj: from?.obj ?? (undefined as unknown as Entity),
    };
    if (from && !buffer) r.buffer.push(t, from.values);
    const refuse = () => {
      this.#skip(
        `write:${schema.kind}:owner`,
        host
          ? `${id} belongs to the host; only the host can change it. Update in a loop over .mine() on the '${schema.kind}' handle (the ones you write), not .all(); or ask the host: room.emit('…', data, { to: 'host' })`
          : `${id} belongs to ${this.#info(owner).name || owner}; only its owner can change it. Update in a loop over .mine() on the '${schema.kind}' handle (the ones you write), not .all(); or send them a message: room.emit('…', data, { to: entity.owner.id })`,
      );
    };
    const slot: Partial<Slot> = r.slot ?? {};
    Object.assign(slot, {
      rec: r,
      mine: () => false,
      owner: () => this.#ownerInfo(host, owner),
      write: refuse,
      teleport: refuse,
      remove: refuse,
      refresh: () => this.#refresh(r),
    } satisfies Slot);
    r.slot = slot as Slot;
    r.obj ??= this.#entity(r.slot);
    return r;
  }

  /** The object games hold. Everything goes through its slot, so a handover swaps behaviour in place. */
  #entity(slot: Slot): Entity {
    const { id, schema } = slot.rec;
    const kind = schema.kind;
    const fixed: Record<string, unknown> = { id, kind, teleport: () => slot.teleport(), remove: () => slot.remove() };
    const read = (key: string): unknown => {
      const i = schema.index.get(key);
      if (i !== undefined) {
        slot.refresh();
        return slot.rec.values[i];
      }
      if (key === 'owner') return slot.owner();
      if (key === 'mine') return slot.mine();
      return fixed[key];
    };
    const keys = ['id', 'kind', 'owner', 'mine', ...schema.fields.map((f) => f.name)];
    return new Proxy(fixed, {
      get: (target, key) => (typeof key === 'string' ? read(key) : Reflect.get(target, key)),
      set: (_target, key, value) => {
        const i = typeof key === 'string' ? schema.index.get(key) : undefined;
        if (i !== undefined) {
          slot.write(i, value);
          return true;
        }
        this.#skip(
          `write:${kind}:${String(key)}`,
          typeof key === 'string' && (key in fixed || key === 'owner' || key === 'mine') ? `${kind}.${key} is read-only` : unknownField(kind, String(key)),
        );
        return true; // (false would throw a TypeError in strict mode)
      },
      defineProperty: () => {
        throw bad(`${kind} entities can't take new properties; add fields to room.define('${kind}', { … })`);
      },
      deleteProperty: () => {
        throw bad(`${kind} fields can't be deleted`);
      },
      has: (_target, key) => typeof key === 'string' && (keys.includes(key) || key in fixed),
      ownKeys: () => keys,
      getOwnPropertyDescriptor: (_target, key) =>
        typeof key === 'string' && keys.includes(key) ? { value: read(key), enumerable: true, configurable: true, writable: false } : undefined,
    }) as unknown as Entity;
  }
}

/** Levenshtein distance, for "did you mean" (short names only). */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}
