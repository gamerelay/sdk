/**
 * The LAN shortcut (experimental, `connect({ lan: true })`): players on the same network also send
 * each broadcast straight to each other over a WebRTC data channel, and the receiver keeps
 * whichever copy arrives first.
 *
 * The WebSocket stays the source of truth. Every broadcast still goes through the server (so it
 * still meters, signs and relays it, and remote players get it as before); the LAN copy only races
 * it. Each pair of players gets one peer connection with two kinds of route: direct, between
 * devices on the same network, and through one of our TURN relays, when the server has them (the
 * one with the least delay for the pair, `relays.ts`). ICE prefers the direct route when it works.
 * No public address is exchanged (only local and relay candidates are sent or used), except with
 * party members when the game allows it (`lan: { direct: 'party' }`). When no route connects,
 * nothing changes.
 *
 * Signalling rides on the room's own relay (`send({ to })`), so the server needs no changes.
 *
 * This file is what every room has: broadcasts wrapped and numbered, and both copies merged. The
 * peer connections themselves (`Peers`, peers.ts) are a second file, loaded when a room starts with
 * P2P on in a browser with WebRTC (`load.ts`); until it's there, or if it never loads, only server
 * copies go, as for a player with P2P off.
 */
import { LIMITS, TokenBucket } from '@gamerelay/protocol/limits';
import type { Json, PlayerId } from '@gamerelay/protocol/types';
import type { Delays } from './relays';
import { loadPeers } from './load';
import type { Peers } from './peers';

/** A broadcast as it goes over the wire with the shortcut on: sender session, sequence, payload. */
export interface Wrapped {
  $gr: 'l';
  /** The sender's session (a page reload starts a new sequence). */
  e: string;
  n: number;
  /**
   * Barrier: the sender sent something server-only (a state patch, a targeted send, a claim) just
   * before broadcast `b`. A LAN copy carrying it may only be used once the server's copy of `b` (or
   * a later one) has arrived: the server's stream is in order, so the server-only message has too.
   * `b === n` (the first broadcast after a server-only message, or a host-only event, which the
   * server drops if its sender was just replaced as host): only its own server copy may deliver it,
   * so it has no LAN copy, and later LAN copies wait for it.
   */
  b?: number;
  /**
   * The latest room state number (`seq`) the sender had seen. A LAN copy may only be used once
   * the receiver has that state too, so a reaction to a state patch never arrives before the patch.
   * (Its server copy needs no check: the server sent the patch to everyone before relaying it.)
   */
  s?: number;
  /** A host-only write: a LAN copy from anyone but the current host is dropped (the server drops its twin). */
  h?: 1;
  d: Json;
}

export function isWrapped(d: unknown): d is Wrapped {
  return typeof d === 'object' && d !== null && (d as { $gr?: unknown }).$gr === 'l' && typeof (d as Wrapped).n === 'number' && typeof (d as Wrapped).e === 'string';
}

/** What the debug overlay shows: open channels, and which path delivered each broadcast first. */
export interface LanStats {
  peers: number;
  lanFirst: number;
  serverFirst: number;
  /**
   * Each open channel's round trip in ms, as ICE measures it on the route in use, once known. For
   * now it's only shown: which copies go out doesn't depend on it yet.
   */
  rttMs: Record<PlayerId, number>;
}

/** Held LAN copies per sender before they're discarded (a long outage of the server path). */
const MAX_HELD = 256;
/** Sessions remembered per sender, so a straggler from an old tab isn't taken for a new stream. */
const MAX_SESSIONS = 4;
/** A LAN copy held this long is discarded: its server copy, if it ever comes, is delivered instead. */
export const STALE_MS = 1000;
/** LAN copies held per sender for a session no server copy has shown yet (a reload, or made up). */
export const MAX_UNCONFIRMED = 64;

interface Held {
  d: Json;
  at: number;
  /** When it arrived (the steady clock). */
  since: number;
  source: 'lan' | 'ws';
  /** A LAN copy of it arrived (even if the server's copy is the one delivered). */
  lan?: boolean;
  b?: number;
  s?: number;
}

interface Early {
  w: Wrapped;
  at: number;
  since: number;
}

