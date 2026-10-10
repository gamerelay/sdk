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
 */
import { LIMITS, TokenBucket } from '@gamerelay/protocol/limits';
import type { Json, PlayerId } from '@gamerelay/protocol/types';
import { delaysFrom, pickRelay, probeRelay, relayAddresses, relayKey, routeOf, rttOf, stunUrls, type Delays, type StatsReport } from './relays';
import { fitsUtf8 } from '@gamerelay/protocol/bytes';

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
type Signal =
  | { $gr: 'lan'; k: 'ask' }
  | { $gr: 'lan'; k: 'hi'; r?: Delays }
  | { $gr: 'lan'; k: 'offer'; g: string; sdp: string; relay?: string }
  | { $gr: 'lan'; k: 'reoffer'; g: string; of: string; sdp: string }
  | { $gr: 'lan'; k: 'answer'; g: string; sdp: string }
  | { $gr: 'lan'; k: 'ice'; g: string; c?: Json; cs?: Json[] };

/**
 * A candidate for a direct route on this network: a host candidate whose address is an mDNS name
 * (how browsers hide local addresses) or private (IPv4 10/8, 172.16/12, 192.168/16; IPv6
 * link-local or unique-local). Anything else would reveal or probe a public address, which the
 * relay keeps private. Browsers also gather public ones (from the relay's STUN answer, and raw host
 * addresses, global IPv6 included, for a page with mic or camera permission): those are dropped.
 */
export function onThisNetwork(c: RTCIceCandidateInit): boolean {
  const parts = (c.candidate ?? '').split(' ');
  const addr = parts[4]?.toLowerCase() ?? '';
  const typ = parts[parts.indexOf('typ') + 1];
  if (typ !== 'host' || !addr) return false;
  if (addr.endsWith('.local')) return true;
  const v4 = addr.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^fe[89ab][0-9a-f]:/.test(addr) || /^f[cd][0-9a-f]{2}:/.test(addr);
}

/**
 * A candidate with a player's own address, public or not (host, or its public address as a STUN
 * server saw it): for a direct route over the internet, with party members only.
 */
export function ownAddress(c: RTCIceCandidateInit): boolean {
  const parts = (c.candidate ?? '').split(' ');
  const typ = parts[parts.indexOf('typ') + 1];
  return (typ === 'host' || typ === 'srflx') && Boolean(parts[4]);
}

/**
 * A relay candidate: the TURN server's address, never a player's (when it's ours; one from a peer
 * could name any address, so it's also checked against our relays': `Lan.#candidateOk`).
 */
export function viaRelay(c: RTCIceCandidateInit): boolean {
  const parts = (c.candidate ?? '').split(' ');
  return parts[parts.indexOf('typ') + 1] === 'relay' && Boolean(parts[4]);
}

/**
 * A candidate as we send it: `raddr`/`rport` blanked. On a relay candidate they're the player's own
 * public address, as the relay saw it; on a public one, its local address. Connecting needs neither.
 */
export function scrubbed(c: RTCIceCandidateInit): RTCIceCandidateInit {
  return c.candidate ? { ...c, candidate: c.candidate.replace(/ raddr \S+ rport \d+/, ' raddr 0.0.0.0 rport 0') } : c;
}

/**
 * An SDP with only the candidates `keep` allows. A description can carry candidates too (`a=candidate:`
 * lines), so it gets the same filter as a trickled one. `out`: one we send, which also gets its
 * candidates `scrubbed` and its default address (`c=`, `a=rtcp:`, filled in once gathering
 * starts) blanked: connecting uses the candidates alone.
 */
export function filterSdp(sdp: string, keep: (c: RTCIceCandidateInit) => boolean, out = false): string {
  const lines: string[] = [];
  for (const line of sdp.split(/\r\n|\n/)) {
    if (line.startsWith('a=candidate:')) {
      const c = { candidate: line.slice('a='.length) };
      if (keep(c)) lines.push(out ? `a=${scrubbed(c).candidate}` : line);
    } else if (out && /^(c=|a=rtcp:)/.test(line)) {
      lines.push(line.replace(/IN IP4 \S+/, 'IN IP4 0.0.0.0').replace(/IN IP6 \S+/, 'IN IP6 ::'));
    } else {
      lines.push(line);
    }
  }
  return lines.join('\r\n');
}

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
  log?(message: string): void;
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
  /**
   * For tests: the connect timeout, the pause before a retry, how long counts as stable, the restart
   * cooldown, how long our candidates are gathered into one signal, the pauses before trying a
   * connection that never opened again, and how long a lost route waits before an ICE restart.
   */
  timing?: { connectMs?: number; retryMs?: number; stableMs?: number; restartMs?: number; iceMs?: number; missMs?: number[]; stallMs?: number };
}

