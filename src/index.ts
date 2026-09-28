/**
 * @gamerelay/sdk: multiplayer for browser games. Zero dependencies.
 * Guide: https://gamerelay.io/llms.txt
 */
import { LIMITS } from '@gamerelay/protocol/limits';
import { normalizeChat } from '@gamerelay/protocol/chat';
import { signFrame, unmaskKey, type FrameKey } from '@gamerelay/protocol/sign';
import { attempt, safeStorage } from '@gamerelay/protocol/util';
import {
  PLAN_FEATURES,
  PROTOCOL_VERSION as V,
  type ChatMessage,
  type ErrorCode,
  type Json,
  type JsonObject,
  type LeaderboardEntry,
  type LeaderboardOrder,
  type LeaderboardPage,
  type LeaderboardSubmitResult,
  type LeaveReason,
  type PartyInfo,
  type PlanFeatures,
  type PlayerId,
  type RoomListing,
  type PlayerInfo,
  type RoomClientMessage,
  type RoomInfo,
  type ServerMessage,
} from '@gamerelay/protocol/types';
import { GameRelayError } from './errors';
import { Ticker, pickScheduler } from './core/ticker';
import type { FieldInput } from './core/codec';
import { mountOverlay, type OverlayStats } from './debug/overlay';
import { Rate, looksPositional } from './debug/rate';
import { Warnings, type Warn, type WarningKind } from './debug/warnings';
import { createIdAllocator } from './core/ids';
import { EntityStore, type DefineOptions, type Entity, type RemoveReason, type SpawnOptions } from './sync/entities';
import { Claims } from './sync/claims';
import { makeKind, type Kind } from './sync/kind';
import { HostHealth } from './sync/host';
import { Inputs } from './sync/inputs';
import { Messages } from './sync/messages';
import { RequestRejection, Requests } from './sync/requests';
import { TEAMS_KEY, TEAM_COUNT_KEY, balanceTeams } from './sync/teams';
import { Timers } from './sync/timers';
import type { SyncTransport } from './sync/transport';

export { GameRelayError };
export type { Entity, EntityBase, RemoveReason, DefineOptions, SpawnOptions } from './sync/entities';
export type { Kind, KindEntity, FieldValues } from './sync/kind';
export type { FieldInput, FieldType } from './core/codec';
export type { RequestRejection } from './sync/requests';

export type {
  ChatMessage,
  Json,
  JsonObject,
  PlayerId,
  PlayerInfo,
  ErrorCode,
  PartyInfo,
  PlanFeatures,
  RoomListing,
  LeaderboardEntry,
  LeaderboardOrder,
  LeaderboardPage,
  LeaderboardSubmitResult,
};

export interface ConnectOptions {
  /** Your instance's public key (`gr_pub_…`). Required unless `getToken` is given. */
  publicKey?: string;
  playerName?: string;
  /**
   * Anonymous players only: a short id or emoji (≤32 chars, no URLs) that your game maps to
   * its own art. Players signed in through your backend get their avatar from the token.
   */
  playerAvatar?: string;
  /** Server origin. Defaults to the origin the SDK script was loaded from, else https://gamerelay.io */
  url?: string;
  /** Supply tokens minted by your own backend (secret key) instead of anonymous ones. */
  getToken?: () => Promise<string>;
  /**
   * Development only: simulate a bad network. `latency` is extra round-trip ms (half each way),
   * `jitter` ± ms per message (order is kept, as on a real socket), `loss` the share (0–1) of
   * `reliable: false` sends dropped. Remove it before you ship.
   */
  simulate?: NetworkSimulation;
  /** Show a small overlay (ping, smoothing, traffic, entities, warnings). For development. */
  debug?: boolean;
}

export interface NetworkSimulation {
  latency?: number;
  jitter?: number;
  loss?: number;
}

export interface RoomOptions {
  maxPlayers?: number;
  /** Matchmaking pool, e.g. a game mode. Quick match only pairs rooms with the same tag. */
  tag?: string;
}

export interface SendOptions {
  /** Send to one player only. */
  to?: PlayerId;
  /** `false` = may be dropped under load (good for positions). Default true. */
  reliable?: boolean;
}


type Handler = (...args: never[]) => void;

const ROOM_EVENTS = new Set<string>([
  'message',
  'seed',
  'player_joined',
  'player_left',
  'player_disconnected',
  'player_reconnected',
  'host_changed',
  'state',
  'chat',
  'closed',
  'claimed',
  'released',
]);
/** Names models guess for built-in room events: listening to one is legal, but only room.emit fires it. */
const EVENT_ALIASES: Record<string, string> = {
  playerJoined: 'player_joined', playerJoin: 'player_joined', player_join: 'player_joined', join: 'player_joined', joined: 'player_joined',
  playerLeft: 'player_left', playerLeave: 'player_left', player_leave: 'player_left', leave: 'player_left', left: 'player_left',
  hostChanged: 'host_changed', host_change: 'host_changed', newHost: 'host_changed',
  stateChanged: 'state', state_changed: 'state', stateChange: 'state',
  playerDisconnected: 'player_disconnected', playerReconnected: 'player_reconnected',
};
const ALIAS_WHAT: Record<string, string> = {
  player_joined: 'a player arriving',
  player_left: 'a player leaving',
  host_changed: 'a new host',
  state: 'a state change',
  player_disconnected: 'a player dropping',
  player_reconnected: 'a player coming back',
};
type CustomHandler = (data: Json, from: PlayerId, meta: MessageMeta) => void;
type EntityHandler = (entity: Entity, reason: RemoveReason) => void;

class Emitter<Events extends Record<string, Handler>> {
  #handlers: { [K in keyof Events]?: Set<Events[K]> } = {};

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof Events>(event: K, handler: Events[K]): () => void {
    (this.#handlers[event] ??= new Set()).add(handler);
    return () => this.off(event, handler);
  }
  off<K extends keyof Events>(event: K, handler: Events[K]): void {
    this.#handlers[event]?.delete(handler);
  }
  protected fire<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const h of this.#handlers[event] ?? []) {
      try {
        (h as (...a: Parameters<Events[K]>) => void)(...args);
      } catch (err) {
        console.error('[gamerelay] listener error', err);
      }
    }
  }
}

export type RelayEvents = {
  /** Connection dropped; reconnecting automatically. */
  disconnected: () => void;
  /** Reconnected (and back in your room, if you had one). */
  reconnected: () => void;
  /** Server is restarting; you will be reconnected. */
  server_restarting: () => void;
  /** Another tab/device connected as this player; this one stopped. */
  replaced: () => void;
  /** Errors not tied to a request (e.g. setState when not host). */
  error: (error: GameRelayError) => void;
  /** Your party changed (`null` = not in a party any more). */
  party: (party: PartyInfo | null) => void;
  /** Your party leader moved you into a room. */
  room: (room: Room) => void;
};