interface Stream {
  epoch: string;
  /** The last seq delivered (or passed); null until we know where the stream starts. */
  last: number | null;
  /** The highest seq whose server copy arrived. */
  serverSeen: number | null;
  held: Map<number, Held>;
}

/**
 * Merges each sender's two copies of its broadcasts (server and LAN) into one stream: every
 * message once, in the sender's order, and never ahead of a server-only message the sender sent
 * before it.
 *
 * Every broadcast has a server copy, and the server's copies arrive in order. So a gap is only
 * skipped once the server's copies have passed it (the server dropped it: an unreliable send under
 * load); until then the missing message is still on its way.
 *
 * Only LAN copies are ever held, and a held LAN copy is either delivered in order, when the
 * server's progress allows it, or discarded: never forced out ahead of the server. Discarding is
 * always safe, because it leaves exactly what a server-only player sees (the server copy, if it
 * comes, is delivered as usual). Held copies are discarded when they're over `STALE_MS` old, when
 * there are too many, when the sender leaves or reloads, and after our own reconnect.
 */
export class Merge {
  /** Per sender, its recent sessions, newest first. Only a server copy starts one. */
  readonly #streams = new Map<PlayerId, Stream[]>();
  /** Per sender, LAN copies of a session its server copies haven't started yet. */
  readonly #unconfirmed = new Map<PlayerId, Early[]>();
  /** Which path delivered first, for the debug overlay. */
  readonly won = { lan: 0, ws: 0 };

  constructor(
    private readonly deliver: (from: PlayerId, d: Json, at: number) => void,
    /** Whether we have room state number `s` (see `Wrapped.s`). Default: yes. */
    private readonly stateSeen: (s: number) => boolean = () => true,
    /**
     * A race was decided: a LAN copy arrived and either delivered its message (`won`) or didn't
     * (the server's copy came first, or had to be waited for).
     */
    private readonly raced: (from: PlayerId, won: boolean) => void = () => {},
  ) {}

  /** One copy arrived. `now`: the steady clock, for `tick`. */
  accept(from: PlayerId, w: Wrapped, at: number, source: 'lan' | 'ws', now = 0): void {
    // `b === n` is never sent over the LAN (only its server copy may deliver it); ignore one anyway.
    if (source === 'lan' && w.b === w.n) return;
    const sessions = this.#streams.get(from) ?? [];
    let st = sessions.find((x) => x.epoch === w.e);
    if (!st) {
      if (source === 'lan') {
        // A session only the LAN has shown: the sender reloaded, and its server copies are on
        // their way; or it made one up, to start a stream the server never sees (a new session's
        // first message needs nothing before it). Either way its LAN copies wait for a server copy.
        const early = this.#unconfirmed.get(from) ?? [];
        early.push({ w, at, since: now });
        if (early.length > MAX_UNCONFIRMED) early.shift();
        this.#unconfirmed.set(from, early);
        return;
      }
      // A reload: a new sequence. The old session's server copies came before this one, so
      // whatever it still held has no server copy coming.
      for (const old of sessions) this.#discard(old);
      st = { epoch: w.e, last: null, serverSeen: null, held: new Map() };
      this.#streams.set(from, [st, ...sessions].slice(0, MAX_SESSIONS));
      // Its LAN copies that came first join it; any for other sessions never will.
      for (const e of this.#unconfirmed.get(from) ?? []) if (e.w.e === w.e) this.#hold(st, e.w, e.at, 'lan', e.since);
      this.#unconfirmed.delete(from);
    }
    // A LAN copy of a message already delivered: its server copy won.
    if (source === 'lan' && st.last !== null && w.n <= st.last) this.raced(from, false);
    this.#hold(st, w, at, source, now);
    // Even a duplicate moves `serverSeen` on, which can free what's held.
    this.#pump(from, st);
  }

  /** Keep a copy until it can be delivered (or note its server copy came). */
  #hold(st: Stream, w: Wrapped, at: number, source: 'lan' | 'ws', now: number): void {
    if (source === 'ws') st.serverSeen = Math.max(st.serverSeen ?? w.n, w.n);
    if (st.last === null || w.n > st.last) {
      const held = st.held.get(w.n);
      if (held) {
        // The server's copy of a held LAN copy: in order by definition, so no barrier applies.
        if (source === 'ws') Object.assign(held, { source, at, b: undefined, s: undefined });
        else held.lan = true; // a LAN copy of a held server copy: it lost the race
      } else {
        const lan = source === 'lan';
        st.held.set(w.n, { d: w.d, at, since: now, source, lan, b: lan ? w.b : undefined, s: lan ? w.s : undefined });
      }
      if (st.held.size > MAX_HELD) this.#discard(st);
    }
  }