interface Peer {
  id: PlayerId;
  pc: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  open: boolean;
  /** The offer the current connection's latest negotiation belongs to (a `reoffer` moves it on). */
  gen: string | null;
  /** The offer that set the current connection up (a `reoffer` names it: `of`). */
  conn: string | null;
  /** The relay the current connection uses, with the credentials it was last given. */
  server: RTCIceServer | null;
  /** ICE lost the route (`disconnected`): no copies go until it's back (`#stall`). */
  stalled: boolean;
  stallTimer: ReturnType<typeof setTimeout> | null;
  /** Candidates that came before their connection was ready, with the offer they belong to. */
  early: { g: string; c: RTCIceCandidateInit }[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Times in a row the answerer set a dropped channel up again (reset once one stays up). */
  retries: number;
  /** Connections in a row that never opened (`#missed`; reset once one does). */
  misses: number;
  /** When the current channel opened (steady clock). */
  openedAt: number;
  /** The route the open channel takes (from `getStats()`), once known. */
  route: 'direct' | 'relay' | null;
  /** The open channel's round trip in ms (from `getStats()`, with the route), once known. */
  rtt: number | null;
  /** The current connection trades public addresses (`LanDeps.direct`, when it was set up). */
  direct: boolean;
  /** Its LAN copies to us since we last judged them (`RACE_WINDOW`), and how many delivered first. */
  races: number;
  wins: number;
  /** Until then (steady clock), it said our copies lose to the server's: send it only probes. */
  sparseUntil: number;
  /** Copies we didn't send it while sparse (every `PROBE_EVERY`th one still goes). */
  skipped: number;
  /**
   * What it may send us over the LAN: the server's per-connection rate, so copies can't outrun
   * what the server would take. Kept across its connections, so starting over doesn't refill it.
   */
  bucket: TokenBucket;
  /** When a request from it last made us start over (steady clock; see `#restartLater`). */
  restartAt: number;
  /** Its latest request to start over that came too soon, and the timer that runs it. */
  deferred: Signal | null;
  deferTimer: ReturnType<typeof setTimeout> | null;
  /** Back within the cap, an offerer's wait for the answerer's hello before it asks (`playerLeft`). */
  startTimer: ReturnType<typeof setTimeout> | null;
  /** Our candidates for offer `g` not sent yet (`#queueCandidate`). */
  outbox: { g: string; cs: Json[]; timer: ReturnType<typeof setTimeout> } | null;
}

/**
 * A broadcast whose wrapped copy is bigger than this goes by the server only. The channel doesn't
 * retransmit, and a message this size already takes about two packets: much bigger, and it's split
 * into so many SCTP fragments (16 KB is about 14) that losing any one of them drops the copy, so
 * big copies mostly arrive never, while they still cost the peer's bandwidth and receive budget.
 */
export const MAX_LAN_COPY_BYTES = 2048;
/** After the server rate-limits us, LAN copies pause this long: it's dropping what we send. */
export const RATE_PAUSE_MS = 1000;
/**
 * A copy that reaches a player after the server's copy of it is wasted upstream (and relay)
 * bandwidth: on a relayed route near the game server, it often is. Every `RACE_WINDOW` of a
 * player's copies we judge them, and if fewer than `SLOW_SHARE` delivered first we tell it
 * (`{ $gr: 'slow' }`, which older SDKs ignore). It then sends us only every `PROBE_EVERY`th copy
 * for `SPARSE_MS`, so we keep judging; if the route gets faster, the notices stop and so does that.
 */
export const RACE_WINDOW = 32;
export const SLOW_SHARE = 0.1;
export const SPARSE_MS = 30_000;
export const PROBE_EVERY = 10;
const SLOW: Json = { $gr: 'slow' };

/** Give up on a peer that hasn't connected in this long (not on the same network, or isolated Wi-Fi). */
const CONNECT_MS = 8000;
/** Mesh only for small rooms. */
export const MAX_LAN_PEERS = 7;
/** A channel that closes is set up again at most this many times in a row… */
const MAX_RETRIES = 3;
/** …after this pause: a peer that leaves closes its channel before the server tells us it left. */
export const RETRY_MS = 1000;
/** A channel open this long was a working connection: the retry count starts over when it drops. */
const STABLE_MS = 10_000;
/** A channel with this much still queued gets no more copies (the server copies still go). */
const MAX_BUFFERED = 64 * 1024;
const MAX_EARLY = 32;
/**
 * Our candidates are gathered this long into one `ice` signal: a browser finds several within a few
 * ms of each other, and one server message for each made a burst of them on every join.
 */
const ICE_BATCH_MS = 50;
/** A batch this full goes at once (a signal stays far under the server's message limit). */
const MAX_BATCH = 16;
/** How often open channels' routes are read again (ICE can move to a better one). */
const ROUTE_CHECK_MS = 2000;
/**
 * With relays, a connection that never opened is tried again after these pauses, one per miss in a
 * row (`#missed`). All well over RESTART_MS, so the offerer never has to hold the hello back.
 */
export const MISS_BACKOFF_MS = [5000, 30_000, 120_000];
/**
 * A connection ICE calls `disconnected` this long is restarted by the offerer (`#stall`): after a
 * network change (Wi-Fi to cellular) the old route is gone, and ICE alone takes ~30 s to fail.
 */
export const STALL_MS = 3000;
/** A peer makes us start over at most once in this long (`#restartLater`). */
export const RESTART_MS = 2000;

export class Lan {
  readonly epoch = Math.random().toString(36).slice(2, 10);
  readonly merge: Merge;
  readonly #deps: LanDeps;
  readonly #clock: () => number;
  readonly #peers = new Map<PlayerId, Peer>();
  #seq = 0;
  #offers = 0;
  #open = 0;
  /** A server-only message went out since the last broadcast: the next one starts a barrier. */
  #barrierNext = false;
  #barrier = 0;
  /** The latest room state number we've received (`Wrapped.s`). */
  #stateSeq = 0;
  #pausedUntil = Number.NEGATIVE_INFINITY;
  #closed = false;
  /** The server's relays: `undefined` until it says (with `deps.relay`), `null` for none. */
  #relays: RTCIceServer[] | null | undefined = undefined;
  /** Our relays' addresses (`relayAddresses`): the only ones a peer's relay candidate may have. */
  #relayAddrs = new Set<string>();
  /** Our delay to each relay, and which relays that was timed for. */
  #delays: Delays = {};
  #probed = '';
  #routesAt = Number.NEGATIVE_INFINITY;