export type CloseReason = 'left' | 'lost' | 'kicked' | 'closed';

/** Extra facts about a relayed message. */
export interface MessageMeta {
  /** When the server received it, on the server's clock: compare with `relay.now()`. */
  at: number;
}

export type RoomEvents = {
  message: (data: Json, from: PlayerId, meta: MessageMeta) => void;
  /** The host started a new round with a fresh `room.seed` (you included). */
  seed: (seed: number, from: PlayerId) => void;
  player_joined: (player: PlayerInfo) => void;
  player_left: (playerId: PlayerId, reason: LeaveReason) => void;
  player_disconnected: (playerId: PlayerId) => void;
  player_reconnected: (playerId: PlayerId) => void;
  host_changed: (hostId: PlayerId, previousHostId: PlayerId) => void;
  state: (state: JsonObject, patch: JsonObject, from: PlayerId) => void;
  /** A chat line from anyone in the room, including you. */
  chat: (message: ChatMessage) => void;
  /**
   * You're out of the room: you left, it was lost while reconnecting, you were kicked by the
   * game's owner, or the owner closed it. `message` is the moderator's note, if any.
   */
  closed: (reason: CloseReason, message?: string) => void;
  /** Someone took a claim (`room.claim`): you included. */
  claimed: (key: string, playerId: PlayerId) => void;
  /** A claim is free again: released, or its holder left. */
  released: (key: string, playerId: PlayerId) => void;
};

interface Pending {
  resolve: (data: Json | undefined) => void;
  reject: (err: GameRelayError) => void;
}

type Outgoing = { [K in RoomClientMessage['t']]: Omit<Extract<RoomClientMessage, { t: K }>, 'v'> }[RoomClientMessage['t']];
type Request = { t: string; [key: string]: Json | undefined };

const MAX_BATCH = 64;
/** Stay under the server's 16 KB message limit, with room for the batch wrapper and signature. */
const MAX_FRAME_BYTES = 15_000;
const utf8 = new TextEncoder();
const MAX_QUEUED = 256;
const DEFAULT_URL = 'https://gamerelay.io';
let defaultUrl = DEFAULT_URL;

/** @internal Used by the `<script>` build to default to the origin it was loaded from. */
export function setDefaultUrl(url: string): void {
  defaultUrl = url;
}

/** Delays callbacks by half the simulated latency ± jitter, never reordering them. */
function lane({ latency = 0, jitter = 0 }: NetworkSimulation): (fn: () => void) => void {
  let at = 0;
  return (fn) => {
    const now = Date.now();
    at = Math.max(at, now + latency / 2 + (Math.random() * 2 - 1) * jitter);
    setTimeout(fn, at - now);
  };
}

/**
 * Sends are batched into one frame, but never wait on a frame that won't come: background tabs
 * pause requestAnimationFrame, so a hidden tab flushes right away and a timer backs up the frame
 * (the tab may be hidden after the frame was requested).
 */
function nextFrame(cb: () => void): void {
  if (typeof requestAnimationFrame !== 'function') return void setTimeout(cb, 0);
  if (typeof document !== 'undefined' && document.hidden) return queueMicrotask(cb);
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cb();
  };
  requestAnimationFrame(run);
  setTimeout(run, 100);
}

/** Invite links carry the room code in this query parameter: `?room=CODE`. */
const INVITE_PARAM = 'room';

function pageUrl(): string {
  if (typeof location === 'undefined') throw new Error('[gamerelay] No page URL here; pass one');
  return location.href;
}

/** Anonymous tokens, per tab, so a reload resumes the same player. */
const session = safeStorage('session');

export class GameRelay extends Emitter<RelayEvents> {
  /** Your player id (stable across reloads of the same tab for anonymous players). */
  playerId = '';
  /** The room you are in, if any. */
  room: Room | null = null;
  /** Your party, if any. When its leader enters a room, every member follows. */
  party: PartyInfo | null = null;
  /**
   * What this game's plan includes, from the server when you connect (all off until then). For
   * features that need a paid plan, such as voice chat, once they ship.
   */
  features = Object.fromEntries(PLAN_FEATURES.map((f) => [f, false])) as unknown as PlanFeatures;

  /** Per-player persisted key/value data. */
  readonly storage = {
    get: <T extends Json = Json>(key: string): Promise<T | null> =>
      this.request({ t: 'kv_get', key }).then((d) => (d ?? null) as T | null),
    set: (key: string, value: Json): Promise<void> => this.request({ t: 'kv_set', key, value }).then(() => undefined),
  };

  /** Per-game high score boards. Each player keeps their best score per board. */
  readonly leaderboard = {
    /** `order` is fixed by a board's first submit: `desc` (default) for points, `asc` for times. */
    submit: (board: string, score: number, options: { order?: LeaderboardOrder } = {}): Promise<LeaderboardSubmitResult> =>
      this.request({ t: 'lb_submit', board, score, order: options.order }).then((d) => d as LeaderboardSubmitResult),
    top: (board: string, options: { limit?: number } = {}): Promise<LeaderboardPage> =>
      this.request({ t: 'lb_top', board, limit: options.limit }).then((d) => d as LeaderboardPage),
  };

  #ws: WebSocket | null = null;
  /** This connection's frame key and sequence (signed frames); private so the console can't read it. */
  #frameKey: FrameKey | null = null;
  #frameSeq = 0;
  /** Recent clock samples; the one with the shortest round trip is the most accurate. */
  #clock: { offset: number; rtt: number }[] = [];
  #clockOffset = 0;
  readonly #opts: ConnectOptions;
  readonly #base: string;
  #token: { value: string; expiresAt: number } | null = null;
  #rid = 0;
  readonly #pending = new Map<number, Pending>();
  #outbox: Outgoing[] = [];
  #flushScheduled = false;
  #attempts = 0;
  #reconnectHintMs: number | null = null;
  #stopped = false;
  /** Between reconnecting and re-entering the room: room messages must wait. */
  #resuming = false;
  #lastRoomInfo: RoomInfo | null = null;
  /** Network simulation (`simulate`): outbound and inbound delay lanes. */
  readonly #out?: (fn: () => void) => void;
  readonly #in?: (fn: () => void) => void;
  readonly #ticker: Ticker;
  readonly #warnings = new Warnings();
  readonly #stats = { msgsIn: 0, msgsOut: 0, bytesIn: 0, bytesOut: 0 };
  #lastRtt: number | null = null;
  #unmountOverlay: (() => void) | null = null;
  #debugPing: ReturnType<typeof setInterval> | null = null;
  /** Entity ids: one session per connection, so another client (or a reload) never collides. */
  readonly #ids = createIdAllocator();