  /** Deliver what has become deliverable: we got a state patch a held LAN copy was waiting on. */
  pump(): void {
    for (const [from, sessions] of this.#streams) for (const st of sessions) this.#pump(from, st);
  }

  /** Discard LAN copies held longer than `STALE_MS`. */
  tick(now: number): void {
    for (const [from, sessions] of this.#streams) for (const st of sessions) this.#expire(from, st, now);
    for (const [from, early] of this.#unconfirmed) {
      const fresh = early.filter((e) => now - e.since < STALE_MS);
      if (fresh.length > 0) this.#unconfirmed.set(from, fresh);
      else this.#unconfirmed.delete(from);
    }
  }

  #expire(from: PlayerId, st: Stream, now: number): void {
    let changed = false;
    for (const [n, h] of st.held) {
      if (h.source === 'lan' && now - h.since >= STALE_MS) {
        st.held.delete(n);
        changed = true;
      }
    }
    if (changed) this.#pump(from, st);
  }

  /**
   * The sender left: the server relayed its messages before telling us, so nothing held has a
   * server copy coming. Discard it. The stream's position stays: a player who times out and
   * rejoins keeps its session, and its outbox resends what we already have.
   */
  forget(from: PlayerId): void {
    for (const st of this.#streams.get(from) ?? []) this.#discard(st);
    this.#unconfirmed.delete(from);
  }

  /** We reconnected: the server doesn't replay what we missed, so held copies' server copies aren't coming. */
  resync(): void {
    for (const sessions of this.#streams.values()) for (const st of sessions) this.#discard(st);
    this.#unconfirmed.clear();
  }

  /** May this copy be used now? */
  #ok(st: Stream, h: Held): boolean {
    if (h.source === 'ws') return true;
    if (h.s !== undefined && !this.stateSeen(h.s)) return false;
    return h.b === undefined || (st.serverSeen !== null && h.b <= st.serverSeen);
  }

  /** Deliver in order what can be. */
  #pump(from: PlayerId, st: Stream): void {
    if (st.last === null) {
      // The stream starts at the first server copy we get (which is what started the session),
      // or at older LAN copies held before it (sent before we joined, or simply faster).
      if (st.held.size === 0 || st.serverSeen === null) return;
      st.last = this.#min(st) - 1;
    }
    while (st.held.size > 0) {
      let n: number = (st.last ?? 0) + 1; // set just above; TypeScript loses it across #take
      if (!st.held.has(n)) {
        // A gap: skip it only if the server's copies are already past it (it was dropped).
        const m = this.#min(st);
        if (st.serverSeen === null || st.serverSeen < m - 1) return;
        n = m;
      }
      const h = st.held.get(n)!;
      if (!this.#ok(st, h)) return;
      this.#take(from, st, n, h);
    }
  }

  #discard(st: Stream): void {
    for (const [n, h] of st.held) if (h.source === 'lan') st.held.delete(n);
  }

  #take(from: PlayerId, st: Stream, n: number, h: Held): void {
    st.held.delete(n);
    st.last = n;
    this.won[h.source]++;
    if (h.lan) this.raced(from, h.source === 'lan');
    this.deliver(from, h.d, h.at);
  }

  #min(st: Stream): number {
    let m = Number.POSITIVE_INFINITY;
    for (const k of st.held.keys()) if (k < m) m = k;
    return m;
  }
}