  constructor(deps: LanDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => performance.now());
    this.merge = new Merge(
      (from, d, at) => deps.deliver(from, d, at),
      (seq) => this.stateSeen(seq),
      (from, won) => this.#raced(from, won),
    );
  }

  /** Players we have an open LAN channel with. */
  peers(): PlayerId[] {
    return [...this.#peers.values()].filter((p) => p.open).map((p) => p.id);
  }

  /** Whether the open channel with `id` goes direct or through a relay (`null`: not known, or none). */
  route(id: PlayerId): 'direct' | 'relay' | null {
    const p = this.#peers.get(id);
    return p?.open ? p.route : null;
  }

  /**
   * The server's relays and fresh credentials for them (`null`: it has none). With more than one,
   * we time each first, so the first hellos already carry our delays. The first answer starts
   * connections with everyone.
   */
  async setRelays(servers: RTCIceServer[] | null): Promise<void> {
    const keys = (servers ?? []).map(relayKey).join(' ');
    if (servers && servers.length > 1 && keys !== this.#probed) {
      this.#probed = keys;
      const probe = this.#deps.relay?.probe ?? ((s: RTCIceServer) => probeRelay(s, { createPeer: this.#deps.createPeer, clock: this.#clock }));
      const ms = await Promise.all(servers.map((s) => probe(s).catch(() => null)));
      if (this.#probed !== keys || this.#closed) return; // a newer list is being timed
      this.#delays = {};
      servers.forEach((s, i) => {
        if (ms[i] !== null && ms[i] !== undefined) this.#delays[relayKey(s)] = ms[i];
      });
    }
    const first = this.#relays === undefined;
    this.#relays = servers;
    this.#relayAddrs = relayAddresses(servers ?? []);
    if (first) this.reconnect();
    else if (servers) this.#freshCredentials(servers);
  }

  /**
   * New credentials for relays our connections use. A connection keeps the credentials it started
   * with, and the relay refuses to refresh its allocation once they expire (an hour), so each gets
   * the new ones, and the offerer restarts ICE: both sides gather again, each allocating with its
   * newest credentials, and the channel stays open meanwhile. The offerer's refreshes come every
   * 20 minutes, so neither side's allocation outlives its credentials. A relay no longer listed
   * keeps its old ones: that connection starts over when it fails, on a relay from the new list.
   */
  #freshCredentials(servers: RTCIceServer[]): void {
    for (const p of this.#peers.values()) {
      const pc = p.pc;
      const old = p.server;
      if (!pc || !old) continue;
      const fresh = servers.find((s) => relayKey(s) === relayKey(old));
      if (!fresh || (fresh.username === old.username && fresh.credential === old.credential)) continue;
      p.server = fresh;
      try {
        pc.setConfiguration({ ...pc.getConfiguration(), ...this.#iceConfig(p, fresh) });
      } catch (err) {
        this.#deps.log?.(`LAN shortcut to ${p.id}: couldn't take the new relay credentials (${(err as Error).message})`);
        continue;
      }
      if (p.open && this.#offerer(p.id)) void this.#renegotiate(p);
    }
  }

  stats(): LanStats {
    const rttMs: Record<PlayerId, number> = {};
    for (const p of this.#peers.values()) if (p.open && p.rtt !== null) rttMs[p.id] = p.rtt;
    return { peers: this.#open, lanFirst: this.merge.won.lan, serverFirst: this.merge.won.ws, rttMs };
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
    if (this.#open === 0 || w.b === n) return w; // only its server copy could deliver it
    if (!(this.#deps.serverReady?.() ?? true)) return w; // the server copy may never be relayed
    if (!(this.#deps.withinRate?.() ?? true)) return w; // the server will drop this one
    // The LAN copy follows the server's rules: what it would refuse or drop, LAN peers don't get either.
    if (this.#clock() < this.#pausedUntil) return w;
    // Written as text only once a peer will get it (each may be stalled, full or skipping), and
    // only if it's well under the server's own limit, `LIMITS.maxMessageBytes`, so what it would
    // refuse is covered. `null`: too big for a LAN copy.
    let text: string | null | undefined;
    const now = this.#clock();
    for (const p of this.#peers.values()) {
      if (!p.open || p.stalled || !p.channel || p.channel.bufferedAmount > MAX_BUFFERED) continue;
      // Measured before a skipping peer counts this one: a copy too big for the LAN is no probe.
      if (text === undefined) {
        const json = JSON.stringify(w);
        text = fitsUtf8(json, MAX_LAN_COPY_BYTES) ? json : null;
      }
      if (text === null) break;
      if (now < p.sparseUntil && ++p.skipped % PROBE_EVERY !== 0) continue; // it said ours lose
      try {
        p.channel.send(text);
      } catch {
        // A channel closing under us: the server copy still arrives.
      }
    }
    return w;
  }

  /** A race of `from`'s copies was decided; every `RACE_WINDOW`, tell it if they mostly lose. */
  #raced(from: PlayerId, won: boolean): void {
    const p = this.#peers.get(from);
    if (!p?.open || !p.channel) return;
    p.races++;
    if (won) p.wins++;
    if (p.races < RACE_WINDOW) return;
    const slow = p.wins < p.races * SLOW_SHARE;
    p.races = 0;
    p.wins = 0;
    if (!slow) return;
    try {
      p.channel.send(JSON.stringify(SLOW));
    } catch {
      // closing: its copies stop anyway
    }
  }

  /** A copy arrived over the server. */
  receiveServer(from: PlayerId, w: Wrapped, at: number): void {
    this.merge.accept(from, w, at, 'ws', this.#clock());
  }

  tick(): void {
    this.merge.pump(); // (we may have just become host: see `stateSeen`)
    const now = this.#clock();
    this.merge.tick(now);
    if (now - this.#routesAt >= ROUTE_CHECK_MS && this.#open > 0) {
      this.#routesAt = now;
      for (const p of this.#peers.values()) if (p.open && p.pc) void this.#readRoute(p, p.pc);
    }
  }

  async #readRoute(p: Peer, pc: RTCPeerConnection): Promise<void> {
    if (typeof pc.getStats !== 'function') return;
    try {
      const report = (await pc.getStats()) as unknown as StatsReport;
      if (p.pc !== pc || !p.open) return;
      const route = routeOf(report);
      if (route) p.route = route;
      p.rtt = rttOf(report) ?? p.rtt;
    } catch {
      // closing: its route no longer matters
    }
  }

  /** We reconnected. */
  resync(): void {
    this.merge.resync();
  }

  /**
   * Someone to try. `initiate`: we start (we're the newcomer, or back from a reconnect); the offerer
   * asks for a hello, the answerer sends one. Players already in a room only note a newcomer, so
   * each pair negotiates once.
   */
  add(id: PlayerId, initiate = true): void {
    if (!this.#allowed(id) || this.#peers.has(id)) return;
    this.#peer(id);
    if (initiate) this.#sayHello(id);
  }

  /**
   * We reconnected: start again with every player we have no open channel to. What they sent us
   * while we were away (a retry's hello, an offer) went nowhere: the server drops sends to a
   * disconnected player.
   */
  reconnect(): void {
    for (const id of this.#deps.players()) {
      if (!this.#allowed(id)) continue;
      const p = this.#peer(id);
      if (p.open) continue;
      this.#teardown(p);
      this.#sayHello(id);
    }
  }

  /**
   * `LanDeps.direct` may answer differently now (our party changed, or the owner switched direct
   * connections on or off): a connection set up with the other answer starts over (an answerer says
   * hello, an offerer asks for one), so public addresses go only where they're allowed.
   */
  directChanged(): void {
    for (const p of this.#peers.values()) {
      if (!p.pc || p.direct === this.#direct(p.id)) continue;
      this.#teardown(p);
      if (this.#allowed(p.id)) this.#sayHello(p.id);
    }
  }

  /**
   * A player left: forget them, and if the room is back within the cap, start with every player
   * we have no entry for (the ones the cap turned away: a pair that gave up on each other keeps its
   * entry, so it stays given up). Usually both turned each other away, so the answerer says hello
   * at once and the offerer waits for it; the offerer asks only if no hello has started a
   * connection by the end of a setup's time (the answerer may have had us all along, as an entry it
   * gave up on).
   */
  playerLeft(id: PlayerId): void {
    this.remove(id);
    const players = this.#deps.players();
    if (players.length - 1 > MAX_LAN_PEERS) return;
    for (const other of players) {
      if (this.#peers.has(other) || !this.#allowed(other)) continue;
      const p = this.#peer(other);
      if (!this.#offerer(other)) {
        this.#sayHello(other);
        continue;
      }
      p.startTimer = setTimeout(() => {
        p.startTimer = null;
        if (this.#peers.get(other) === p && !p.pc && this.#allowed(other)) this.#sayHello(other);
      }, this.#deps.timing?.connectMs ?? CONNECT_MS);
    }
  }

  remove(id: PlayerId): void {
    const p = this.#peers.get(id);
    if (p) {
      this.#teardown(p);
      if (p.startTimer) clearTimeout(p.startTimer);
      p.startTimer = null;
      if (p.deferTimer) clearTimeout(p.deferTimer);
      p.deferTimer = null;
      p.deferred = null;
    }
    this.#peers.delete(id);
    this.merge.forget(id);
  }

  close(): void {
    this.#closed = true;
    for (const id of [...this.#peers.keys()]) this.remove(id);
  }

  /**
   * A candidate we may send to or use with `id`: a local one or a relay's; a public one only if
   * direct. A relay candidate from `id` (`incoming`) must have one of our relays' addresses: with
   * any other, it's a player's address dressed up as a relay's, and we'd send it checks from ours.
   */
  #candidateOk(c: RTCIceCandidateInit, id: PlayerId, incoming: boolean): boolean {
    if (viaRelay(c)) return !incoming || this.#relayAddrs.has((c.candidate ?? '').split(' ')[4]!.toLowerCase());
    if (this.#deps.relay?.only) return false;
    return onThisNetwork(c) || (this.#direct(id) && ownAddress(c));
  }

  #direct(id: PlayerId): boolean {
    return !this.#deps.relay?.only && (this.#deps.direct?.(id) ?? false);
  }

  /** Send `id` our "start over" (`#hello`). */
  #sayHello(id: PlayerId): void {
    this.#deps.signal(id, this.#hello(id));
  }

  /** "Start over" to `id`, as the offerer (`ask`) or the answerer (`hi`, with our relay delays). */
  #hello(id: PlayerId): Signal {
    if (this.#offerer(id)) return { $gr: 'lan', k: 'ask' };
    return Object.keys(this.#delays).length ? { $gr: 'lan', k: 'hi', r: { ...this.#delays } } : { $gr: 'lan', k: 'hi' };
  }

  /**
   * Should we have a LAN channel with `id` at all? The size cap is for starting one: a peer we have
   * already keeps its signalling (credential refreshes, restarts, retries) when the room grows past
   * it, or its channel would die at the next relay refresh and never come back.
   */
  #allowed(id: PlayerId): boolean {
    if (!this.#deps.enabled || this.#closed || id === this.#deps.me) return false;
    if (typeof RTCPeerConnection === 'undefined' && !this.#deps.createPeer) return false;
    if (this.#deps.relay && this.#relays === undefined) return false; // waiting for the server
    if (this.#deps.relay?.only && !this.#relays?.length) return false;
    const players = this.#deps.players();
    if (!players.includes(id)) return false;
    return this.#peers.has(id) || players.length - 1 <= MAX_LAN_PEERS;
  }

  #offerer(id: PlayerId): boolean {
    return this.#deps.me < id;
  }

  #peer(id: PlayerId): Peer {
    let p = this.#peers.get(id);
    if (!p) {
      const bucket = new TokenBucket(LIMITS.ratePerSecond, LIMITS.rateBurst, this.#clock());
      p = {
        id, pc: null, channel: null, open: false, gen: null, conn: null, server: null, stalled: false, stallTimer: null, early: [], timer: null, retries: 0, misses: 0, openedAt: 0, route: null, rtt: null, direct: false, races: 0, wins: 0, sparseUntil: 0, skipped: 0, bucket,
        restartAt: Number.NEGATIVE_INFINITY, deferred: null, deferTimer: null, startTimer: null, outbox: null,
      };
      this.#peers.set(id, p);
    }
    return p;
  }

  /** A signalling message from `from`. */
  async signal(from: PlayerId, s: Signal): Promise<void> {
    return this.#signal(from, s, false);
  }

  /**
   * A request to start over (a `hi` to the offerer, an `ask` or an `offer` to the answerer) tears
   * down the connection and builds another, with a relay allocation of its own, so a peer mustn't
   * be able to make us do it at will. A `reoffer` counts too: an ICE restart allocates again. One that comes within RESTART_MS of the last, while we have
   * a connection with that peer (open or being set up), waits out the rest of that time, and a
   * later one replaces it. Waiting rather than ignoring it keeps every real restart working (a
   * reloaded page, both sides starting over at once): the latest one always runs, at most that
   * late. An `ask` waits even with no connection: each is answered with a hello, through the
   * server, on our rate limit. `due`: the wait is over.
   */
  #restartLater(p: Peer, s: Signal, offerer: boolean, due: boolean): boolean {
    const restart = s.k === 'hi' ? offerer : (s.k === 'ask' || s.k === 'offer' || s.k === 'reoffer') && !offerer;
    if (!restart) return false;
    const now = this.#clock();
    const wait = p.restartAt + (this.#deps.timing?.restartMs ?? RESTART_MS) - now;
    if (!due && wait > 0 && (p.pc !== null || s.k === 'ask')) {
      p.deferred = s;
      p.deferTimer ??= setTimeout(() => {
        p.deferTimer = null;
        const next = p.deferred;
        p.deferred = null;
        if (next && this.#peers.get(p.id) === p) void this.#signal(p.id, next, true);
      }, wait);
      return true;
    }
    p.restartAt = now;
    p.deferred = null; // this one supersedes any still waiting
    return false;
  }

  async #signal(from: PlayerId, s: Signal, due: boolean): Promise<void> {
    if (!this.#allowed(from)) return;
    const p = this.#peer(from);
    const offerer = this.#offerer(from);
    if (this.#restartLater(p, s, offerer, due)) return;
    // The connection this call works on. Each await can come back to a peer that has since started
    // over: then we stop, and a failure only closes our own connection.
    let pc: RTCPeerConnection | null = null;
    const stale = () => p.pc !== pc;
    try {
      if (s.k === 'hi') {
        if (!offerer) return;
        this.#teardown(p);
        const g = `${this.epoch}.${++this.#offers}`;
        const relay = this.#relays?.length ? pickRelay(this.#relays, this.#delays, delaysFrom(s.r)) : undefined;
        pc = this.#connect(p, g, relay);
        const offer = await pc.createOffer();
        if (stale()) return;
        await pc.setLocalDescription(offer);
        if (stale()) return;
        this.#deps.signal(from, { $gr: 'lan', k: 'offer', g, sdp: this.#sdpOut(pc, from), ...(relay ? { relay } : {}) });
      } else if (s.k === 'ask') {
        if (offerer) return;
        this.#teardown(p);
        this.#sayHello(from);
      } else if (s.k === 'offer') {
        if (offerer) return;
        this.#teardown(p);
        pc = this.#connect(p, s.g, typeof s.relay === 'string' ? s.relay : undefined);
        await pc.setRemoteDescription({ type: 'offer', sdp: this.#sdpIn(s.sdp, from) });
        if (stale()) return;
        await this.#flushEarly(p, pc);
        const answer = await pc.createAnswer();
        if (stale()) return;
        await pc.setLocalDescription(answer);
        if (stale()) return;
        this.#deps.signal(from, { $gr: 'lan', k: 'answer', g: s.g, sdp: this.#sdpOut(pc, from) });
      } else if (s.k === 'reoffer') {
        if (offerer) return;
        if (!p.pc || typeof s.g !== 'string' || p.conn !== s.of) {
          // Not for the connection we have (we started over meanwhile): start over for real.
          this.#teardown(p);
          this.#sayHello(from);
          return;
        }
        // An ICE restart on the connection we have: the channel stays open while ICE finds a new route.
        pc = p.pc;
        const g = s.g;
        p.gen = g; // candidates for it may already be waiting (`#flushEarly`)
        const again = () => p.pc !== pc || p.gen !== g;
        await pc.setRemoteDescription({ type: 'offer', sdp: this.#sdpIn(s.sdp, from) });
        if (again()) return;
        await this.#flushEarly(p, pc);
        const answer = await pc.createAnswer();
        if (again()) return;
        await pc.setLocalDescription(answer);
        if (again()) return;
        this.#deps.signal(from, { $gr: 'lan', k: 'answer', g, sdp: this.#sdpOut(pc, from) });
      } else if (s.k === 'answer') {
        if (!offerer || !p.pc || s.g !== p.gen) return;
        pc = p.pc;
        await pc.setRemoteDescription({ type: 'answer', sdp: this.#sdpIn(s.sdp, from) });
        if (stale()) return;
        await this.#flushEarly(p, pc);
      } else if (s.k === 'ice') {
        // A batch (`cs`), or an older SDK's single candidate (`c`): each gets the same checks.
        const list = [s.c, ...(Array.isArray(s.cs) ? s.cs : [])].slice(0, MAX_EARLY);
        for (const x of list) {
          if (typeof x !== 'object' || x === null || Array.isArray(x)) continue;
          const c = x as RTCIceCandidateInit;
          if (!this.#candidateOk(c, from, true)) continue; // never probe a player's public address (unless direct)
          if (!p.pc || s.g !== p.gen || !p.pc.remoteDescription) {
            // Before its connection is ready (it can overtake the offer): keep it for then.
            p.early = [...p.early, { g: s.g, c }].slice(-MAX_EARLY);
            continue;
          }
          await this.#candidate(p.pc, c);
        }
      }
    } catch (err) {
      if (stale()) return; // an old connection failing as it was closed: nothing to do
      this.#deps.log?.(`LAN shortcut to ${from} failed: ${(err as Error).message}`);
      // A restart on an open channel that fails is a lost connection (set up again after a pause).
      if (s.k === 'reoffer') this.#lost(p);
      else this.#teardown(p);
    }
  }

  /** A peer's description, keeping only candidates we'd use from it (as `ice` checks them). */
  #sdpIn(sdp: unknown, from: PlayerId): string {
    return filterSdp(String(sdp), (c) => this.#candidateOk(c, from, true));
  }

  /** Our description for `to`, with only the candidates we'd send it. */
  #sdpOut(pc: RTCPeerConnection, to: PlayerId): string {
    return filterSdp(pc.localDescription!.sdp, (c) => this.#candidateOk(c, to, false), true);
  }

  /** One candidate; one the browser rejects (end-of-candidates, an unresolvable name) is skipped. */
  async #candidate(pc: RTCPeerConnection, c: RTCIceCandidateInit): Promise<void> {
    try {
      await pc.addIceCandidate(c);
    } catch (err) {
      this.#deps.log?.(`LAN shortcut: skipped a candidate (${(err as Error).message})`);
    }
  }

  async #flushEarly(p: Peer, pc: RTCPeerConnection): Promise<void> {
    const mine = p.early.filter((e) => e.g === p.gen);
    p.early = []; // other offers' candidates are for connections that are gone
    for (const e of mine) if (p.pc === pc) await this.#candidate(pc, e.c);
  }

  /** A new connection for offer `g`, through `relay` (named in the offer; else the first relay). */
  #connect(p: Peer, g: string, relay?: string): RTCPeerConnection {
    const servers = this.#relays ?? [];
    const server = servers.find((s) => relayKey(s) === relay) ?? servers[0];
    p.direct = this.#direct(p.id);
    const config = this.#iceConfig(p, server);
    const pc = this.#deps.createPeer?.(config) ?? new RTCPeerConnection(config);
    // Negotiated on both sides with the same id: no in-band announcement, open as soon as ICE is.
    // Unreliable and unordered: every copy has a server twin and the merge reorders, so a lost
    // packet should cost nothing, not hold up the copies behind it.
    const channel = pc.createDataChannel('gamerelay', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    p.pc = pc;
    p.channel = channel;
    p.gen = g;
    p.conn = g;
    p.server = server ?? null;
    pc.onicecandidate = (ev) => {
      if (p.pc !== pc) return;
      const c = ev.candidate?.toJSON();
      // For the latest negotiation: after an ICE restart, candidates belong to the `reoffer`.
      if (c && this.#candidateOk(c, p.id, false)) this.#queueCandidate(p, p.gen ?? g, scrubbed(c) as Json);
      // The end of gathering (no candidate, or an empty one): nothing more to wait for.
      if (!c?.candidate) this.#flushCandidates(p);
    };
    pc.onconnectionstatechange = () => {
      if (p.pc !== pc) return;
      const state = pc.connectionState;
      if (state === 'failed') this.#lost(p);
      else if (state === 'disconnected' && p.open && !p.stalled) this.#stall(p, pc);
      else if (state === 'connected') this.#unstall(p);
    };
    channel.onopen = () => {
      if (p.pc !== pc || p.open) return;
      p.open = true;
      p.misses = 0;
      p.openedAt = this.#clock();
      p.route = null;
      p.rtt = null;
      // A new route: its races start over, and so do ours.
      p.races = 0;
      p.wins = 0;
      p.sparseUntil = 0;
      this.#routesAt = Number.NEGATIVE_INFINITY; // read its route on the next tick
      this.#open++;
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      this.#deps.log?.(`LAN shortcut to ${p.id} is open`);
    };
    channel.onclose = () => {
      if (p.pc === pc) this.#lost(p);
    };
    channel.onmessage = (ev) => {
      if (p.pc !== pc || typeof ev.data !== 'string') return;
      // The server's limits hold here too: a copy it would refuse (too big, or over the rate) is
      // dropped, and its server copy, if there is one, is delivered as usual. Our own copies stay
      // under `MAX_LAN_COPY_BYTES` (`wrap`); this checks only what the server would refuse.
      const text = ev.data;
      if (!fitsUtf8(text, LIMITS.maxMessageBytes)) return;
      if (!p.bucket.take(this.#clock())) return;
      let w: unknown;
      try {
        w = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof w === 'object' && w !== null && (w as { $gr?: unknown }).$gr === 'slow') {
        const now = this.#clock();
        if (now >= p.sparseUntil) this.#deps.log?.(`LAN shortcut to ${p.id}: the server's copies arrive first, so only probes go this way`);
        p.sparseUntil = now + SPARSE_MS;
        return;
      }
      if (!isWrapped(w)) return;
      // A replaced host's late host-only writes: the server drops those, so we do too.
      if (w.h && this.#deps.hostId() !== p.id) return;
      this.merge.accept(p.id, w, this.#deps.now(), 'lan', this.#clock());
    };
    p.timer = setTimeout(() => {
      if (p.pc === pc && !p.open) {
        this.#deps.log?.(`LAN shortcut to ${p.id}: no route (different networks and no relay, or the Wi-Fi keeps devices apart)`);
        this.#teardown(p);
        this.#missed(p);
      }
    }, this.#deps.timing?.connectMs ?? CONNECT_MS);
    return pc;
  }

  /**
   * Our ICE servers for a connection through `server` (none: the LAN only). Direct: the same relay
   * also answers STUN, which finds our public address. Never anyone else's STUN server: that would
   * tell a third party who's playing.
   */
  #iceConfig(p: Peer, server: RTCIceServer | undefined): RTCConfiguration {
    if (!server) return { iceServers: [] };
    const stun = p.direct ? stunUrls(server) : [];
    return { iceServers: stun.length ? [server, { urls: stun }] : [server], iceTransportPolicy: this.#deps.relay?.only ? 'relay' : 'all' };
  }

  /**
   * Restart ICE on an open connection, keeping its channel (the offerer only): a new offer with new
   * ICE credentials, sent as a `reoffer` naming the connection. Both sides gather candidates again,
   * with the relay credentials they have now. A new offer id (`g`), so a late answer or candidate
   * for the negotiation before is ignored as for any older offer.
   */
  async #renegotiate(p: Peer): Promise<void> {
    const pc = p.pc;
    const of = p.conn;
    if (!pc || !of || !this.#offerer(p.id)) return;
    const g = `${this.epoch}.${++this.#offers}`;
    p.gen = g;
    const stale = () => p.pc !== pc || p.gen !== g;
    try {
      pc.restartIce?.();
      const offer = await pc.createOffer({ iceRestart: true });
      if (stale()) return;
      await pc.setLocalDescription(offer);
      if (stale()) return;
      this.#deps.signal(p.id, { $gr: 'lan', k: 'reoffer', g, of, sdp: this.#sdpOut(pc, p.id) });
    } catch (err) {
      if (stale()) return;
      this.#deps.log?.(`LAN shortcut to ${p.id}: couldn't restart ICE (${(err as Error).message})`);
      this.#lost(p);
    }
  }

  /**
   * ICE lost the open connection's route (`disconnected`: a network change, or a relay that stopped
   * answering). No copies go meanwhile: they'd be lost. After STALL_MS the offerer restarts ICE,
   * and the answerer waits for its `reoffer`; if the route isn't back within the connect timeout
   * after that, the connection is lost, and set up again as usual.
   */
  #stall(p: Peer, pc: RTCPeerConnection): void {
    p.stalled = true;
    if (p.stallTimer) clearTimeout(p.stallTimer);
    p.stallTimer = setTimeout(() => {
      if (p.pc !== pc || !p.stalled) return;
      if (this.#offerer(p.id)) void this.#renegotiate(p);
      p.stallTimer = setTimeout(() => {
        p.stallTimer = null;
        if (p.pc === pc && p.stalled) this.#lost(p);
      }, this.#deps.timing?.connectMs ?? CONNECT_MS);
    }, this.#deps.timing?.stallMs ?? STALL_MS);
  }

  #unstall(p: Peer): void {
    p.stalled = false;
    if (p.stallTimer) clearTimeout(p.stallTimer);
    p.stallTimer = null;
  }

  /** One of our candidates for offer `g`: it goes out with the others found within `ICE_BATCH_MS`. */
  #queueCandidate(p: Peer, g: string, c: Json): void {
    if (p.outbox && p.outbox.g !== g) this.#flushCandidates(p);
    p.outbox ??= { g, cs: [], timer: setTimeout(() => this.#flushCandidates(p), this.#deps.timing?.iceMs ?? ICE_BATCH_MS) };
    p.outbox.cs.push(c);
    if (p.outbox.cs.length >= MAX_BATCH) this.#flushCandidates(p);
  }

  #flushCandidates(p: Peer): void {
    const box = p.outbox;
    if (!box) return;
    p.outbox = null;
    clearTimeout(box.timer);
    const [c, ...rest] = box.cs;
    if (c !== undefined) this.#deps.signal(p.id, { $gr: 'lan', k: 'ice', g: box.g, c, ...(rest.length ? { cs: rest } : {}) });
  }

  /**
   * An open connection closed or failed. Set it up again after a pause: the answerer says hello,
   * and the offerer answers with a new offer. Not if the peer left, or started over, meanwhile.
   * (One that never opened is `#missed`.)
   */
  #lost(p: Peer): void {
    const wasOpen = p.open;
    this.#teardown(p);
    if (!wasOpen) return this.#missed(p);
    if (this.#offerer(p.id)) return;
    // A connection that stayed up was working: this drop starts the count over. One that keeps
    // dropping straight away (a flapping network) is left alone after a few tries.
    if (this.#clock() - p.openedAt >= (this.#deps.timing?.stableMs ?? STABLE_MS)) p.retries = 0;
    if (p.retries >= MAX_RETRIES) return;
    p.retries++;
    setTimeout(() => {
      if (this.#peers.get(p.id) === p && !p.pc && this.#allowed(p.id)) this.#sayHello(p.id);
    }, this.#deps.timing?.retryMs ?? RETRY_MS);
  }

  /**
   * A connection that never opened (it timed out, or failed or closed first). Without relays that
   * means another network or Wi-Fi that keeps devices apart, which trying again won't change. With
   * relays it's often passing (a relay restarting, a network still settling, a lost signal), so the
   * answerer says hello again after `MISS_BACKOFF_MS`, longer each miss in a row, and gives up after
   * the last. The offerer waits for that hello, as after a drop.
   */
  #missed(p: Peer): void {
    if (this.#offerer(p.id) || !this.#relays?.length) return;
    const wait = (this.#deps.timing?.missMs ?? MISS_BACKOFF_MS)[p.misses];
    if (wait === undefined) return;
    p.misses++;
    setTimeout(() => {
      if (this.#peers.get(p.id) === p && !p.pc && this.#allowed(p.id)) this.#sayHello(p.id);
    }, wait);
  }

  /**
   * Close the current connection. Early candidates stay: they're matched by offer when used. Ours
   * not sent yet are dropped: they're for this connection.
   */
  #teardown(p: Peer): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    if (p.outbox) clearTimeout(p.outbox.timer);
    p.outbox = null;
    this.#unstall(p);
    if (p.open) this.#open--;
    p.open = false;
    const pc = p.pc;
    p.pc = null;
    p.channel = null;
    try {
      pc?.close();
    } catch {
      // already closed
    }
  }
}