  private constructor(opts: ConnectOptions) {
    super();
    this.#opts = opts;
    this.#base = (opts.url ?? defaultUrl).replace(/\/$/, '');
    if (!opts.publicKey && !opts.getToken) throw new Error('GameRelay.connect needs publicKey or getToken');
    if (opts.simulate) {
      console.warn('[gamerelay] simulating a bad network', opts.simulate);
      this.#out = lane(opts.simulate);
      this.#in = lane(opts.simulate);
    }
    this.#ticker = new Ticker({
      schedule: pickScheduler(() =>
        this.warn('worker', 'worker', "tick loop fell back to setInterval (a worker was blocked by the page's security settings); hidden tabs will tick slowly"),
      ),
    });
  }

  static async connect(options: ConnectOptions): Promise<GameRelay> {
    const relay = new GameRelay(options);
    await relay.#open();
    if (options.debug) relay.#startDebug();
    return relay;
  }

  get connected(): boolean {
    return this.#ws?.readyState === 1 && this.#frameKey !== null;
  }

  createRoom(options: RoomOptions & { public?: boolean } = {}): Promise<Room> {
    return this.#enter({ t: 'create_room', maxPlayers: options.maxPlayers, public: options.public, tag: options.tag });
  }
  joinRoom(code: string): Promise<Room> {
    return this.#enter({ t: 'join_room', code: code.trim().toUpperCase() });
  }
  /**
   * Join the room in an invite link (`?room=CODE`, from `room.inviteUrl()`), or resolve `null` if
   * the page has none. Rejects like `joinRoom` when the room is gone or full.
   */
  async joinInvite(url?: string): Promise<Room | null> {
    const code = new URL(url ?? pageUrl()).searchParams.get(INVITE_PARAM)?.trim();
    return code ? this.joinRoom(code) : null;
  }
  /** Join the oldest open public room, or create one. */
  quickMatch(options: RoomOptions = {}): Promise<Room> {
    return this.#enter({ t: 'quick_match', maxPlayers: options.maxPlayers, tag: options.tag });
  }

  /** Public rooms with free seats, oldest first. */
  async listRooms(tag?: string): Promise<RoomListing[]> {
    return ((await this.request({ t: 'list_rooms', tag })) ?? []) as RoomListing[];
  }

  /** Start a party; share `party.code` with friends. */
  async createParty(): Promise<PartyInfo> {
    await this.request({ t: 'party_create' });
    return this.party as PartyInfo;
  }
  async joinParty(code: string): Promise<PartyInfo> {
    await this.request({ t: 'party_join', code: code.trim().toUpperCase() });
    return this.party as PartyInfo;
  }
  async leaveParty(): Promise<void> {
    await this.request({ t: 'party_leave' });
  }

  /** Round-trip time in ms. */
  async ping(): Promise<number> {
    const start = Date.now();
    // Pongs are matched by `ts`, so concurrent pings in the same millisecond need distinct ones.
    let ts = start;
    while (this.#pending.has(-ts)) ts++;
    const serverTime = await this.request({ t: 'ping', ts });
    const rtt = Date.now() - start;
    this.#lastRtt = rtt;
    if (typeof serverTime === 'number') this.#clockSample(serverTime - (start + rtt / 2), rtt);
    return rtt;
  }

  /**
   * The server's clock (ms since the epoch), estimated from pings: use it to place messages
   * (`meta.at`) and state on one shared timeline, e.g. to render others slightly in the past.
   */
  now(): number {
    return Date.now() + this.#clockOffset;
  }

  /**
   * Run `fn` at a fixed rate (1–240 per second) with a constant `dt` in seconds, on a timer that
   * keeps going in hidden tabs. Use it for game logic; keep drawing in requestAnimationFrame.
   * Returns a function that stops the loop.
   */
  tick(rate: number, fn: (dt: number, tick: number) => void): () => void {
    return this.#ticker.add(rate, fn);
  }

  /** @internal The server-clock moment of the running `tick` step (see `SyncTransport.writeTime`), else now. */
  writeTime(): number {
    const at = this.#ticker.stepTime();
    return at === null ? this.now() : this.now() - (performance.now() - at);
  }

  /** @internal */
  newEntityId(kind: string): string {
    return this.#ids(kind);
  }

  /** @internal Print a warning once per kind (and list it in the debug overlay). */
  warn(kind: WarningKind, key: string, message: string): void {
    this.#warnings.warn(kind, key, message);
  }

  #startDebug(): void {
    let last = { ...this.#stats, at: Date.now() };
    this.#unmountOverlay = mountOverlay((): OverlayStats => {
      const now = Date.now();
      const secs = Math.max(0.001, (now - last.at) / 1000);
      const rate = (k: 'msgsIn' | 'msgsOut' | 'bytesIn' | 'bytesOut') => Math.round((this.#stats[k] - last[k]) / secs);
      const info = this.room?.debugInfo() ?? { delayMs: 0, entities: {} };
      const stats: OverlayStats = {
        ping: this.#lastRtt,
        delayMs: info.delayMs,
        entities: info.entities,
        msgsIn: rate('msgsIn'),
        msgsOut: rate('msgsOut'),
        bytesIn: rate('bytesIn'),
        bytesOut: rate('bytesOut'),
        host: this.room?.isHost ?? false,
        warnings: this.#warnings.list(),
      };
      last = { ...this.#stats, at: now };
      return stats;
    });
    this.#debugPing = setInterval(() => void this.ping().catch(() => {}), 2000);
  }

  close(): void {
    this.#stopped = true;
    this.#ws?.close(1000);
    this.#ticker.stop();
    this.#unmountOverlay?.();
    if (this.#debugPing) clearInterval(this.#debugPing);
    this.#failPending();
  }

  // ---------------------------------------------------------------------------

  /** @internal */
  queue(message: Outgoing): void {
    this.#outbox.push(message);
    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      nextFrame(() => this.#flush());
    }
  }

  /** @internal */
  request(message: Request): Promise<Json | undefined> {
    if (!this.connected) return Promise.reject(new GameRelayError('disconnected', 'Not connected'));
    if (!this.#resuming) this.#flush();
    const rid = ++this.#rid;
    // `ping` correlates by `ts`, everything else by `rid`.
    return new Promise((resolve, reject) => {
      this.#pending.set(message.t === 'ping' ? -Number(message.ts) : rid, { resolve, reject });
      this.#raw({ ...message, v: V, rid });
    });
  }

  #clockSample(offset: number, rtt: number): void {
    this.#clock = [...this.#clock, { offset, rtt }].slice(-8);
    this.#clockOffset = this.#clock.reduce((best, c) => (c.rtt < best.rtt ? c : best)).offset;
  }

  async #enter(message: Request): Promise<Room> {
    const data = await this.request(message);
    const info = this.#lastRoomInfo;
    if (!info || typeof data !== 'object' || data === null || Array.isArray(data) || info.id !== data.roomId) {
      throw new GameRelayError('internal', 'Room snapshot missing');
    }
    const old = this.room;
    // Leaving a room closes it; re-entering the same one replaces the object, so stop the old one's loop.
    if (old && old.id !== info.id) old.closeLocal('left');
    else old?.dispose();
    this.room = new Room(this, info, this.playerId);
    return this.room;
  }

  #flush(): void {
    this.#flushScheduled = false;
    if (!this.connected || this.#resuming) {
      // Keep reliable messages for after the reconnect; drop the rest.
      this.#outbox = this.#outbox.filter((m) => !(m.t === 'send' && m.r === false)).slice(-MAX_QUEUED);
      return;
    }
    const loss = this.#opts.simulate?.loss ?? 0;
    const items = this.#outbox.filter((m) => !(loss && m.t === 'send' && m.r === false && Math.random() < loss));
    this.#outbox = [];
    // Batch by count and by size: the server rejects frames over its message limit.
    let chunk: unknown[] = [];
    let size = 0;
    const send = () => {
      if (chunk.length > 0) this.#raw(chunk.length === 1 ? chunk[0] : { v: V, t: 'batch', m: chunk });
      chunk = [];
      size = 0;
    };
    for (const m of items) {
      const item = { ...m, v: V };
      const n = utf8.encode(JSON.stringify(item)).byteLength + 1;
      if (chunk.length >= MAX_BATCH || (chunk.length > 0 && size + n > MAX_FRAME_BYTES)) send();
      chunk.push(item);
      size += n;
    }
    send();
  }

  #raw(message: unknown): void {
    const ws = this.#ws;
    if (!ws || !this.#frameKey) return;
    const frame = signFrame(this.#frameKey, ++this.#frameSeq, JSON.stringify(message));
    this.#stats.msgsOut++;
    this.#stats.bytesOut += frame.length;
    if (this.#out) this.#out(() => ws.readyState === 1 && ws.send(frame));
    else ws.send(frame);
  }

  async #getToken(): Promise<string> {
    if (this.#opts.getToken) return this.#opts.getToken();
    if (this.#token && this.#token.expiresAt - Date.now() > 60_000) return this.#token.value;
    const storeKey = `gamerelay:${this.#opts.publicKey}`;
    const res = await fetch(`${this.#base}/v1/auth/anonymous`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicKey: this.#opts.publicKey,
        playerName: this.#opts.playerName,
        playerAvatar: this.#opts.playerAvatar,
        previousToken: this.#token?.value ?? session.get(storeKey) ?? undefined,
      }),
    });
    // A proxy error page isn't JSON: treat it like any other failed response.
    const body: { token?: string; expiresAt?: number; error?: string; message?: string } = await res.json().catch(() => ({}));
    if (!res.ok || !body.token || !body.expiresAt) {
      const code = body.error === 'at_capacity' || body.error === 'quota_exceeded' ? body.error : res.status === 429 ? 'rate_limited' : 'unauthorized';
      throw new GameRelayError(code, body.message ?? 'Auth failed');
    }
    this.#token = { value: body.token, expiresAt: body.expiresAt };
    session.set(storeKey, body.token);
    return body.token;
  }

  async #open(): Promise<void> {
    const token = await this.#getToken();
    // close() may have been called while a reconnect waited on the token.
    if (this.#stopped) throw new GameRelayError('disconnected', 'Closed');
    const url = `${this.#base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, 'gamerelay.v1.json');
      this.#ws = ws;
      this.#frameKey = null;
      this.#frameSeq = 0;
      let welcomed = false;
      const receive = (ev: MessageEvent) => {
        // (A delayed message can arrive after its socket was replaced.)
        if (this.#ws !== ws) return;
        this.#stats.msgsIn++;
        this.#stats.bytesIn += String(ev.data).length;
        const msg = attempt(() => JSON.parse(String(ev.data)) as ServerMessage | null);
        if (!msg) return;
        if (msg.t === 'welcome') {
          welcomed = true;
          this.playerId = msg.playerId;
          // An older server sends no features: everything stays off.
          if (msg.features) this.features = { ...this.features, ...msg.features };
          this.#frameKey = unmaskKey(msg.k, msg.playerId);
          // A rough clock until the pings below (and any the game sends) refine it.
          if (this.#clock.length === 0) this.#clockOffset = msg.serverTime - Date.now();
          resolve();
          for (const delay of [0, 1_000, 3_000]) setTimeout(() => void this.ping().catch(() => {}), delay);
        }
        this.#handle(msg);
      };
      ws.onmessage = (ev) => (this.#in ? this.#in(() => receive(ev)) : receive(ev));
      ws.onclose = (ev) => {
        if (this.#ws !== ws) return;
        this.#ws = null;
        if (!welcomed) {
          this.#token = null; // maybe expired/revoked: mint a fresh one next time
          reject(new GameRelayError('disconnected', `Connection failed (${ev.code})`));
          return;
        }
        this.#onDisconnect(ev.code);
      };
    });
  }

  #onDisconnect(code: number): void {
    this.#failPending();
    if (this.#stopped) return;
    if (code === 4001) {
      this.#stopped = true;
      this.fire('replaced');
      return;
    }
    this.fire('disconnected');
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const backoff = Math.min(10_000, 250 * 2 ** this.#attempts) * (0.5 + Math.random() / 2);
    const delay = this.#reconnectHintMs ?? backoff;
    this.#reconnectHintMs = null;
    this.#attempts++;
    setTimeout(() => void this.#reconnect(), delay);
  }

  async #reconnect(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#open();
    } catch {
      return this.#scheduleReconnect();
    }
    this.#attempts = 0;
    // Hold queued room messages until we are back in the party and room.
    this.#resuming = true;
    // A 'disconnected' failure means the connection dropped again: keep the party and room for the
    // next attempt instead of treating them as gone.
    const gone = (err: GameRelayError) => err.code !== 'disconnected';
    try {
      const party = this.party;
      if (party) await this.request({ t: 'party_join', code: party.code }).catch((err) => gone(err) && this.#setParty(null));
      const room = this.room;
      if (room) {
        await this.request({ t: 'join_room', code: room.code }).catch((err) => {
          if (!gone(err)) return;
          if (this.room === room) this.room = null;
          room.closeLocal('lost');
        });
      }
    } finally {
      this.#resuming = false;
    }
    if (!this.connected) return; // dropped mid-resume; the scheduled reconnect takes over
    this.#flush();
    this.fire('reconnected');
  }

  #setParty(party: PartyInfo | null): void {
    this.party = party;
    this.fire('party', party);
  }

  #failPending(): void {
    for (const p of this.#pending.values()) p.reject(new GameRelayError('disconnected', 'Connection lost'));
    this.#pending.clear();
  }

  #settle(key: number, fn: (p: Pending) => void): boolean {
    const p = this.#pending.get(key);
    if (!p) return false;
    this.#pending.delete(key);
    fn(p);
    return true;
  }

  #handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'batch':
        for (const m of msg.m) this.#handle(m);
        return;
      case 'welcome':
        return;
      case 'reply':
        this.#settle(msg.rid, (p) => p.resolve(msg.data));
        return;
      case 'pong':
        this.#settle(-msg.ts, (p) => p.resolve(msg.serverTime));
        return;
      case 'error': {
        const err = new GameRelayError(msg.code, msg.message);
        if (msg.code === 'rate_limited') {
          this.warn('rate_limited', 'rate_limited', 'the server dropped messages: this player sent more than 120 per second; send less often (check emit and setState rates)');
        }
        if (msg.rid === undefined || !this.#settle(msg.rid, (p) => p.reject(err))) this.fire('error', err);
        return;
      }
      case 'server_restarting':
        this.#reconnectHintMs = msg.reconnectInMs;
        this.fire('server_restarting');
        return;
      case 'room':
        this.#lastRoomInfo = msg.room;
        if (this.room?.id === msg.room.id) this.room.sync(msg.room);
        return;
      case 'party':
        return this.#setParty(msg.party);
      case 'removed': {
        // Kicked or closed by the owner: forget the room so a reconnect doesn't try to rejoin it.
        const room = this.room;
        if (!room || room.id !== msg.roomId) return;
        this.room = null;
        room.closeLocal(msg.reason, msg.message);
        return;
      }
      case 'party_room': {
        const info = this.#lastRoomInfo;
        if (!info || info.id !== msg.roomId) return;
        this.room?.closeLocal('left');
        this.room = new Room(this, info, this.playerId);
        this.fire('room', this.room);
        return;
      }
      default:
        this.room?.handle(msg);
    }
  }
}

export class Room extends Emitter<RoomEvents> {
  readonly id: string;
  readonly code: string;
  readonly maxPlayers: number;
  hostId: PlayerId;
  players: PlayerInfo[];
  state: JsonObject;
  /** Recent chat, oldest first (the last 20 when you joined, then everything you receive, capped). */
  chatHistory: ChatMessage[];
  /**
   * A random 32-bit seed the server picked for this room, the same for everyone. Use it for dice,
   * shuffles and spawns (`seededRandom(room.seed)`) so the host can't reroll until it wins.
   */
  seed: number;

  readonly #relay: GameRelay;
  readonly #entities: EntityStore;
  readonly #messages: Messages;
  readonly #custom = new Map<string, Set<CustomHandler>>();
  readonly #spawnHandlers = new Map<string, Set<EntityHandler>>();
  readonly #removeHandlers = new Map<string, Set<EntityHandler>>();
  readonly #timerHandlers = new Map<string, Set<() => void>>();
  readonly #health: HostHealth;
  readonly #timers: Timers;
  readonly #claims: Claims;
  readonly #requests: Requests;
  readonly #inputs: Inputs;
  readonly #inputsView: { get(playerId: PlayerId): Readonly<Record<string, Json>> };
  readonly #stopLoop: () => void;
  #unwatchVisibility: () => void = () => {};
  #batchPatch: JsonObject | null = null;
  readonly #stateRate = new Rate(10);
  #batchCounted = false;
  readonly #sendRate = new Rate(20);
  /** False once this room object was left, closed or replaced: kind handles then throw. */
  #live = true;

  /** @internal */
  constructor(
    relay: GameRelay,
    info: RoomInfo,
    /** Your player id. */
    readonly me: PlayerId,
  ) {
    super();
    this.#relay = relay;
    this.id = info.id;
    this.code = info.code;
    this.maxPlayers = info.maxPlayers;
    this.hostId = info.hostId;
    this.players = info.players;
    this.state = info.state;
    this.chatHistory = info.chat ?? [];
    this.seed = info.seed;
    const transport: SyncTransport = {
      me,
      // `h` (host-only) lets the server drop a replaced host's late writes, timer effects included.
      send: (data, o) =>
        relay.queue({ t: 'send', d: data, to: o.to, r: o.reliable ? undefined : false, h: o.host || this.#timers.firing ? true : undefined }),
      now: () => relay.now(),
      writeTime: () => relay.writeTime(),
      player: (id) => this.players.find((p) => p.id === id),
      hostId: () => this.hostId,
      ready: () => relay.connected,
    };
    const warn: Warn = (kind, key, message) => relay.warn(kind, key, message);
    this.#entities = new EntityStore(transport, {
      onSpawn: (e) => this.#fireEntity(this.#spawnHandlers, e),
      onRemove: (e, reason) => this.#fireEntity(this.#removeHandlers, e, reason),
      warn,
    }, (kind) => relay.newEntityId(kind));
    this.#messages = new Messages(transport, (type, data, from, meta) => this.#fireCustom(type, data, from, meta), warn);
    this.#health = new HostHealth({
      now: () => performance.now(),
      isHost: () => this.isHost,
      ready: () => relay.connected,
      send: (m) => relay.queue(m),
    });
    this.#timers = new Timers({
      ready: () => relay.connected,
      batch: (fn) => this.#batchState(fn),
      now: () => relay.now(),
      isHost: () => this.isHost,
      state: () => this.state,
      setState: (patch) => this.#writeState(patch),
      fire: (name) => this.#fireTimer(name),
    });
    this.#claims = new Claims({
      me,
      isHost: () => this.isHost,
      queue: (m) => relay.queue(m),
      fire: (event, key, playerId) => this.fire(event, key, playerId),
      warn,
    });
    this.#claims.sync(info.claims);
    this.#requests = new Requests(transport, warn);
    this.#inputs = new Inputs(transport);
    this.#inputsView = Object.freeze({ get: (playerId: PlayerId) => this.#inputs.get(playerId) });
    this.#stopLoop = relay.tick(60, () => {
      this.#entities.tick();
      this.#health.tick();
      this.#timers.tick();
      this.#requests.tick();
      this.#inputs.tick();
    });
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const report = () => this.#health.visibility(document.hidden);
      document.addEventListener('visibilitychange', report);
      this.#unwatchVisibility = () => document.removeEventListener('visibilitychange', report);
      report();
    }
  }

  /** True if you run the simulation. Re-check on `host_changed`. */
  get isHost(): boolean {
    return this.hostId === this.me;
  }

  /** This page's URL with `?room=CODE`. A friend who opens it gets in with `relay.joinInvite()`. */
  inviteUrl(base?: string): string {
    const url = new URL(base ?? pageUrl());
    url.searchParams.set(INVITE_PARAM, this.code);
    return url.href;
  }

  /**
   * Share the invite link: the share sheet on phones, the clipboard elsewhere. Resolves with what
   * happened (`'cancelled'` if the player closed the share sheet).
   */
  async shareInvite(text = 'Join my game'): Promise<'shared' | 'copied' | 'cancelled'> {
    const url = this.inviteUrl();
    if (typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: document.title, text, url });
        return 'shared';
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
        // Share refused (no user gesture, permissions): copy instead.
      }
    }
    await navigator.clipboard.writeText(url);
    return 'copied';
  }

  /** Relay any JSON value to everyone else, or to one player with `{ to }`. */
  send(data: Json, options: SendOptions = {}): void {
    const h = this.#timers.firing ? true : undefined; // a timer's effects: dropped if we're no longer the host
    if (looksPositional(data) && this.#sendRate.hit(this.#relay.now())) {
      this.#relay.warn('send_positions', 'send_positions', "room.send() of x/y more than 20×/s: you're hand-writing sync; use entities (room.define(kind, fields), then its .spawn()) and the SDK smooths it, sends it to late joiners and cleans up after players who leave");
    }
    this.#relay.queue({ t: 'send', d: data, to: options.to, r: options.reliable === false ? false : undefined, h });
  }

  /** Host only. Shallow-merges `patch` into the shared, persisted room state (`null` deletes a key). */
  setState(patch: JsonObject): void {
    if (!this.isHost) throw new GameRelayError('not_host', 'Only the host can set state');
    // Only the game's own calls count toward the rate warning; timers and teams write state too.
    if (this.#batchPatch) this.#batchCounted = true;
    else this.#countState();
    this.#writeState(patch);
  }

  /** Apply and send a state patch (or add it to the running batch). The SDK's own writes use this. */
  #writeState(patch: JsonObject): void {
    if (!this.isHost) throw new GameRelayError('not_host', 'Only the host can set state');
    this.state = applyPatch(this.state, patch);
    if (this.#batchPatch) Object.assign(this.#batchPatch, patch);
    else this.#relay.queue({ t: 'set_state', patch });
  }

  #countState(): void {
    if (this.#stateRate.hit(this.#relay.now())) {
      this.#relay.warn('set_state', 'set_state', 'room.setState() more than 10×/s: state is for facts (score, round, phase); for things that move use entities (room.define(kind, fields), then its .spawn())');
    }
  }

  /** Run `fn` with every `setState` inside sent as one patch (a timer's effects and its clear). */
  #batchState(fn: () => void): void {
    if (this.#batchPatch) return fn();
    this.#batchPatch = {};
    this.#batchCounted = false;
    try {
      fn();
    } finally {
      const patch = this.#batchPatch;
      this.#batchPatch = null;
      if (this.#batchCounted) this.#countState(); // the game's writes inside count once
      if (Object.keys(patch).length > 0) this.#relay.queue({ t: 'set_state', patch });
    }
  }

  /** Host only: ask the server for a new `room.seed` (a new round). Everyone gets a `seed` event. */
  reseed(): void {
    if (!this.isHost) throw new GameRelayError('not_host', 'Only the host can pick a new seed');
    this.#relay.queue({ t: 'reseed' });
  }

  /** Send a chat line to the room (max 120 characters, single line). Arrives as a `chat` event for everyone, you included. */
  chat(text: string): void {
    const checked = normalizeChat(text);
    if (!checked.ok) {
      throw checked.reason === 'empty'
        ? new GameRelayError('bad_request', 'Chat messages cannot be empty')
        : new GameRelayError('too_large', `Chat messages are limited to ${LIMITS.maxChatLength} characters`);
    }
    this.#relay.queue({ t: 'chat', text: checked.text });
  }

  /**
   * Declare a kind of entity once, with its fields: 'number' and 'angle' are streamed and smoothed,
   * 'flag', 'text' and 'value' change at their moment. Every player's game must define a kind before
   * spawning it; updates for kinds not defined yet wait until you do. Returns the kind's handle:
   *
   *   const ships = room.define('ship', { x: 'number', y: 'number', alive: 'flag' });
   *   const me = ships.spawn({ x: 0, y: 0, alive: true });
   *   for (const s of ships.all()) draw(s);
   */
  define<const F extends Record<string, FieldInput>>(kind: string, fields: F, options?: DefineOptions): Kind<F> {
    this.#entities.define(kind, fields, options);
    return makeKind<F>(kind, {
      live: () => this.#live,
      spawn: (k, initial, o) => this.spawn(k, initial, o),
      all: (k) => this.all(k),
      get: (id) => this.get(id),
      on: (event, k, fn) => this.on(event as 'remove', k, fn),
    });
  }

  /** Create an entity you own. Write its fields every frame; the SDK sends changes (~20/s). */
  spawn(kind: string, initial: Record<string, unknown>, options?: SpawnOptions): Entity {
    return this.#entities.spawn(kind, initial, options);
  }

  /**
   * Host only: start a timer that fires `room.on('timer', name, …)` on whoever is host when it falls
   * due, exactly once, even if the host changes meanwhile. It lives in room state as a deadline on
   * the server clock, so everyone can show `room.timeLeft(name)`.
   */
  timer(name: string, ms: number): void {
    this.#timers.set(name, ms);
  }

  /** Host only: cancel a timer. */
  clearTimer(name: string): void {
    this.#timers.clear(name);
  }

  /** Milliseconds until a timer falls due (0 once due), or null if there's no such timer. */
  timeLeft(name: string): number | null {
    return this.#timers.left(name);
  }

  /**
   * Take `key` if nobody holds it: resolves true for exactly one player (the server decides), false
   * for everyone else. Held until you `release(key)` or leave. Use one key per thing (e.g. the
   * entity id of a power-up) so two players can't both pick it up.
   */
  claim(key: string): Promise<boolean> {
    return this.#claims.claim(key);
  }

  /** Let go of a claim you hold (the host may release any). Everyone gets a `released` event. */
  release(key: string): void {
    this.#claims.release(key);
  }

  /** Who holds `key`, or null. */
  claimed(key: string): PlayerId | null {
    return this.#claims.holder(key);
  }

  /**
   * Ask the host and wait for its answer: `const r = await room.request('buy', { item })`. Rejects
   * if the host refuses (`throw room.reject('why')`), changes before answering (`host_changed`) or
   * doesn't answer in 5 s (`timeout`).
   */
  request(type: string, data: Json = null): Promise<Json> {
    return this.#requests.request(type, data);
  }

  /**
   * Answer `room.request(type, …)` when you're the host. Return the result (or a promise); throw
   * `room.reject('why')` to refuse. Register it on every player, so a new host answers straight away.
   */
  onRequest(type: string, handler: (data: Json, from: PlayerId) => Json | undefined | Promise<Json | undefined>): () => void {
    return this.#requests.onRequest(type, handler);
  }

  /**
   * Host-simulated games: call every frame with this player's controls (`{ left, right, fire }`,
   * axes as numbers). The SDK sends the latest to the host ~20×/s, and a press is never lost.
   */
  input(state: Record<string, Json>): void {
    this.#inputs.set(state);
  }

  /** On the host: `room.inputs.get(playerId)` is that player's latest input (neutral after 500 ms of silence). */
  get inputs(): { get(playerId: PlayerId): Readonly<Record<string, Json>> } {
    return this.#inputsView;
  }

  /** For onRequest handlers: `throw room.reject('Not enough gold')` refuses with that reason. */
  reject(reason: string): RequestRejection {
    return new RequestRejection(String(reason));
  }

  /**
   * Host only: put everyone on one of `n` teams, balanced by count, and keep placing players who
   * join later on the smallest team. Nobody moves mid-round; call it again with
   * `{ rebalance: true }` between rounds to even things out. Read teams with `room.teamOf(id)`.
   */
  assignTeams(n: number, options: { rebalance?: boolean } = {}): void {
    if (!this.isHost) throw new GameRelayError('not_host', 'room.assignTeams: only the host assigns teams; check room.isHost');
    if (!Number.isInteger(n) || n < 1 || n > this.maxPlayers) {
      throw new GameRelayError('bad_request', `room.assignTeams(n): n must be a whole number from 1 to ${this.maxPlayers} (the room's maxPlayers)`);
    }
    const teams = balanceTeams(this.players.map((p) => p.id), this.#teams(), n, options.rebalance === true);
    this.#writeState({ [TEAMS_KEY]: teams, [TEAM_COUNT_KEY]: n });
  }

  /** The team (0…n − 1) the host put this player on with `assignTeams`, or undefined. */
  teamOf(playerId: PlayerId): number | undefined {
    const team = this.#teams()[playerId];
    return typeof team === 'number' ? team : undefined;
  }

  #teams(): Record<PlayerId, number> {
    const raw = this.state[TEAMS_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<PlayerId, number>) : {};
  }

  /** On the host, while teams are on: place newcomers and drop leavers (nobody else moves). */
  #keepTeams(): void {
    const n = this.state[TEAM_COUNT_KEY];
    if (!this.isHost || typeof n !== 'number') return;
    const current = this.#teams();
    const next = balanceTeams(this.players.map((p) => p.id), current, n, false);
    if (JSON.stringify(next) !== JSON.stringify(current)) this.#writeState({ [TEAMS_KEY]: next });
  }

  /** Every entity of a kind: yours live, everyone else's smoothed about 100 ms in the past. */
  all(kind: string): Entity[] {
    return this.#entities.all(kind);
  }

  get(id: string): Entity | undefined {
    return this.#entities.get(id);
  }

  /** The server-clock moment other players' entities are drawn at (for effects that must line up). */
  get renderTime(): number {
    return this.#entities.renderTime();
  }

  /**
   * Send an event: to everyone (default), `'host'`, or one player id. Your own handler runs right
   * away too (`echo: false` to skip), so handle an action in one place: if the shooter also spawns
   * its own bullet before emitting 'fire', the echo spawns a second one. Events are for moments;
   * facts go in entities or room state. Nothing is kept for players who join later.
   */
  emit(type: string, data: Json = null, options: { to?: PlayerId | 'host'; echo?: boolean } = {}): void {
    const to = options.to === 'host' ? this.hostId : options.to;
    this.#messages.emit(type, data, { to, echo: options.echo });
  }

  override on<K extends keyof RoomEvents>(event: K, handler: RoomEvents[K]): () => void;
  /** An entity of `kind` appears. Doesn't replay ones already here: loop over `room.all(kind)` for those. */
  override on(event: 'spawn', kind: string, handler: (entity: Entity) => void): () => void;
  override on(event: 'remove', kind: string, handler: (entity: Entity, reason: RemoveReason) => void): () => void;
  /** Runs on the host when the timer falls due. */
  override on(event: 'timer', name: string, handler: () => void): () => void;
  /** The host role passed to you (not fired for the room's first host: check `room.isHost`). */
  override on(event: 'host', handler: () => void): () => void;
  override on(event: string, handler: CustomHandler): () => void;
  override on(event: string, a: unknown, b?: unknown): () => void {
    if (event === 'timer') {
      if (typeof a !== 'string' || typeof b !== 'function') {
        throw new GameRelayError('bad_request', "room.on('timer', name, handler): give the timer's name, e.g. room.on('timer', 'round', () => …)");
      }
      const set = this.#timerHandlers.get(a) ?? new Set<() => void>();
      this.#timerHandlers.set(a, set);
      set.add(b as () => void);
      return () => void set.delete(b as () => void);
    }
    if (event === 'spawn' || event === 'remove') {
      if (typeof a !== 'string' || typeof b !== 'function') {
        throw new GameRelayError('bad_request', `room.on('${event}', kind, handler): give the entity kind, e.g. room.on('${event}', 'ship', (e) => …)`);
      }
      const map = event === 'spawn' ? this.#spawnHandlers : this.#removeHandlers;
      const set = map.get(a) ?? new Set<EntityHandler>();
      map.set(a, set);
      set.add(b as EntityHandler);
      return () => void set.delete(b as EntityHandler);
    }
    if (ROOM_EVENTS.has(event)) return super.on(event as keyof RoomEvents, a as never);
    const real = Object.hasOwn(EVENT_ALIASES, event) ? EVENT_ALIASES[event] : undefined;
    if (real) {
      this.#relay.warn('event_name', `event_name:${event}`, `room.on('${event}') is a custom event (only room.emit('${event}') fires it); the built-in for ${ALIAS_WHAT[real]} is room.on('${real}')`);
    }
    const set = this.#custom.get(event) ?? new Set<CustomHandler>();
    this.#custom.set(event, set);
    set.add(a as CustomHandler);
    return () => void set.delete(a as CustomHandler);
  }

  override off<K extends keyof RoomEvents>(event: K, handler: RoomEvents[K]): void;
  override off(event: 'spawn' | 'remove', kind: string, handler: (entity: Entity, reason: RemoveReason) => void): void;
  override off(event: 'timer', name: string, handler: () => void): void;
  override off(event: 'host', handler: () => void): void;
  override off(event: string, handler: CustomHandler): void;
  override off(event: string, a: unknown, b?: unknown): void {
    if (event === 'timer') {
      if (typeof a === 'string') this.#timerHandlers.get(a)?.delete(b as () => void);
      return;
    }
    if (event === 'spawn' || event === 'remove') {
      if (typeof a === 'string') (event === 'spawn' ? this.#spawnHandlers : this.#removeHandlers).get(a)?.delete(b as EntityHandler);
      return;
    }
    if (ROOM_EVENTS.has(event)) return super.off(event as keyof RoomEvents, a as never);
    this.#custom.get(event)?.delete(a as CustomHandler);
  }

  /** @internal For the debug overlay. */
  debugInfo(): { delayMs: number; entities: Record<string, number>; hosted: Record<string, number> } {
    return { delayMs: this.#entities.delay.ms, entities: this.#entities.counts(), hosted: this.#entities.hostedCounts() };
  }

  #fireEntity(map: Map<string, Set<EntityHandler>>, entity: Entity, reason?: RemoveReason): void {
    for (const h of map.get(entity.kind) ?? []) {
      try {
        h(entity, reason as RemoveReason);
      } catch (err) {
        console.error('[gamerelay] listener error', err);
      }
    }
  }

  #fireTimer(name: string): void {
    for (const h of this.#timerHandlers.get(name) ?? []) {
      try {
        h();
      } catch (err) {
        console.error('[gamerelay] listener error', err);
      }
    }
  }

  /** The host role moved: hand entities over first, then tell the game. */
  #hostMoved(hostId: PlayerId, previous: PlayerId): void {
    const was = this.hostId; // our own view decides whether we just gained or lost the role
    this.hostId = hostId;
    this.#entities.hostChanged(hostId, was);
    this.#requests.hostChanged();
    this.#inputs.hostChanged();
    this.fire('host_changed', hostId, previous);
    this.#keepTeams();
    if (hostId === this.me && was !== this.me) this.#fireCustom('host', null, this.me, { at: this.#relay.now() });
  }

  #fireCustom(type: string, data: Json, from: PlayerId, meta: MessageMeta): void {
    for (const h of this.#custom.get(type) ?? []) {
      try {
        h(data, from, meta);
      } catch (err) {
        console.error('[gamerelay] listener error', err);
      }
    }
  }

  async leave(): Promise<void> {
    if (this.#relay.room === this) this.#relay.room = null;
    this.closeLocal('left');
    await this.#relay.request({ t: 'leave_room' }).catch(() => undefined);
  }

  /** @internal Stop this object's work without a `closed` event (it was replaced by a new one). */
  dispose(): void {
    this.#live = false;
    this.#claims.close();
    this.#requests.close();
    this.#stopLoop();
    this.#unwatchVisibility();
  }

  /** @internal */
  closeLocal(reason: CloseReason, message?: string): void {
    this.#live = false;
    this.#claims.close();
    this.#requests.close();
    this.#stopLoop();
    this.#unwatchVisibility();
    this.fire('closed', reason, message);
  }

  /** @internal Resync after a reconnect, emitting events for anything that changed. */
  sync(info: RoomInfo): void {
    const before = new Map(this.players.map((p) => [p.id, p]));
    const after = new Set(info.players.map((p) => p.id));
    this.players = info.players;
    for (const p of info.players) {
      if (before.has(p.id)) continue;
      this.#entities.playerJoined(p.id);
      this.fire('player_joined', p);
    }
    for (const id of before.keys()) {
      if (after.has(id)) continue;
      this.#entities.playerLeft(id);
      this.#inputs.playerLeft(id);
      this.fire('player_left', id, 'timeout');
    }
    // State first: becoming host here must work from the room's current state, not our stale copy
    // (teams, timers), or it would write the stale values back.
    this.state = info.state;
    if (info.hostId !== this.hostId) this.#hostMoved(info.hostId, this.hostId);
    this.fire('state', this.state, info.state, info.hostId);
    this.#claims.sync(info.claims);
    this.#keepTeams();
    if (info.seed !== this.seed) {
      this.seed = info.seed;
      this.fire('seed', info.seed, info.hostId);
    }
    // Deliver chat that arrived while we were reconnecting.
    const seen = new Set(this.chatHistory.map((m) => m.id));
    for (const m of info.chat ?? []) if (!seen.has(m.id)) this.#receiveChat(m);
  }

  #receiveChat(message: ChatMessage): void {
    this.chatHistory = [...this.chatHistory, message].slice(-LIMITS.chatHistory * 5);
    this.fire('chat', message);
  }

  /** @internal */
  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'message':
        if (this.#entities.receive(msg.d, msg.from, msg.at) || this.#messages.receive(msg.d, msg.from, msg.at) || this.#requests.receive(msg.d, msg.from) || this.#inputs.receive(msg.d, msg.from)) return;
        return this.fire('message', msg.d, msg.from, { at: msg.at });
      case 'seed':
        this.seed = msg.seed;
        return this.fire('seed', msg.seed, msg.from);
      case 'chat':
        return this.#receiveChat(msg.message);
      case 'state':
        this.state = applyPatch(this.state, msg.patch);
        return this.fire('state', this.state, msg.patch, msg.from);
      case 'player_joined':
        this.players = [...this.players.filter((p) => p.id !== msg.player.id), msg.player];
        this.#entities.playerJoined(msg.player.id);
        this.#keepTeams();
        return this.fire('player_joined', msg.player);
      case 'player_left':
        this.players = this.players.filter((p) => p.id !== msg.playerId);
        this.#entities.playerLeft(msg.playerId);
        this.#inputs.playerLeft(msg.playerId);
        this.#keepTeams();
        return this.fire('player_left', msg.playerId, msg.reason);
      case 'player_disconnected':
      case 'player_reconnected': {
        const connected = msg.t === 'player_reconnected';
        this.players = this.players.map((p) => (p.id === msg.playerId ? { ...p, connected } : p));
        return this.fire(msg.t, msg.playerId);
      }
      case 'host_changed':
        return this.#hostMoved(msg.hostId, msg.previousHostId);
      case 'claimed':
      case 'released':
      case 'claim_result':
        return this.#claims.receive(msg);
    }
  }
}

function applyPatch(state: JsonObject, patch: JsonObject): JsonObject {
  const next = { ...state };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

/**
 * A small, fast, seeded random number generator (mulberry32): the same seed gives every player the
 * same sequence. Returns floats in [0, 1), like `Math.random`.
 *
 *   const rand = seededRandom(room.seed);
 *   const die = 1 + Math.floor(rand() * 6);
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