/**
 * Signalling between two SDKs, relayed by the server as an ordinary `send({ to })`. The lower
 * player id offers. `hi` (to the offerer) and `ask` (to the answerer) both mean "I have no channel
 * with you, start over": the offerer answers a `hi` with an offer, the answerer an `ask` with a
 * `hi`. `g` names one offer, so answers and candidates for an older one are told apart. A `hi`
 * carries the sender's delay to each relay (`r`), and the offer names the relay for the pair
 * (`relay`), which both then use. A `reoffer` restarts ICE on the connection that offer `of` set
 * up, keeping its channel (fresh relay credentials, or a network change); an answerer without that
 * connection says `hi` instead. Our candidates go out in batches (`ice`: the first in `c`, the
 * rest in `cs`), so an SDK that only reads `c` still gets one from each batch.
 */
export type Signal =
  | { $gr: 'lan'; k: 'ask' }
  | { $gr: 'lan'; k: 'hi'; r?: Delays }
  | { $gr: 'lan'; k: 'offer'; g: string; sdp: string; relay?: string }
  | { $gr: 'lan'; k: 'reoffer'; g: string; of: string; sdp: string }
  | { $gr: 'lan'; k: 'answer'; g: string; sdp: string }
  | { $gr: 'lan'; k: 'ice'; g: string; c?: Json; cs?: Json[] };


export function isSignal(d: unknown): d is Signal {
  return typeof d === 'object' && d !== null && (d as { $gr?: unknown }).$gr === 'lan';
}

export interface LanDeps {
  me: PlayerId;
  /** Try to connect at all (the `lan` option); when false we still answer nothing and merge copies. */
  enabled: boolean;
  signal(to: PlayerId, data: Json): void;
  /** The server clock (`relay.now()`): the `at` of a LAN copy. */
  now(): number;
  /** A steady clock (ms) for the rate-limit pause. Default: `performance.now()`. */
  clock?(): number;
  hostId(): PlayerId;
  /** Who's in the room now (us included). */
  players(): PlayerId[];
  /**
   * Our own server connection is up and back in the room. While it isn't, no LAN copies go out:
   * the server may never relay what we send then, and LAN peers mustn't act on it. Default: true.
   */
  serverReady?(): boolean;
  /**
   * A broadcast queued now gets through the server's rate limit (the relay keeps a copy of it, per
   * frame, as the server charges). Past it the server drops what we send, so LAN copies stop first.
   * Default: true.
   */
  withinRate?(): boolean;
  deliver(from: PlayerId, d: Json, at: number): void;
  /** A status line; `failure`: something broke (WebRTC threw), not the usual comings and goings. */
  log?(message: string, failure?: boolean): void;
  /** For tests. Default: a real `RTCPeerConnection`. */
  createPeer?(config: RTCConfiguration): RTCPeerConnection;
  /**
   * The server may have TURN relays: no connection is tried until `setRelays()` says which (`null`:
   * none, so the LAN only). Without this, the LAN only, straight away.
   */
  relay?: {
    /** Relay-only (`lan: { forceRelay: true }`, for testing the relay on one network). */
    only?: boolean;
    /** For tests. Default: `probeRelay`. */
    probe?(server: RTCIceServer): Promise<number | null>;
  };
  /**
   * Whether we may connect directly with `id` over the internet, trading public addresses: party
   * members, when the game allows it (`lan: { direct: 'party' }`). Default: never.
   */
  direct?(id: PlayerId): boolean;
  /** For tests: the peer code, already loaded (else it's fetched when the room starts). */
  peers?: typeof Peers;
  /** For tests: how the peer code is fetched. Default: `loadPeers`. */
  load?(): Promise<{ Peers: typeof Peers }>;
  /**
   * For tests: the connect timeout, the pause before a retry, how long counts as stable, the restart
   * cooldown, how long our candidates are gathered into one signal, the pauses before trying a
   * connection that never opened again, and how long a lost route waits before an ICE restart.
   */
  timing?: { connectMs?: number; retryMs?: number; stableMs?: number; restartMs?: number; iceMs?: number; missMs?: number[]; stallMs?: number };
}

/** After the server rate-limits us, LAN copies pause this long: it's dropping what we send. */
export const RATE_PAUSE_MS = 1000;

/**
 * Every room's half of the shortcut: our broadcasts numbered and wrapped (a LAN peer's copies need
 * the numbers to be merged, so they go from the start, connection or not), both copies of each
 * peer's merged, and the peer connections (`Peers`) once their code is loaded.
 */
export class Lan {
  readonly epoch = Math.random().toString(36).slice(2, 10);
  readonly merge: Merge;
  readonly #deps: LanDeps;
  readonly #clock: () => number;
  #peers: Peers | null = null;
  /** Loading the peer code: `setRelays` waits for it. Unset when it isn't wanted, or was given. */
  readonly #loading: Promise<void> | undefined;
  /** The latest relays given before the code was here (`undefined`: none yet), for when it is. */
  #relays: RTCIceServer[] | null | undefined = undefined;
  #seq = 0;
  /** A server-only message went out since the last broadcast: the next one starts a barrier. */
  #barrierNext = false;
  #barrier = 0;
  /** The latest room state number we've received (`Wrapped.s`). */
  #stateSeq = 0;
  #pausedUntil = Number.NEGATIVE_INFINITY;
  #closed = false;

  constructor(deps: LanDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => performance.now());
    this.merge = new Merge(
      (from, d, at) => deps.deliver(from, d, at),
      (seq) => this.stateSeen(seq),
      (from, won) => this.#peers?.raced(from, won),
    );
    if (deps.peers) this.#peers = new deps.peers(deps, this);
    else if (deps.enabled && (deps.createPeer || typeof RTCPeerConnection !== 'undefined')) this.#loading = this.#load();
  }

  /**
   * Fetch the peer code when the room starts, alongside the relays' credentials. Nothing is lost
   * meanwhile: with `deps.relay`, no peer is tried before the relays are known, and those wait for
   * the code (a peer's signals that come first are dropped, as they are until the relays are
   * known; its retries cover them). Not later, when someone joins: the code arriving then would
   * start over with everyone already there while the newcomer starts too, and an e2e run showed
   * that early churn costing the LAN gain (each side judged the other's copies slow).
   */
  async #load(): Promise<void> {
    let code: { Peers: typeof Peers };
    try {
      code = await (this.#deps.load ?? loadPeers)();
    } catch (err) {
      this.#deps.log?.(`P2P is off: its code didn't load (${(err as Error).message})`, true);
      return;
    }
    if (this.#closed) return;
    const peers = (this.#peers = new code.Peers(this.#deps, this));
    // Only the latest relays, at once: a refresh from now on goes straight to `peers`, after them.
    if (this.#relays !== undefined) await peers.setRelays(this.#relays);
    else if (!this.#deps.relay) peers.reconnect(); // the LAN only, straight away: everyone, now
  }

  /** Players we have an open LAN channel with. */
  peers(): PlayerId[] {
    return this.#peers?.peers() ?? [];
  }

  /** Whether the open channel with `id` goes direct or through a relay (`null`: not known, or none). */
  route(id: PlayerId): 'direct' | 'relay' | null {
    return this.#peers?.route(id) ?? null;
  }

  /**
   * The server's relays and fresh credentials for them (`null`: none): `Peers.setRelays`, straight
   * through once the code is here; before, the latest is kept for it (resolves once it's applied).
   */
  setRelays(servers: RTCIceServer[] | null): Promise<void> {
    if (this.#peers) return this.#peers.setRelays(servers);
    this.#relays = servers;
    return this.#loading ?? Promise.resolve();
  }

  stats(): LanStats {
    return { peers: 0, rttMs: {}, ...this.#peers?.stats(), lanFirst: this.merge.won.lan, serverFirst: this.merge.won.ws };
  }

  /** Wrap broadcasts at all: from the start, so each sender has one numbered stream. */
  get enabled(): boolean {
    return this.#deps.enabled;
  }

  /**
   * We have room state number `seq` (a patch, or a snapshot). Broadcasts from now on carry it, and
   * LAN copies that were waiting for it are delivered. Not a barrier: a LAN peer checks it has the
   * patch itself, which it almost always does already.
   */
  stateAt(seq: number): void {
    this.#stateSeq = seq;
    this.merge.pump();
  }

  /**
   * Whether we have room state `seq`. Only the host writes state, and the server sends each of us
   * everything in order, so the host has every state there is (its own patches, which it isn't
   * sent back, and a previous host's, which reached it before the host change did).
   */
  stateSeen(seq: number): boolean {
    return seq <= this.#stateSeq || this.#deps.hostId() === this.#deps.me;
  }

  /** The server rate-limited us (it's dropping our messages): stop racing copies for a while. */
  pause(): void {
    this.#pausedUntil = this.#clock() + RATE_PAUSE_MS;
  }

  /**
   * Something that goes only through the server is going out (a state patch, a targeted send, a
   * claim): later broadcasts' LAN copies must not overtake it.
   */
  barrier(): void {
    this.#barrierNext = true;
  }

  /**
   * A broadcast is going out over the server: wrap it and race a copy to every LAN peer.
   * `supersedable`: the sender's next write replaces this one (entity updates), so a host-only one
   * may race; any other host-only write waits for its own server copy.
   */
  wrap(d: Json, host: boolean, supersedable = false): Wrapped {
    const n = ++this.#seq;
    // A host-only event (a timer's effect, say): if we were just replaced as host, the server
    // drops it, and a receiver that hasn't heard yet mustn't use the LAN copy. A stale entity
    // update is harmless: the new host's next one overwrites it.
    if (host && !supersedable) this.#barrierNext = true;
    if (this.#barrierNext) {
      this.#barrier = n;
      this.#barrierNext = false;
    }
    const w: Wrapped = {
      $gr: 'l',
      e: this.epoch,
      n,
      ...(this.#barrier ? { b: this.#barrier } : {}),
      ...(this.#stateSeq ? { s: this.#stateSeq } : {}),
      ...(host ? { h: 1 as const } : {}),
      d,
    };
    const peers = this.#peers;
    if (!peers?.open || w.b === n) return w; // only its server copy could deliver it
    if (!(this.#deps.serverReady?.() ?? true)) return w; // the server copy may never be relayed
    if (!(this.#deps.withinRate?.() ?? true)) return w; // the server will drop this one
    // The LAN copy follows the server's rules: what it would refuse or drop, LAN peers don't get either.
    if (this.#clock() < this.#pausedUntil) return w;
    peers.copy(w);
    return w;
  }

  /** A copy arrived over the server. */
  receiveServer(from: PlayerId, w: Wrapped, at: number): void {
    this.merge.accept(from, w, at, 'ws', this.#clock());
  }

  /**
   * The server's limits, which a peer's LAN copies are held to as well: its message size, and a
   * bucket at its per-connection rate. From here, so the peer code's file doesn't carry `LIMITS`.
   */
  get maxMessageBytes(): number {
    return LIMITS.maxMessageBytes;
  }

  rateBucket(): TokenBucket {
    return new TokenBucket(LIMITS.ratePerSecond, LIMITS.rateBurst, this.#clock());
  }

  /** A copy arrived over `from`'s channel (any JSON: it's checked here). */
  receiveLan(from: PlayerId, w: unknown): void {
    if (!isWrapped(w)) return;
    // A replaced host's late host-only writes: the server drops those, so we do too.
    if (w.h && this.#deps.hostId() !== from) return;
    this.merge.accept(from, w, this.#deps.now(), 'lan', this.#clock());
  }

  tick(): void {
    this.merge.pump(); // (we may have just become host: see `stateSeen`)
    const now = this.#clock();
    this.merge.tick(now);
    this.#peers?.tick(now);
  }

  /** We reconnected. */
  resync(): void {
    this.merge.resync();
  }

  /** Someone to try (`Peers.add`). */
  add(id: PlayerId, initiate = true): void {
    this.#peers?.add(id, initiate);
  }

  /** We reconnected: start again with every player we have no open channel to (`Peers.reconnect`). */
  reconnect(): void {
    this.#peers?.reconnect();
  }

  /** `LanDeps.direct` may answer differently now (`Peers.directChanged`). */
  directChanged(): void {
    this.#peers?.directChanged();
  }

  /** A player left (`Peers.playerLeft`). */
  playerLeft(id: PlayerId): void {
    this.#peers?.playerLeft(id);
    this.merge.forget(id);
  }

  remove(id: PlayerId): void {
    this.#peers?.remove(id);
    this.merge.forget(id);
  }

  close(): void {
    this.#closed = true;
    this.#peers?.close();
  }

  /** A signalling message from `from`. */
  async signal(from: PlayerId, s: Signal): Promise<void> {
    return this.#peers?.signal(from, s);
  }
}
