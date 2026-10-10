/**
 * @gamerelay/sdk: multiplayer for browser games. Zero dependencies.
 * Guide: https://gamerelay.io/llms.txt
 */
import { LIMITS } from '@gamerelay/protocol/limits';
import { normalizeChat, normalizeLine } from '@gamerelay/protocol/chat';
import { signFrame, unmaskKey, type FrameKey } from '@gamerelay/protocol/sign';
import { CLOSE, type Notice } from '@gamerelay/protocol/clients';
import { SDK_VERSION } from './version';
import { lane } from './core/lane';
import { followable } from './core/hosts';
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
  type PartyMember,
  type PlanFeatures,
  type PlayerId,
  type RoomListing,
  type PlayerInfo,
  type RoomInfo,
  type ServerMessage,
} from '@gamerelay/protocol/types';
import { GameRelayError, type GameRelayErrorCode } from './errors';
import { CREATE, DEBUG, defaults, relays, rooms, type Outgoing, type RelayLink, type Request, type RoomControl, type RoomDebugInfo } from './internal';
import { Ticker, pickScheduler } from './core/ticker';
import { fitsUtf8, utf8Length } from '@gamerelay/protocol/bytes';
import { BATCH_OPEN, MAX_BATCH, PACE_PER_SECOND, SendBudget, batchItem } from './core/budget';
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
import { Lan, isSignal, isWrapped } from './sync/lan';

export { GameRelayError };
export type { GameRelayErrorCode };
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
  LeaveReason,
  PartyMember,
};

/** What `POST /v1/auth/token` (and `/v1/auth/anonymous`) answer with; `getToken` may return it whole. */
export interface TokenResponse {
  token: string;
  expiresAt?: number;
  /** Where to connect (`wss://…/ws`). */
  wsUrl?: string;
}

/** What the server says about itself in `welcome` (for debugging). Experimental. */
export interface ServerInfo {
  /** The server's version. */
  version: string | null;
}

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
  /**
   * Supply tokens minted by your own backend (secret key) instead of anonymous ones. Return the
   * token, or simply the whole response `POST /v1/auth/token` gave your backend
   * (`{ token, expiresAt, wsUrl }`): then the SDK also connects where the server said.
   * `connect()` waits for it as long as it takes (a sign-in first is fine); a reconnect gives it
   * 15 s, then tries again later. `signal` aborts when that wait ends or `relay.close()` is called:
   * pass it to your `fetch`, or close a sign-in prompt, and the late answer is ignored.
   */
  getToken?: (signal: AbortSignal) => Promise<string | TokenResponse>;
  /**
   * Development only: simulate a bad network. `latency` is extra round-trip ms (half each way),
   * `jitter` ± ms per message (order is kept, as on a real socket), `loss` the share (0–1) of
   * `reliable: false` sends dropped. Remove it before you ship.
   */
  simulate?: NetworkSimulation;
  /** Show a small overlay (ping, smoothing, traffic, entities, warnings). For development. */
  debug?: boolean;
  /**
   * Player to player, on by default. Experimental: outside the API promise, it may change in a
   * minor release. Players also send broadcasts straight to each other over WebRTC, racing the
   * server's copy, so each pair takes its best route: directly on the same network, else through
   * the server's nearest TURN relay, when it has relays. Everything still goes through the server
   * as well. Nobody sees another player's public address. `false` turns it off.
   * `{ forceRelay: true }`: through the relay only, even on one network (for testing the relay).
   * `{ direct: 'party' }`: members of your party may also connect straight to each other over the
   * internet, which shows each of them the other's public IP address; everyone else still goes
   * through the relay. It also needs the instance's "Direct connections" setting on (dashboard;
   * off by default). Ask each player first, and don't use it in games children under 13 may play.
   * @experimental
   */
  p2p?: P2POptions;
  /** @deprecated The old name of `p2p` (it isn't LAN-only); still works. */
  lan?: P2POptions;
}

/** `connect({ p2p })`: on (the default), off, or how. Experimental. */
export type P2POptions = boolean | { forceRelay?: boolean; direct?: 'party' };

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

/** `relay.createRoom(options)`. */
export interface CreateRoomOptions extends RoomOptions {
  /** Listed by `relay.listRooms` and open to quick match. */
  public?: boolean;
  /** Joined by its invite link only (`room.inviteUrl()`, `room.shareLink()`), not its code. */
  linkOnly?: boolean;
}

/** `relay.joinOrCreate(options)`. Experimental. */
export interface JoinOrCreateOptions extends RoomOptions {
  /** With no invite in the URL: a new unlisted room (friends join with its code or invite), not quick match. */
  private?: boolean;
  /** Write the room's invite into the address bar (`history.replaceState`), so copying the URL invites. */
  updateUrl?: boolean;
}

/** `relay.listRooms(options)`. */
export interface ListRoomsOptions {
  /** Only rooms with this tag (`createRoom({ tag })`). */
  tag?: string;
  /** Add full and locked rooms, for a server browser. */
  includeFull?: boolean;
}

/** Who may join a room (`room.setAccess`, the `access` event). */
export interface RoomAccess {
  /** Nobody new may join (it fails with `locked`); players in the room stay, and can reconnect. */
  locked: boolean;
  /** Listed by `relay.listRooms` and open to quick match. */
  public: boolean;
  /** Joined by its short link only (`room.shareLink()`), not its code; players with a seat can still come back. */
  linkOnly: boolean;
  maxPlayers: number;
}

/** What room lists show about a room (`room.setListing`, the `listing` event). */
export interface RoomListingInfo {
  name: string | null;
  meta: Json | null;
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
  'access',
  'listing',
]);
/** Names models guess for built-in room events: listening to one is legal, but only room.emit fires it. */
const EVENT_ALIASES: Record<string, string> = {
  playerJoined: 'player_joined', playerJoin: 'player_joined', player_join: 'player_joined', join: 'player_joined', joined: 'player_joined',
  playerLeft: 'player_left', playerLeave: 'player_left', player_leave: 'player_left', leave: 'player_left', left: 'player_left',
  hostChanged: 'host_changed', host_change: 'host_changed', newHost: 'host_changed',
  stateChanged: 'state', state_changed: 'state', stateChange: 'state',
  playerDisconnected: 'player_disconnected', playerReconnected: 'player_reconnected',
  becameHost: 'host', onHost: 'host', host_gained: 'host',
};
const ALIAS_WHAT: Record<string, string> = {
  player_joined: 'a player arriving',
  player_left: 'a player leaving',
  host_changed: 'a new host',
  state: 'a state change',
  player_disconnected: 'a player dropping',
  player_reconnected: 'a player coming back',
  host: 'becoming the host',
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
  party_room: (room: Room) => void;
  /** @deprecated The old name of `party_room`; still fires. */
  room: (room: Room) => void;
};

const RELAY_EVENTS = new Set<string>(['disconnected', 'reconnected', 'server_restarting', 'replaced', 'error', 'party', 'party_room', 'room']);

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
   * You're out of the room: you left, it was lost while reconnecting, you were kicked (by the
   * room's host or the game's owner), or the owner closed it. `message` is the kicker's note, if any.
   */
  closed: (reason: CloseReason, message?: string) => void;
  /** Someone took a claim (`room.claim`): you included. */
  claimed: (key: string, playerId: PlayerId) => void;
  /** A claim is free again: released, or its holder left. */
  released: (key: string, playerId: PlayerId) => void;
  /** The host changed who may join (`room.setAccess`): you included. `room.locked` and the rest are updated. */
  access: (access: RoomAccess, from: PlayerId) => void;
  /** The host changed what room lists show (`room.setListing`): you included. */
  listing: (listing: RoomListingInfo, from: PlayerId) => void;
};

interface Pending {
  resolve: (data: Json | undefined) => void;
  reject: (err: GameRelayError) => void;
  timer: ReturnType<typeof setTimeout>;
  /** A ping's `ts`: its pong carries that, not the rid. */
  ts?: number;
}


/** Stay under the server's 16 KB message limit, with room for the batch wrapper and signature. */
const MAX_FRAME_BYTES = 15_000;
const MAX_QUEUED = 256;
/**
 * A request the server hasn't answered in this long fails with `timeout`. The server answers in
 * milliseconds, so this only fires when the frame or its answer was lost (a dead socket the
 * watchdog hasn't caught yet, or a frame the rate limit dropped).
 */
const REPLY_TIMEOUT_MS = 10_000;
/** Timed-out requests remembered, so a late answer is dropped instead of reported as an error. */
const MAX_EXPIRED = 64;
/** A connect (the token, then the socket's welcome) that takes longer than this fails with `timeout`. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Reconnect failures that retrying can't fix: the relay stops (and says why, through `error`). */
const FINAL_CODES = new Set<string>(['unauthorized', 'upgrade_required']);

/** A secret key (`gr_sk_`) where a page would hold it. */
const secretKey = () => new GameRelayError('unauthorized', "That's your SECRET key (gr_sk_): never put it in a page. Rotate it now in the dashboard; pages use the public key (gr_pub_)");

/**
 * The error code for a failed token request: the server's own where it says one, `unauthorized` for
 * a key it refuses, and `disconnected` (try again) for anything else (a proxy's 502 mid-deploy).
 */
function authCode(status: number, error: string | undefined): GameRelayErrorCode {
  if (error === 'at_capacity' || error === 'quota_exceeded' || error === 'rate_limited') return error;
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403 || error === 'unauthorized' || error === 'origin_not_allowed') return 'unauthorized';
  if (status === 400) return 'bad_request';
  return 'disconnected';
}

/** How often the connection's upkeep runs (`#watch`). */
const WATCH_MS = 1000;
/**
 * Nothing received for this long while connected: ping, to learn whether the socket still works. A
 * socket can stay open for minutes after the network under it is gone (Wi-Fi to cellular), losing
 * everything sent on it, and the server's pings are invisible to the page. At most one ping per
 * 5 s of silence, a sliver of the rate limit.
 */
const PROBE_IDLE_MS = 5000;
/** A ping that hears nothing back, no message at all, for this long means the socket is dead. */
const PROBE_TIMEOUT_MS = 3000;
/** The clock is re-measured this often, as the two clocks drift (and a sleep can stop ours). */
const CLOCK_RESAMPLE_MS = 20_000;
/** Clock samples kept: the one with the shortest round trip wins. */
const CLOCK_SAMPLES = 8;

/**
 * A clock that only moves forward, in ms since the epoch: the server offset is kept against it, so
 * the wall clock stepping (sleep and wake, an NTP fix, the player changing it) can't move `now()`.
 */
const monotonic = () => performance.timeOrigin + performance.now();
/** The LAN shortcut asks for fresh relay credentials this often (they last an hour on the server). */
const ICE_REFRESH_MS = 20 * 60 * 1000;


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
/** Short links (`room.shareLink()`) arrive with the link's id in this one: `?join=ZumXpZzDsgo`. */
const LINK_PARAM = 'join';

function pageUrl(): string {
  if (typeof location === 'undefined') throw new Error('[gamerelay] No page URL here; pass one');
  return location.href;
}

/** Anonymous tokens, per tab, so a reload resumes the same player. */
const session = safeStorage('session');

export class GameRelay extends Emitter<RelayEvents> {
  #playerId = '';
  #room: Room | null = null;
  #party: PartyInfo | null = null;
  #features = Object.fromEntries(PLAN_FEATURES.map((f) => [f, false])) as unknown as PlanFeatures;
  #serverInfo: ServerInfo = { version: null };

  /** This SDK's version, e.g. `0.1.0-alpha.6`. */
  static readonly version: string = SDK_VERSION;

  /**
   * A small, fast, seeded random number generator: the same seed gives every player the same
   * sequence. `const rand = GameRelay.seededRandom(room.seed)`; `rand()` is in [0, 1).
   */
  static readonly seededRandom: (seed: number) => () => number = seededRandom;

  /** Your player id (stable across reloads of the same tab for anonymous players). */
  get playerId(): PlayerId {
    return this.#playerId;
  }

  /** The room you are in, if any. */
  get room(): Room | null {
    return this.#room;
  }

  /** Your party, if any. When its leader enters a room, every member follows. */
  get party(): PartyInfo | null {
    return this.#party;
  }

  /**
   * What this game's plan includes, from the server when you connect (all off until then). For
   * features that need a paid plan, such as voice chat, once they ship.
   * @experimental
   */
  get features(): Readonly<PlanFeatures> {
    return this.#features;
  }

  /**
   * What the server said about itself when this connection opened, for debugging.
   * @experimental
   */
  get serverInfo(): Readonly<ServerInfo> {
    return this.#serverInfo;
  }

  /** Per-player persisted key/value data. */
  readonly storage = Object.freeze({
    get: <T extends Json = Json>(key: string): Promise<T | null> =>
      this.#request({ t: 'kv_get', key }).then((d) => (d ?? null) as T | null),
    set: (key: string, value: Json): Promise<void> => this.#request({ t: 'kv_set', key, value }).then(() => undefined),
  });

  /** Per-game high score boards. Each player keeps their best score per board. */
  readonly leaderboard = Object.freeze({
    /** `order` is fixed by a board's first submit: `desc` (default) for points, `asc` for times. */
    submit: (board: string, score: number, options: { order?: LeaderboardOrder } = {}): Promise<LeaderboardSubmitResult> =>
      this.#request({ t: 'lb_submit', board, score, order: options.order }).then((d) => d as LeaderboardSubmitResult),
    top: (board: string, options: { limit?: number } = {}): Promise<LeaderboardPage> =>
      this.#request({ t: 'lb_top', board, limit: options.limit }).then((d) => d as LeaderboardPage),
  });

  #ws: WebSocket | null = null;
  /** This connection's frame key and sequence (signed frames); private so the console can't read it. */
  #frameKey: FrameKey | null = null;
  #frameSeq = 0;
  /** Recent clock samples (server time minus `monotonic()`); the one with the shortest round trip is the most accurate. */
  #clock: { offset: number; rtt: number }[] = [];
  #clockOffset = 0;
  /** The samples are from an older connection: the next one replaces them (the route may have changed). */
  #clockStale = false;
  /** When we last asked for a clock sample (performance.now()). */
  #sampledAt = Number.NEGATIVE_INFINITY;
  readonly #watchTimer: ReturnType<typeof setInterval>;
  /** When this socket last delivered anything (performance.now()). */
  #heardAt = 0;
  /** When the ping we're waiting on to hear back went out, if we are. */
  #probeAt: number | null = null;
  /** When `#watch` last ran: a long gap means our timers were frozen, not that the socket died. */
  #watchedAt = performance.now();
  #unwatchPage: () => void = () => {};
  readonly #opts: ConnectOptions;
  readonly #base: string;
  #token: { value: string; expiresAt: number } | null = null;
  /** Where the token response said to connect (`wsUrl`), if it said and it's `followable`. */
  #wsUrl: string | null = null;
  /**
   * Where a restart notice said to reconnect (its `url`): tried before `#wsUrl` until a connection
   * there fails or a later notice says otherwise. A failed connect to either falls back to `#base`.
   */
  #movedTo: string | null = null;
  /** The last connect to `#movedTo`/`#wsUrl` failed before welcome: the next one tries `#base`. */
  #fallBack = false;
  #rid = 0;
  readonly #pending = new Map<number, Pending>();
  /** Pings waiting for their pong, by `ts`: the rid they were sent with. */
  readonly #pongs = new Map<number, number>();
  readonly #expired = new Set<number>();
  #outbox: Outgoing[] = [];
  /**
   * While a join is waiting for its answer, what the current room queues (and what it had queued)
   * waits here: the server would handle it after the join, in the new room. A join that gets in
   * drops it, as the room it was for is closed; one that fails sends it, as we're still there.
   */
  #held: Outgoing[] | null = null;
  #entering = 0;
  /** The server's rate limit for this connection, charged as it charges (see `lanWithinRate`). */
  readonly #budget = new SendBudget(performance.now());
  #flushScheduled = false;
  #flushSoonScheduled = false;
  /** A flush waiting for the rate limit to pay for what's held (`#flush`). */
  #flushRetry: ReturnType<typeof setTimeout> | null = null;
  #attempts = 0;
  #reconnectHintMs: number | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** The code of the last reconnect failure reported through `error`: each new one once per outage. */
  #reported: string | null = null;
  #stopped = false;
  /** Everything stopped (`#shutdown`): close, replaced, too old, or a key the server refuses. */
  #shut = false;
  /** Fails the connect stage now waiting (the token, or the socket's welcome), if one is: `close()` uses it. */
  #abortOpen: ((err: GameRelayError) => void) | null = null;
  /** Between reconnecting and re-entering the room: room messages must wait. */
  #resuming = false;
  #lastRoomInfo: RoomInfo | null = null;
  /**
   * Who holds each slot of the room the server has us in, from what it sent (`CompactMessageMsg`).
   * Kept here, not in the Room: a batch can carry a join and messages before the Room exists.
   */
  #slots = new Map<number, PlayerId>();
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
  /** What this relay's rooms may ask of it (`internal.ts`). */
  readonly #link: RelayLink;

  private constructor(token: typeof CREATE, options: ConnectOptions) {
    if (token !== CREATE) throw new GameRelayError('bad_request', 'Use `await GameRelay.connect({ publicKey })`, not `new GameRelay()`');
    super();
    const opts = (options ?? {}) as ConnectOptions;
    this.#opts = opts;
    this.#base = (opts.url ?? defaults.url).replace(/\/$/, '');
    if (!opts.publicKey && !opts.getToken) throw new GameRelayError('bad_request', 'GameRelay.connect needs publicKey (your gr_pub_ key) or getToken');
    if (typeof opts.publicKey === 'string' && opts.publicKey.startsWith('gr_sk_')) throw secretKey();
    const relay = this;
    this.#link = {
      get connected() {
        return relay.connected;
      },
      get serverReady() {
        return relay.connected && !relay.#resuming;
      },
      get party() {
        return relay.#party;
      },
      get lanEnabled() {
        return relay.#p2p !== false;
      },
      get lanForceRelay() {
        const p2p = relay.#p2p;
        return typeof p2p === 'object' && p2p.forceRelay === true;
      },
      get lanDirect() {
        const p2p = relay.#p2p;
        return typeof p2p === 'object' && p2p.direct === 'party' ? 'party' : null;
      },
      queue: (m) => this.#queue(m),
      request: (m) => this.#request(m),
      now: () => this.now(),
      writeTime: () => this.#writeTime(),
      tick: (rate, fn) => this.tick(rate, fn),
      warn: (kind, key, message) => this.#warnings.warn(kind, key, message),
      newEntityId: (kind, owner) => this.#ids(kind, owner),
      lanWithinRate: () => this.#budget.allows(this.#outbox.length, performance.now()),
      left: (room) => {
        if (this.#room === room) this.#room = null;
      },
    };
    relays.set(this, this.#link);
    if (opts.simulate) {
      console.warn('[gamerelay] simulating a bad network', opts.simulate);
      this.#out = lane(opts.simulate);
      this.#in = lane(opts.simulate);
    }
    this.#ticker = new Ticker({
      schedule: pickScheduler(() =>
        this.#warn('worker', 'worker', "tick loop fell back to setInterval (a worker was blocked by the page's security settings); hidden tabs will tick slowly"),
      ),
    });
    this.#watchTimer = setInterval(() => this.#watch(), WATCH_MS);
    // Outside a browser (Bun, Node) the upkeep timer mustn't keep the process alive by itself.
    (this.#watchTimer as { unref?: () => void }).unref?.();
    const back = () => this.#pageBack();
    const shown = () => document.visibilityState === 'visible' && back();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', shown);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('online', back);
    this.#unwatchPage = () => {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', shown);
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('online', back);
    };
  }

  /** Connect to GameRelay. Rejects with a `GameRelayError` (check `err.code`) if it can't. */
  static async connect(options: ConnectOptions): Promise<GameRelay> {
    const relay = new GameRelay(CREATE, options);
    try {
      await relay.#open(false);
    } catch (err) {
      relay.#shutdown();
      throw err;
    }
    if (options.debug) relay.#startDebug();
    return relay;
  }

  /** Player to player (`p2p`, or its old name `lan`). */
  get #p2p(): P2POptions | undefined {
    return this.#opts.p2p ?? this.#opts.lan;
  }

  get connected(): boolean {
    return this.#ws?.readyState === 1 && this.#frameKey !== null;
  }

  /** Subscribe to a connection event; returns an unsubscribe function. */
  override on<K extends keyof RelayEvents>(event: K, handler: RelayEvents[K]): () => void {
    const name: string = event;
    if (!RELAY_EVENTS.has(name)) {
      const where = ROOM_EVENTS.has(name) || ['host', 'spawn', 'remove', 'timer'].includes(name) ? `; it's a room event: room.on('${event}', …)` : '';
      this.#warnings.warn('event_name', `relay_event:${event}`, `relay.on('${event}') never fires: relay events are ${[...RELAY_EVENTS].filter((e) => e !== 'room').join(', ')}${where}`);
    }
    return super.on(event, handler);
  }

  /**
   * A new room, with you in it. `public`: listed by `listRooms` and open to quick match. `linkOnly`:
   * joined by its invite link (`room.inviteUrl()`) only, not by its code, so nobody gets in by
   * guessing one; players with a seat can still come back by code (a reload).
   */
  createRoom(options: CreateRoomOptions = {}): Promise<Room> {
    return this.#enter({ t: 'create_room', maxPlayers: options.maxPlayers, public: options.public, linkOnly: options.linkOnly || undefined, tag: options.tag });
  }
  joinRoom(code: string): Promise<Room> {
    return this.#enter({ t: 'join_room', code: code.trim().toUpperCase() });
  }
  /**
   * Join the room a short link is for (`room.shareLink()`; `link` is its id, `ZumXpZzDsgo`). A
   * link-only room is joined this way. Rejects with `room_not_found` once the room has closed.
   */
  joinLink(link: string): Promise<Room> {
    return this.#enter({ t: 'join_link', link: link.trim() }, link.trim());
  }
  /**
   * Join the room in an invite: a short link's `?join=<link>` (`room.shareLink()`) or an invite
   * link's `?room=CODE` (`room.inviteUrl()`), or resolve `null` if the page has neither. Rejects
   * like `joinRoom` when the room is gone or full.
   */
  async joinInvite(url?: string): Promise<Room | null> {
    const params = new URL(url ?? pageUrl()).searchParams;
    const link = params.get(LINK_PARAM)?.trim();
    if (link) return this.joinLink(link);
    const code = params.get(INVITE_PARAM)?.trim();
    return code ? this.joinRoom(code) : null;
  }
  /** Join the oldest open public room, or create one. */
  quickMatch(options: RoomOptions = {}): Promise<Room> {
    return this.#enter({ t: 'quick_match', maxPlayers: options.maxPlayers, tag: options.tag });
  }

  /**
   * The usual start, in one call: join the room in the page's invite link (`?room=` or `?join=`);
   * if there's none, or that room has closed, quick-match (or, with `private`, create a room that
   * isn't listed or quick-matched: friends join with its code or invite). A full, locked or banning room still rejects (`room_full`, `locked`,
   * `banned`): say so to the player. `updateUrl` writes the room's invite into the address bar.
   * @experimental
   */
  async joinOrCreate(options: JoinOrCreateOptions = {}): Promise<Room> {
    const { maxPlayers, tag } = options;
    let room: Room | null = null;
    if (typeof location !== 'undefined') {
      room = await this.joinInvite().catch((err: unknown) => {
        if (err instanceof GameRelayError && err.code === 'room_not_found') return null;
        throw err;
      });
    }
    room ??= options.private ? await this.createRoom({ maxPlayers, tag }) : await this.quickMatch({ maxPlayers, tag });
    if (options.updateUrl && typeof history !== 'undefined' && typeof location !== 'undefined') {
      history.replaceState(history.state, '', room.inviteUrl());
    }
    return room;
  }

  /**
   * Public rooms with free seats, oldest first (up to 50). `includeFull` adds full and locked ones,
   * for a server browser: each listing's `players`, `maxPlayers` and `locked` say which.
   * `listRooms({ tag, includeFull })`, or the older `listRooms(tag, { includeFull })`.
   */
  async listRooms(options?: ListRoomsOptions): Promise<RoomListing[]>;
  async listRooms(tag?: string, options?: { includeFull?: boolean }): Promise<RoomListing[]>;
  async listRooms(a?: string | ListRoomsOptions, b: { includeFull?: boolean } = {}): Promise<RoomListing[]> {
    const { tag, includeFull } = typeof a === 'object' && a !== null ? a : { tag: a, includeFull: b.includeFull };
    return ((await this.#request({ t: 'list_rooms', tag, includeFull: includeFull || undefined })) ?? []) as RoomListing[];
  }

  /** How many players are online in this game right now (everyone connected, in a room or not). */
  async online(): Promise<{ players: number }> {
    const data = (await this.#request({ t: 'online' })) as { players?: number } | undefined;
    return { players: data?.players ?? 0 };
  }

  /** Start a party; share `party.code` with friends. */
  async createParty(): Promise<PartyInfo> {
    await this.#request({ t: 'party_create' });
    return this.#party as PartyInfo;
  }
  async joinParty(code: string): Promise<PartyInfo> {
    await this.#request({ t: 'party_join', code: code.trim().toUpperCase() });
    return this.#party as PartyInfo;
  }
  async leaveParty(): Promise<void> {
    await this.#request({ t: 'party_leave' });
  }

  /** Round-trip time in ms. */
  async ping(): Promise<number> {
    const start = monotonic();
    this.#sampledAt = performance.now();
    // Pongs are matched by `ts`, so concurrent pings in the same millisecond need distinct ones.
    let ts = Math.floor(start);
    while (this.#pongs.has(ts)) ts++;
    const serverTime = await this.#request({ t: 'ping', ts });
    const rtt = monotonic() - start;
    this.#lastRtt = rtt;
    if (typeof serverTime === 'number') this.#clockSample(serverTime - (start + rtt / 2), rtt);
    return rtt;
  }

  /**
   * The server's clock (ms since the epoch), estimated from pings: use it to place messages
   * (`meta.at`) and state on one shared timeline, e.g. to render others slightly in the past.
   */
  now(): number {
    return monotonic() + this.#clockOffset;
  }

  /**
   * Run `fn` at a fixed rate (1–240 per second) with a constant `dt` in seconds, on a timer that
   * keeps going in hidden tabs. Use it for game logic; keep drawing in requestAnimationFrame.
   * Returns a function that stops the loop.
   */
  tick(rate: number, fn: (dt: number, tick: number) => void): () => void {
    if (this.#shut) throw new GameRelayError('disconnected', 'relay.tick: this connection was closed; connect again (GameRelay.connect) and tick on the new one');
    return this.#ticker.add(rate, (dt, tick) => {
      try {
        fn(dt, tick);
      } finally {
        this.#flushSoon();
      }
    });
  }

  /** The server-clock moment of the running `tick` step (see `SyncTransport.writeTime`), else now. */
  #writeTime(): number {
    const at = this.#ticker.stepTime();
    return at === null ? this.now() : this.now() - (performance.now() - at);
  }

  #warn(kind: WarningKind, key: string, message: string): void {
    this.#warnings.warn(kind, key, message);
  }

  #startDebug(): void {
    let last = { ...this.#stats, at: Date.now() };
    this.#unmountOverlay = mountOverlay((): OverlayStats => {
      const now = Date.now();
      const secs = Math.max(0.001, (now - last.at) / 1000);
      const rate = (k: 'msgsIn' | 'msgsOut' | 'bytesIn' | 'bytesOut') => Math.round((this.#stats[k] - last[k]) / secs);
      const info = this.#roomControl()?.debugInfo() ?? { delayMs: 0, entities: {}, lan: undefined };
      const stats: OverlayStats = {
        ping: this.#lastRtt,
        delayMs: info.delayMs,
        entities: info.entities,
        msgsIn: rate('msgsIn'),
        msgsOut: rate('msgsOut'),
        bytesIn: rate('bytesIn'),
        bytesOut: rate('bytesOut'),
        host: this.#room?.isHost ?? false,
        lan: info.lan,
        warnings: this.#warnings.list(),
      };
      last = { ...this.#stats, at: now };
      return stats;
    });
    this.#debugPing = setInterval(() => void this.ping().catch(() => {}), 2000);
  }

  /**
   * Disconnect for good: your room closes (`closed` with `'left'`), whatever was waiting rejects
   * with `disconnected`, and every timer stops. To play again, `GameRelay.connect` anew.
   */
  close(): void {
    this.#shutdown('left');
  }

  /**
   * The one way everything stops (`close()`, `replaced`, an SDK too old, a key the server refuses):
   * the room closes with `reason`, pending calls reject, and no timer or listener is left running.
   */
  #shutdown(reason: 'left' | 'lost' = 'lost'): void {
    if (this.#shut) return;
    this.#shut = true;
    this.#stopped = true;
    const room = this.#room;
    this.#room = null;
    // A connect waiting for its welcome fails now, not never.
    this.#abortOpen?.(new GameRelayError('disconnected', 'This connection was closed'));
    const ws = this.#ws;
    this.#ws = null;
    if (ws) attempt(() => ws.close(1000));
    this.#frameKey = null;
    this.#ticker.stop();
    this.#unmountOverlay?.();
    if (this.#debugPing) clearInterval(this.#debugPing);
    clearInterval(this.#watchTimer);
    if (this.#flushRetry) clearTimeout(this.#flushRetry);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#flushRetry = this.#reconnectTimer = null;
    this.#outbox = [];
    this.#held = null;
    this.#unwatchPage();
    this.#failPending();
    // Last, with the connection gone: a `closed` handler that calls the relay is told it's closed.
    if (room) rooms.get(room)?.close(reason);
  }

  #roomControl(): RoomControl | undefined {
    return this.#room ? rooms.get(this.#room) : undefined;
  }

  // ---------------------------------------------------------------------------

  #queue(message: Outgoing): void {
    if (this.#shut) return;
    if (this.#held) return void this.#held.push(message);
    this.#outbox.push(message);
    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      nextFrame(() => this.#flush());
    }
  }

  /** `then`: runs on the reply as it is handled, before the rest of its batch; its result is what resolves. */
  #request(message: Request): Promise<Json | undefined>;
  #request<T>(message: Request, then: (data: Json | undefined) => T): Promise<T>;
  #request(message: Request, then?: (data: Json | undefined) => unknown): Promise<unknown> {
    if (!this.connected) return Promise.reject(new GameRelayError('disconnected', this.#shut ? 'This connection was closed; connect again' : 'Not connected'));
    // What was queued first goes first, leaving the budget a token for the request itself.
    if (!this.#resuming) this.#flush(1);
    const rid = ++this.#rid;
    return new Promise((done, reject) => {
      const resolve = (data: Json | undefined) => {
        if (!then) return done(data);
        try {
          done(then(data));
        } catch (err) {
          reject(err);
        }
      };
      const timer = setTimeout(() => {
        if (!this.#settle(rid, () => {})) return;
        // Its answer may still come: drop it then, as nobody is waiting for it any more.
        this.#expired.add(rid);
        if (this.#expired.size > MAX_EXPIRED) this.#expired.delete(this.#expired.values().next().value!);
        reject(new GameRelayError('timeout', `No answer from the server in ${REPLY_TIMEOUT_MS / 1000} s (${message.t}); try again`));
      }, REPLY_TIMEOUT_MS);
      // `ping` is answered by `ts` (a pong), everything else by `rid`; errors carry the rid for both.
      const ts = message.t === 'ping' ? Number(message.ts) : undefined;
      this.#pending.set(rid, { resolve, reject, timer, ts });
      if (ts !== undefined) this.#pongs.set(ts, rid);
      this.#raw({ ...message, v: V, rid });
    });
  }

  #clockSample(offset: number, rtt: number): void {
    const best = this.#clock.reduce<{ offset: number; rtt: number } | null>((b, c) => (!b || c.rtt < b.rtt ? c : b), null);
    // Each sample puts the true offset within half its round trip. One that can't agree with the
    // best one means a clock moved (ours stops in some sleeps): the old samples are wrong now.
    if (this.#clockStale || (best && Math.abs(offset - best.offset) > (rtt + best.rtt) / 2 + 2)) this.#clock = [];
    this.#clockStale = false;
    this.#clock = [...this.#clock, { offset, rtt }].slice(-CLOCK_SAMPLES);
    this.#clockOffset = this.#clock.reduce((b, c) => (c.rtt < b.rtt ? c : b)).offset;
  }

  /** Once a second: notice a dead socket, and keep the clock fresh. */
  #watch(): void {
    const now = performance.now();
    const frozen = now - this.#watchedAt > 2.5 * WATCH_MS;
    this.#watchedAt = now;
    if (!this.connected) return;
    if (this.#probeAt !== null && this.#heardAt >= this.#probeAt) this.#probeAt = null;
    if (this.#probeAt !== null) {
      // Our timers were frozen or throttled (a hidden or suspended page): its answer may be queued
      // behind us, so the wait starts over rather than ending.
      if (frozen) this.#probe();
      else if (now - this.#probeAt >= PROBE_TIMEOUT_MS) this.#dropSocket();
      return;
    }
    if (now - this.#heardAt >= PROBE_IDLE_MS || now - this.#sampledAt >= CLOCK_RESAMPLE_MS) this.#probe();
  }

  /** Ping, and give up on the socket if nothing at all comes back in time (`#watch`). */
  #probe(): void {
    if (!this.connected) return;
    this.#probeAt = performance.now();
    void this.ping().catch(() => {});
  }

  /**
   * The page came back (shown again, or back online): the network may have changed while it was
   * away, and the clock may have stopped. Check both now rather than after 5 s of silence.
   */
  #pageBack(): void {
    this.#probe();
  }

  /**
   * `link`: the short link's id, when that's how we got in (`joinLink`). The Room is made as the
   * reply is handled, not after an await: the server sends the reply and the room's next messages
   * in one batch, and those are for the new Room, not the old one or none. Their effects (state,
   * players, entities) land; their events fire before the game has the Room to listen on, as they
   * would for anything that happened before it joined.
   */
  #enter(message: Request, link?: string): Promise<Room> {
    const entering = this.#request(message, (data) => {
      const info = this.#lastRoomInfo;
      if (!info || typeof data !== 'object' || data === null || Array.isArray(data) || info.id !== data.roomId) {
        throw new GameRelayError('internal', 'Room snapshot missing');
      }
      this.#entered(true);
      const old = this.#room;
      // The new Room first: if making it throws, the old one is still ours.
      const room = this.#adopt(info, link);
      // Leaving a room closes it; re-entering the same one replaces the object, so stop the old one's loop.
      if (old && old.id !== info.id) rooms.get(old)?.close('left', undefined, true);
      else if (old) rooms.get(old)?.dispose();
      return room;
    });
    // After #request sent the join (and flushed what it could before it): the rest waits.
    if (this.#entering++ === 0 && this.connected) {
      this.#held = this.#outbox;
      this.#outbox = [];
    }
    return entering.catch((err: unknown) => {
      this.#entered(false);
      throw err;
    });
  }

  /** A join got its answer: `inside`, it got in (what was held was for the room we left). */
  #entered(inside: boolean): void {
    if (this.#entering === 0) return;
    if (--this.#entering > 0 && !inside) return;
    const held = this.#held ?? [];
    this.#held = null;
    if (inside) return;
    this.#entering = 0;
    for (const m of held) this.#queue(m);
  }

  /**
   * The Room for the room the server has us in. Its short link is asked for now, in a page or for
   * a link-only room (whose invite it is), without waiting: the game gets the room at once, so it
   * hears every event. shareInvite() must share in the tap that asks for it (iOS refuses a share or
   * a copy that waits on the network first).
   */
  #adopt(info: RoomInfo, link?: string): Room {
    const room = (this.#room = new Room(CREATE, this.#link, info, this.#playerId, link));
    // A microtask later: this runs while a batch is handled, and asking flushes the outbox, which
    // should wait for the batch's own messages.
    if (typeof location !== 'undefined' || (room.linkOnly && !link)) queueMicrotask(() => void room.shareLink().catch(() => {}));
    return room;
  }

  /**
   * What a `tick` step queued goes out when this wake's steps are done, not on the next animation
   * frame (up to a frame later). A microtask runs after every loop due in the wake, the room's own
   * included, so their sends still share one frame.
   */
  #flushSoon(): void {
    if (this.#flushSoonScheduled || this.#outbox.length === 0) return;
    this.#flushSoonScheduled = true;
    queueMicrotask(() => {
      this.#flushSoonScheduled = false;
      this.#flush();
    });
  }

  /** Send the outbox. `reserve`: budget tokens to leave for a frame about to follow (a request). */
  #flush(reserve = 0): void {
    this.#flushScheduled = false;
    if (!this.connected || this.#resuming) {
      // Keep reliable messages for after the reconnect; drop the rest.
      this.#outbox = this.#trim(this.#outbox.filter((m) => !(m.t === 'send' && m.r === false)), MAX_QUEUED);
      return;
    }
    const loss = this.#opts.simulate?.loss ?? 0;
    let items = this.#outbox.filter((m) => !(loss && m.t === 'send' && m.r === false && Math.random() < loss));
    this.#outbox = [];
    // The server drops a frame it can't pay for whole, so send only what the budget covers. What a
    // later message replaces goes first, newest first (those were queued with no budget, so they
    // have no LAN copy out); the reliable rest waits, in order, for the budget to refill.
    const left = Math.max(0, Math.floor(this.#budget.left(performance.now())) - reserve);
    if (items.length > left) {
      let extra = items.length - left;
      for (let i = items.length - 1; i >= 0 && extra > 0; i--) {
        if (!this.#isReplaceable(items[i]!)) continue;
        items.splice(i, 1);
        extra--;
      }
      this.#outbox = this.#trim(items.slice(left), MAX_QUEUED);
      items = items.slice(0, left);
    }
    // Batch by count and by size: the server rejects frames over its message limit. Each message
    // is written once, as text, and the batch is put together from those (as the server's outbox does).
    let chunk: string[] = [];
    let size = 0;
    const send = () => {
      if (chunk.length > 0) this.#rawText(chunk.length === 1 ? chunk[0]! : `${BATCH_OPEN}${chunk.join(',')}]}`, chunk.length);
      chunk = [];
      size = 0;
    };
    for (const m of items) {
      const text = batchItem(m);
      const n = utf8Length(text) + 1;
      if (chunk.length >= MAX_BATCH || (chunk.length > 0 && size + n > MAX_FRAME_BYTES)) send();
      chunk.push(text);
      size += n;
    }
    send();
    if (this.#outbox.length > 0 && !this.#flushRetry) {
      // Come back when the budget pays for what's held (a frame's worth at most).
      const need = Math.min(this.#outbox.length, MAX_BATCH) - this.#budget.left(performance.now());
      this.#flushRetry = setTimeout(() => {
        this.#flushRetry = null;
        this.#flush();
      }, Math.max(0, Math.ceil((need * 1000) / PACE_PER_SECOND)));
    }
  }

  /**
   * `items` cut to `max`: first what a later message replaces, oldest first, and only then the
   * oldest of the rest, which nothing will make up for.
   */
  #trim(items: Outgoing[], max: number): Outgoing[] {
    let extra = items.length - max;
    if (extra <= 0) return items;
    const kept: Outgoing[] = [];
    for (const m of items) {
      if (extra > 0 && this.#isReplaceable(m)) extra--;
      else kept.push(m);
    }
    return kept.slice(-max);
  }

  /** Unreliable sends (plain entity updates among them: the next one carries newer values) and heartbeats. */
  #isReplaceable(m: Outgoing): boolean {
    return (m.t === 'send' && m.r === false) || m.t === 'heartbeat';
  }

  /** One message (batches go out through `#flush`, as text). */
  #raw(message: unknown): void {
    this.#rawText(JSON.stringify(message), 1);
  }

  /** Send `text`, one message or a batch of `count`, as a signed frame. */
  #rawText(text: string, count: number): void {
    const ws = this.#ws;
    if (!ws || !this.#frameKey) return;
    const frame = signFrame(this.#frameKey, ++this.#frameSeq, text);
    this.#stats.msgsOut++;
    this.#stats.bytesOut += frame.length;
    this.#budget.sent(count, performance.now());
    if (this.#out) this.#out(() => ws.readyState === 1 && ws.send(frame));
    else ws.send(frame);
  }

  async #getToken(reconnecting: boolean): Promise<string> {
    if (this.#opts.getToken) {
      let got: string | TokenResponse;
      try {
        // The first connect waits for your game (a sign-in may come first); a reconnect, nobody
        // waits on, is bounded, or a backend that hangs would keep it from ever trying again.
        got = await this.#tokenStage('getToken', (signal) => this.#opts.getToken!(signal), reconnecting);
      } catch (err) {
        if (err instanceof GameRelayError) throw err;
        // Your backend failed (maybe for a moment): connect rejects, a reconnect tries again.
        throw new GameRelayError('disconnected', `getToken failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      const token = typeof got === 'string' ? got : got?.token;
      if (typeof token !== 'string' || !token) throw new GameRelayError('unauthorized', 'getToken must return a token, or the response of POST /v1/auth/token');
      if (token.startsWith('gr_sk_')) throw secretKey();
      if (typeof got === 'object') this.#wsUrl = this.#checked(got.wsUrl);
      return token;
    }
    if (this.#token && this.#token.expiresAt - Date.now() > 60_000) return this.#token.value;
    const storeKey = `gamerelay:${this.#opts.publicKey}`;
    const { res, body } = await this.#tokenStage(this.#base, async (signal) => {
      try {
        const res = await fetch(`${this.#base}/v1/auth/anonymous`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publicKey: this.#opts.publicKey,
            playerName: this.#opts.playerName,
            playerAvatar: this.#opts.playerAvatar,
            previousToken: this.#token?.value ?? session.get(storeKey) ?? undefined,
          }),
          signal,
        });
        // A proxy error page isn't JSON: treat it like any other failed response.
        const parsed: unknown = await res.json().catch(() => null);
        const body: { token?: string; expiresAt?: number; wsUrl?: string; error?: string; message?: string } = parsed && typeof parsed === 'object' ? parsed : {};
        return { res, body };
      } catch (err) {
        // Offline, DNS or CORS: not the key's fault, so a reconnect tries again.
        throw new GameRelayError('disconnected', `Can't reach ${this.#base}: are you online?`, { cause: err });
      }
    }, true);
    if (!res.ok || !body.token || !body.expiresAt) {
      throw new GameRelayError(authCode(res.status, body.error), body.message ?? `Auth failed (${res.status})`);
    }
    this.#token = { value: body.token, expiresAt: body.expiresAt };
    session.set(storeKey, body.token);
    this.#wsUrl = this.#checked(body.wsUrl);
    return body.token;
  }

  /**
   * The token step of a connect: `run` (your `getToken`, or our request to `who`) fails with
   * `disconnected` if `close()` is called meanwhile and, if `bounded`, with `timeout` if it hasn't
   * answered in `CONNECT_TIMEOUT_MS` (a backend that hangs would otherwise hang a reconnect for
   * good). Either way `signal` aborts (a fetch stops), and a late answer is ignored.
   */
  #tokenStage<T>(who: string, run: (signal: AbortSignal) => Promise<T>, bounded: boolean): Promise<T> {
    const abort = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#abortOpen === stop) this.#abortOpen = null;
        fn();
      };
      const stop = (err: GameRelayError) =>
        settle(() => {
          abort.abort();
          reject(err);
        });
      const timer = bounded ? setTimeout(() => stop(new GameRelayError('timeout', `No answer from ${who} in ${CONNECT_TIMEOUT_MS / 1000} s`)), CONNECT_TIMEOUT_MS) : undefined;
      this.#abortOpen = stop;
      Promise.resolve()
        .then(() => run(abort.signal))
        .then(
          (v) => settle(() => resolve(v)),
          (err: unknown) => settle(() => reject(err)),
        );
    });
  }

  /** A server notice for the developer (an old SDK, …): once per code, through the warning catalog. */
  #notice(notice: Notice): void {
    if (!notice || typeof notice.message !== 'string') return;
    const text = notice.message.replace(/[.!?]\s*$/, '');
    const until = notice.until ? ` (until ${notice.until})` : '';
    const more = notice.url ? ` More: ${notice.url}` : '';
    this.#warn('notice', `notice:${typeof notice.code === 'string' ? notice.code : notice.message}`, `${text}${until}.${more}`);
  }

  /** `url` if the SDK may connect there (`followable`), else null (with a warning when there was one). */
  #checked(url: string | undefined): string | null {
    if (typeof url !== 'string' || !url) return null;
    if (followable(url, this.#base)) return url;
    this.#warn('notice', `host:${url}`, `the server pointed this game at ${url}, which isn't a GameRelay host; staying on ${this.#base}`);
    return null;
  }

  async #open(reconnecting: boolean): Promise<void> {
    const token = await this.#getToken(reconnecting);
    // close() may have been called while a reconnect waited on the token.
    if (this.#stopped) throw new GameRelayError('disconnected', 'Closed');
    // Who we are (`sdk`) and what we understand (`caps`, @gamerelay/protocol/clients): `compact`,
    // relayed messages in their short form; `lan`, the shortcut's wire format (the server unwraps it
    // for SDKs that don't know it); `moved`, a restart notice's `url`; `notices`, shown in the console.
    const caps = ['compact', ...(this.#link.lanEnabled ? ['lan'] : []), 'moved', 'notices'].join(',');
    const base = `${this.#base.replace(/^http/, 'ws')}/ws`;
    const target = this.#fallBack ? base : (this.#movedTo ?? this.#wsUrl ?? base);
    this.#fallBack = false;
    // `compact=1` and `lan=1` too, for servers from before `caps` (until alpha.7).
    const url = `${target}?token=${encodeURIComponent(token)}&sdk=js/${encodeURIComponent(SDK_VERSION)}&caps=${caps}&compact=1${this.#link.lanEnabled ? '&lan=1' : ''}`;
    await new Promise<void>((resolveOpen, rejectOpen) => {
      let late: ReturnType<typeof setTimeout> | undefined;
      const resolve = () => {
        this.#abortOpen = null;
        resolveOpen();
      };
      const reject = (err: GameRelayError) => {
        this.#abortOpen = null;
        clearTimeout(late);
        rejectOpen(err);
      };
      this.#abortOpen = reject;
      const ws = new WebSocket(url, 'gamerelay.v1.json');
      this.#ws = ws;
      this.#frameKey = null;
      this.#frameSeq = 0;
      this.#heardAt = performance.now();
      this.#probeAt = null;
      let welcomed = false;
      // No welcome in time (a socket stuck connecting): give up on it, as if it had closed.
      late = setTimeout(() => {
        if (welcomed || this.#ws !== ws) return;
        this.#ws = null;
        attempt(() => ws.close());
        this.#token = null;
        if (target !== base) {
          this.#fallBack = true;
          this.#movedTo = null;
        }
        reject(new GameRelayError('timeout', `No answer from ${target} in ${CONNECT_TIMEOUT_MS / 1000} s`));
      }, CONNECT_TIMEOUT_MS);
      const receive = (ev: MessageEvent) => {
        // (A delayed message can arrive after its socket was replaced.)
        if (this.#ws !== ws) return;
        this.#heardAt = performance.now();
        this.#stats.msgsIn++;
        this.#stats.bytesIn += String(ev.data).length;
        const msg = attempt(() => JSON.parse(String(ev.data)) as ServerMessage | null);
        if (!msg) return;
        if (msg.t === 'welcome') {
          welcomed = true;
          clearTimeout(late);
          // The server made this connection's bucket before it said welcome, and nothing is sent
          // before it (frames are signed with its key), so ours starts now and never runs ahead.
          this.#budget.reset(performance.now());
          this.#playerId = msg.playerId;
          // An older server sends no features: everything stays off.
          if (msg.features) this.#features = Object.freeze({ ...this.#features, ...msg.features });
          this.#serverInfo = Object.freeze({ version: msg.server ?? null });
          for (const notice of msg.notices ?? []) this.#notice(notice);
          this.#frameKey = unmaskKey(msg.k, msg.playerId);
          // A rough clock until the pings below (and any the game sends) refine it. The old samples
          // stay in use until then, so the clock doesn't jump back to this rough one.
          if (this.#clock.length === 0) this.#clockOffset = msg.serverTime - monotonic();
          this.#clockStale = true;
          resolve();
          for (const delay of [0, 1_000, 3_000]) setTimeout(() => void this.ping().catch(() => {}), delay);
        }
        this.#handle(msg);
      };
      ws.onmessage = (ev) => (this.#in ? this.#in(() => receive(ev)) : receive(ev));
      ws.onclose = (ev) => {
        if (this.#ws !== ws) return;
        this.#ws = null;
        clearTimeout(late);
        if (!welcomed) {
          if (ev.code === CLOSE.upgradeRequired) {
            // Too old for this server (its `upgrade_required` error came first, as an `error`
            // event): retrying can't help, so stop instead of reconnecting forever.
            reject(new GameRelayError('upgrade_required', 'This version of the GameRelay SDK is no longer accepted: load https://gamerelay.io/sdk/v0/gamerelay.js or update @gamerelay/sdk'));
            this.#shutdown();
            return;
          }
          this.#token = null; // maybe expired/revoked: mint a fresh one next time
          // A host the server sent us to that doesn't answer: once back to the base URL, and
          // forget a restart notice's host (the token's `wsUrl` comes back with the next token).
          if (target !== base) {
            this.#fallBack = true;
            this.#movedTo = null;
          }
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
    if (code === CLOSE.upgradeRequired) return this.#shutdown();
    if (code === CLOSE.replaced) {
      // Another tab took over: this one stops (its p2p copies would speak for the new one). The
      // game hears why first, then its room's `closed` ('lost').
      this.#stopped = true;
      this.fire('replaced');
      return this.#shutdown();
    }
    this.fire('disconnected');
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const backoff = Math.min(10_000, 250 * 2 ** this.#attempts) * (0.5 + Math.random() / 2);
    // A restart drops every player at once: spread them over 0.5–1.5× the server's hint, or they
    // would all come back in the same millisecond.
    const hint = this.#reconnectHintMs;
    const delay = hint === null ? backoff : hint * (0.5 + Math.random());
    this.#reconnectHintMs = null;
    this.#attempts++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#reconnect();
    }, delay);
  }

  async #reconnect(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#open(true);
    } catch (err) {
      if (this.#stopped) return; // closed meanwhile, or too old (`#open` stopped everything)
      const code = err instanceof GameRelayError ? err.code : 'disconnected';
      // Why it can't get back in, once per reason: a game showing "Reconnecting…" can say more.
      if (code !== 'disconnected' && code !== 'timeout' && code !== this.#reported) {
        this.#reported = code;
        this.fire('error', err as GameRelayError);
      }
      // A rotated key or a deleted game: no retry will work, so stop (the room closes as lost).
      if (FINAL_CODES.has(code)) return this.#shutdown();
      return this.#scheduleReconnect();
    }
    this.#attempts = 0;
    this.#reported = null;
    // Hold queued room messages until we are back in the party and room.
    this.#resuming = true;
    // A 'disconnected' failure means the connection dropped again, and a 'timeout' that it went
    // quiet: keep the party and room for the next attempt instead of treating them as gone.
    let silent = false;
    const gone = (err: GameRelayError) => {
      if (err.code === 'timeout') silent = true;
      return err.code !== 'disconnected' && err.code !== 'timeout';
    };
    try {
      const party = this.#party;
      if (party) await this.#request({ t: 'party_join', code: party.code }).catch((err) => gone(err) && this.#setParty(null));
      const room = this.#room;
      if (room) {
        // `resume`: if we were kicked while away, the server says so (`removed`) instead of seating us afresh.
        await this.#request({ t: 'join_room', code: room.code, resume: true }).catch((err) => {
          if (!gone(err)) return;
          if (this.#room !== room) return; // closed already (kicked, or the game moved on)
          this.#room = null;
          rooms.get(room)?.close('lost');
        });
      }
    } finally {
      this.#resuming = false;
    }
    if (silent) this.#dropSocket(); // the server never answered: try again on a new socket
    if (!this.connected) return; // dropped mid-resume; the scheduled reconnect takes over
    this.#flush();
    this.fire('reconnected');
  }

  /**
   * Give up on this socket now and reconnect as if it had closed. A socket that went dead (a network
   * switch, a sleeping laptop) can take minutes to report its close, and the seat's grace may run out
   * first, so we don't wait for its close event (it's ignored when it comes).
   */
  #dropSocket(): void {
    const ws = this.#ws;
    if (!ws) return;
    this.#ws = null;
    attempt(() => ws.close());
    this.#onDisconnect(1006);
  }

  /**
   * A player joined or left the room the server has us in. Before its Room exists (we're still
   * between the room's snapshot and the join's reply), the Room will be made from `#lastRoomInfo`, so
   * that is kept up to date too.
   */
  #seat(msg: Extract<ServerMessage, { t: 'player_joined' | 'player_left' }>): void {
    const info = this.#lastRoomInfo;
    const pending = info !== null && this.#room?.id !== info.id;
    if (msg.t === 'player_joined') {
      this.#slots.set(msg.player.slot, msg.player.id);
      if (pending) info.players = [...info.players.filter((p) => p.id !== msg.player.id), msg.player];
    } else {
      for (const [slot, id] of this.#slots) if (id === msg.playerId) this.#slots.delete(slot);
      if (pending) info.players = info.players.filter((p) => p.id !== msg.playerId);
    }
  }

  #setParty(party: PartyInfo | null): void {
    this.#party = party;
    this.#roomControl()?.lanPartyChanged();
    this.fire('party', party);
  }

  #failPending(): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#pongs.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new GameRelayError('disconnected', 'Connection lost'));
    }
  }

  #settle(rid: number, fn: (p: Pending) => void): boolean {
    const p = this.#pending.get(rid);
    if (!p) return false;
    this.#pending.delete(rid);
    if (p.ts !== undefined) this.#pongs.delete(p.ts);
    clearTimeout(p.timer);
    fn(p);
    return true;
  }

  #handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'batch':
        for (const m of msg.m) this.#handle(m);
        return;
      case 'm': {
        // The short form names the sender by slot; the server said who holds it before this.
        const from = this.#slots.get(msg.s);
        if (from === undefined) return; // (a server bug: it names every slot's holder first)
        return this.#handle({ v: V, t: 'message', from, d: msg.d, at: msg.at });
      }
      case 'player_joined':
      case 'player_left':
        this.#seat(msg);
        this.#roomControl()?.handle(msg);
        return;
      case 'welcome':
        return;
      case 'reply':
        this.#settle(msg.rid, (p) => p.resolve(msg.data));
        return;
      case 'pong':
        this.#settle(this.#pongs.get(msg.ts) ?? 0, (p) => p.resolve(msg.serverTime));
        return;
      case 'error': {
        const err = new GameRelayError(msg.code, msg.message);
        if (msg.code === 'rate_limited') {
          this.#warn('rate_limited', 'rate_limited', 'the server dropped messages: this player sent more than 120 per second; send less often (check emit and setState rates)');
          this.#roomControl()?.lanPause();
        }
        if (msg.rid !== undefined && (this.#settle(msg.rid, (p) => p.reject(err)) || this.#expired.has(msg.rid))) return;
        this.fire('error', err);
        return;
      }
      case 'notice':
        this.#notice(msg.notice);
        return;
      case 'server_restarting':
        this.#reconnectHintMs = msg.reconnectInMs;
        // Somewhere else to reconnect (another region, a server being drained), same token and seat;
        // a notice without one means back to where the token said.
        this.#movedTo = this.#checked(msg.url);
        this.fire('server_restarting');
        return;
      case 'room':
        this.#lastRoomInfo = msg.room;
        this.#slots = new Map(msg.room.players.map((p) => [p.slot, p.id]));
        if (this.#room?.id === msg.room.id) this.#roomControl()?.sync(msg.room);
        return;
      case 'party':
        return this.#setParty(msg.party);
      case 'removed': {
        // Kicked or closed by the owner: forget the room so a reconnect doesn't try to rejoin it.
        const room = this.#room;
        if (!room || room.id !== msg.roomId) return;
        this.#room = null;
        rooms.get(room)?.close(msg.reason, msg.message);
        return;
      }
      case 'party_room': {
        const info = this.#lastRoomInfo;
        if (!info || info.id !== msg.roomId) return;
        // As in #enter: the new Room first, then the old one closed now with its `closed` fired
        // once this batch is handled; the new room's events after that, as before.
        const old = this.#roomControl();
        const room = this.#adopt(info);
        old?.close('left', undefined, true);
        queueMicrotask(() => {
          this.fire('party_room', room);
          this.fire('room', room);
        });
        return;
      }
      default:
        this.#roomControl()?.handle(msg);
    }
  }
}

export class Room extends Emitter<RoomEvents> {
  readonly #id: string;
  readonly #code: string;
  readonly #me: PlayerId;
  #maxPlayers: number;
  #hostId: PlayerId;
  #players: PlayerInfo[];
  #state: JsonObject;
  /** `#state`'s top level as the SDK last set it, to notice the game writing to it (`#checkState`). */
  #stateSeen: { of: JsonObject; values: Map<string, Json> } | null = null;
  #chatHistory: ChatMessage[];
  #seed: number;

  readonly #relay: RelayLink;
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
  readonly #lan: Lan;
  /** When we last asked for this room's relay credentials (`#fetchIce`), and whether we have any. */
  #iceAt = 0;
  #iceHave = false;
  /** The owner allows direct connections between party members (the `turn` reply's `direct`). */
  #directAllowed = false;
  readonly #inputsView: { get(playerId: PlayerId): Readonly<Record<string, Json>> };
  readonly #stopLoop: () => void;
  #unwatchVisibility: () => void = () => {};
  #batchPatch: JsonObject | null = null;
  readonly #stateRate = new Rate(10);
  #batchCounted = false;
  readonly #sendRate = new Rate(20);
  /** False once this room object was left, closed or replaced: kind handles then throw. */
  #live = true;
  /** Why it stopped being live: a `closed` reason, or replaced by a new object for the same room. */
  #closedAs: CloseReason | 'replaced' | null = null;
  #locked: boolean;
  #public: boolean;
  #linkOnly: boolean;
  /** The room's short link, once asked for (it's the same for the room's life), and once it's here. */
  #shareLink: Promise<string> | null = null;
  #shareUrl: string | null = null;
  /** The short link's id (`?join=<id>`), once it's here. */
  #linkId: string | null = null;
  #name: string | null;
  #meta: Json | null;

  /** @internal Rooms come from the relay (`createRoom`, `joinRoom`, …). */
  constructor(token: typeof CREATE, relay: RelayLink, info: RoomInfo, me: PlayerId, link?: string) {
    if (token !== CREATE) throw new GameRelayError('bad_request', 'Rooms come from the relay: `await relay.createRoom()`, `relay.joinRoom(code)` or `relay.quickMatch()`, not `new Room()`');
    super();
    this.#relay = relay;
    this.#me = me;
    this.#linkId = link ?? null;
    this.#id = info.id;
    this.#code = info.code;
    this.#maxPlayers = info.maxPlayers;
    this.#hostId = info.hostId;
    this.#players = frozen(info.players);
    this.#state = info.state;
    this.#chatHistory = frozen(info.chat ?? []);
    this.#seed = info.seed;
    this.#locked = info.locked ?? false;
    this.#public = info.public ?? false;
    this.#linkOnly = info.linkOnly ?? false;
    this.#name = info.name ?? null;
    this.#meta = info.meta ?? null;
    const transport: SyncTransport = {
      me,
      // `h` (host-only) lets the server drop a replaced host's late writes, timer effects included.
      send: (data, o) => this.#queueSend(data, o.to, o.reliable, o.host || this.#timers.firing, o.supersedable),
      now: () => relay.now(),
      writeTime: () => relay.writeTime(),
      player: (id) => this.#players.find((p) => p.id === id),
      hostId: () => this.#hostId,
      ready: () => relay.connected,
    };
    const warn: Warn = (kind, key, message) => relay.warn(kind, key, message);
    rooms.set(this, {
      handle: (msg) => this.#handle(msg),
      sync: (next) => this.#sync(next),
      close: (reason, message, later) => this.#closeLocal(reason, message, later),
      dispose: () => this.#dispose(),
      closeLan: () => this.#lan.close(),
      lanPause: () => this.#lan.pause(),
      lanPartyChanged: () => this.#lan.directChanged(),
      debugInfo: () => this.#debugInfo(),
    });
    this.#entities = new EntityStore(transport, {
      onSpawn: (e) => this.#fireEntity(this.#spawnHandlers, e),
      onRemove: (e, reason) => this.#fireEntity(this.#removeHandlers, e, reason),
      warn,
      perSender: relay.lanEnabled,
    }, (kind, owner) => relay.newEntityId(kind, owner));
    this.#messages = new Messages(transport, (type, data, from, meta) => this.#fireCustom(type, data, from, meta), warn);
    this.#health = new HostHealth({
      now: () => performance.now(),
      isHost: () => this.isHost,
      ready: () => relay.connected,
      send: (m) => this.#queue(m),
    });
    this.#timers = new Timers({
      ready: () => relay.connected,
      batch: (fn) => this.#batchState(fn),
      now: () => relay.now(),
      isHost: () => this.isHost,
      state: () => this.#state,
      setState: (patch) => this.#writeState(patch),
      fire: (name) => this.#fireTimer(name),
    });
    this.#claims = new Claims({
      me,
      isHost: () => this.isHost,
      queue: (m) => this.#queue(m),
      fire: (event, key, playerId) => this.fire(event, key, playerId),
      warn,
      now: () => performance.now(),
      ready: () => relay.serverReady,
    });
    this.#claims.sync(info.claims);
    this.#requests = new Requests(transport, warn);
    this.#inputs = new Inputs(transport);
    this.#inputsView = Object.freeze({ get: (playerId: PlayerId) => this.#inputs.get(playerId) });
    this.#lan = new Lan({
      me,
      enabled: relay.lanEnabled,
      signal: (to, data) => relay.queue({ t: 'send', d: data, to }),
      now: () => relay.now(),
      hostId: () => this.#hostId,
      players: () => this.#players.map((p) => p.id),
      serverReady: () => relay.serverReady,
      withinRate: () => relay.lanWithinRate(),
      relay: { only: relay.lanForceRelay },
      direct: relay.lanDirect === 'party' ? (id) => this.#directAllowed && (relay.party?.members.some((m) => m.id === id) ?? false) : undefined,
      deliver: (from, d, at) => this.#receive(d, from, at),
      log: (m) => console.info(`[gamerelay] ${m}`),
    });
    this.#lan.stateAt(info.stateSeq);
    for (const p of this.#players) this.#lan.add(p.id);
    this.#fetchIce();
    this.#stopLoop = relay.tick(60, () => {
      // Fresh credentials, and the owner's current say on direct connections (even without relays).
      if ((this.#iceHave || relay.lanDirect) && relay.now() - this.#iceAt > ICE_REFRESH_MS) this.#fetchIce();
      this.#lan.tick();
      this.#entities.tick();
      this.#health.tick();
      this.#timers.tick();
      this.#requests.tick();
      this.#claims.tick();
      this.#inputs.tick();
      this.#checkState();
    });
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const report = () => this.#health.visibility(document.hidden);
      document.addEventListener('visibilitychange', report);
      this.#unwatchVisibility = () => document.removeEventListener('visibilitychange', report);
      report();
    }
  }

  /** The room's id (stable for its life). */
  get id(): string {
    return this.#id;
  }

  /** The join code friends type (`relay.joinRoom(code)`). */
  get code(): string {
    return this.#code;
  }

  /** Your player id. */
  get me(): PlayerId {
    return this.#me;
  }

  /** Seats in the room. The host can change it (`setAccess`). */
  get maxPlayers(): number {
    return this.#maxPlayers;
  }

  /** The host's player id. */
  get hostId(): PlayerId {
    return this.#hostId;
  }

  /** Everyone in the room, you included, in join order. */
  get players(): PlayerInfo[] {
    return this.#players;
  }

  /**
   * The shared room state (read it; the host changes it with `setState`). Writing a key here
   * changes only your copy, so it warns: use `room.setState({ key: value })`.
   */
  get state(): JsonObject {
    return this.#state;
  }

  /**
   * Once a frame: did the game write to `room.state` itself? (A plain object, not a Proxy, so the
   * game can still clone it, post it to a worker, or store it.)
   */
  #checkState(): void {
    const state = this.#state;
    const seen = this.#stateSeen;
    if (seen?.of !== state) {
      this.#stateSeen = { of: state, values: new Map(Object.entries(state)) };
      return;
    }
    let changed = Object.keys(state).length !== seen.values.size;
    if (!changed) for (const [k, v] of seen.values) if (state[k] !== v) changed = true;
    if (!changed) return;
    this.#stateSeen = { of: state, values: new Map(Object.entries(state)) };
    this.#stateWrite();
  }

  /** Recent chat, oldest first (the last 20 when you joined, then everything you receive, capped). */
  get chatHistory(): ChatMessage[] {
    return this.#chatHistory;
  }

  /**
   * A random 32-bit seed the server picked for this room, the same for everyone. Use it for dice,
   * shuffles and spawns (`GameRelay.seededRandom(room.seed)`) so the host can't reroll until it wins.
   */
  get seed(): number {
    return this.#seed;
  }

  #stateWrite(): void {
    this.#relay.warn('set_state', 'state_write', 'room.state.x = … changes only your copy: the host changes state for everyone with room.setState({ x: … }); others ask it (room.request)');
  }

  /** True if you run the simulation. Re-check on `host_changed`. */
  get isHost(): boolean {
    return this.#hostId === this.#me;
  }

  /** The host locked the room (`setAccess`): nobody new can join. */
  get locked(): boolean {
    return this.#locked;
  }

  /** Listed by `relay.listRooms` and open to quick match. */
  get isPublic(): boolean {
    return this.#public;
  }

  /** Joined by its short link only (`shareLink`), not its code. */
  get linkOnly(): boolean {
    return this.#linkOnly;
  }

  /** The room's name in room lists (`setListing`), or null. */
  get name(): string | null {
    return this.#name;
  }

  /** The small JSON room lists show (`setListing`), or null. */
  get meta(): Json | null {
    return this.#meta;
  }

  /**
   * Host only: remove a player. They get `closed('kicked', message)`, everyone else `player_left`
   * with reason `'kicked'`. With `ban` (the default) they can't join this room again until it
   * closes (joining fails with `banned`).
   */
  async kick(playerId: PlayerId, options: { ban?: boolean; message?: string } = {}): Promise<void> {
    this.#hostOnly('room.kick');
    if (playerId === this.me) throw new GameRelayError('bad_request', "room.kick: the host can't kick itself; use room.leave()");
    const message = options.message === undefined ? null : this.#line('room.kick', 'message', options.message, LIMITS.maxModerationMessageLength);
    await this.#hostRequest({ t: 'kick', playerId, ban: options.ban === false ? false : undefined, message: message ?? undefined });
  }

  /**
   * Host only: who may join. `locked`: nobody new (joining fails with `locked`); players in the room
   * stay and can reconnect. `public`: listed and open to quick match. `linkOnly`: joined by its short
   * link only (`shareLink`), not its code. `maxPlayers`: 1–64, never below the players in the room.
   * Omitted options stay as they are. Everyone gets an `access` event.
   */
  async setAccess(access: { locked?: boolean; public?: boolean; linkOnly?: boolean; maxPlayers?: number }): Promise<void> {
    this.#hostOnly('room.setAccess');
    const { maxPlayers } = access;
    if (maxPlayers !== undefined && (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > LIMITS.maxPlayersPerRoom)) {
      throw new GameRelayError('bad_request', `room.setAccess: maxPlayers must be a whole number from 1 to ${LIMITS.maxPlayersPerRoom}`);
    }
    if (maxPlayers !== undefined && maxPlayers < this.#players.length) {
      throw new GameRelayError('bad_request', `room.setAccess: maxPlayers ${maxPlayers} is below the ${this.#players.length} players in the room`);
    }
    await this.#hostRequest({ t: 'set_access', locked: access.locked, public: access.public, linkOnly: access.linkOnly, maxPlayers });
  }

  /**
   * Host only: what `relay.listRooms` shows about this room. `name`: up to 48 characters, one line.
   * `meta`: any small JSON (up to 512 bytes), e.g. `{ map: 'dunes', phase: 'racing', lap: 2 }`.
   * Omitted options stay as they are; `null` clears one. Everyone gets a `listing` event. At most
   * 10 changes in a row (shared with `setAccess`), then 1 a second: update on a phase or lap
   * change, not every frame.
   */
  async setListing(listing: { name?: string | null; meta?: Json }): Promise<void> {
    this.#hostOnly('room.setListing');
    const name = typeof listing.name === 'string' ? this.#line('room.setListing', 'name', listing.name, LIMITS.maxRoomNameLength) : listing.name;
    if (listing.meta !== undefined && listing.meta !== null && !fitsUtf8(JSON.stringify(listing.meta), LIMITS.maxRoomMetaBytes)) {
      throw new GameRelayError('too_large', `room.setListing: meta is limited to ${LIMITS.maxRoomMetaBytes} bytes of JSON`);
    }
    await this.#hostRequest({ t: 'set_listing', name, meta: listing.meta });
  }

  /** Host only: hand the host role to another connected player. Everyone gets `host_changed`. */
  async transferHost(playerId: PlayerId): Promise<void> {
    this.#hostOnly('room.transferHost');
    if (playerId === this.me) throw new GameRelayError('bad_request', 'room.transferHost: you are the host already');
    await this.#hostRequest({ t: 'transfer_host', playerId });
  }

  /**
   * A closed Room (left, kicked, lost, or replaced by a new object for the same room) sends
   * nothing: the relay may be in another room now, and its players would get this one's messages.
   * A game loop that runs a frame after the close shouldn't crash, so sends are dropped with a
   * warning, not thrown; calls that answer with a promise reject (`claim` resolves false).
   */
  #gone(): boolean {
    if (this.#live) return false;
    this.#relay.warn('left_room', 'left_room', `${this.#closedWhy()}, so nothing was sent; stop its loop on room.on('closed') and use your new room`);
    return true;
  }

  /** Why this Room is closed, for warnings and errors. */
  #closedWhy(): string {
    const why = { left: 'you left it', kicked: 'you were removed from it', closed: 'it was closed', lost: 'the connection to it was lost', replaced: 'entering it again gave you a new room object' }[this.#closedAs ?? 'left'];
    return `room ${this.#code} is closed (${why}) but was still used`;
  }

  /** Null while the room is open; the error a call on it rejects with once closed. */
  #closedError(call: string): GameRelayError | null {
    // 'disconnected', as for a request still waiting when the room closed.
    return this.#live ? null : new GameRelayError('disconnected', `${call}: ${this.#closedWhy()}; use the room the relay gives you next`);
  }

  /** Host controls on a closed room reject as closed (`disconnected`), whoever was host. */
  #hostOnly(call: string): void {
    const closed = this.#closedError(call);
    if (closed) throw closed;
    if (!this.isHost) throw new GameRelayError('not_host', `${call}: only the host can do this; check room.isHost`);
  }

  /** A line others will see, checked as the server checks it: blank is null (no text). */
  #line(call: string, what: string, raw: string, max: number): string | null {
    const checked = normalizeLine(String(raw), max);
    if (!checked.ok && checked.reason === 'too_long') throw new GameRelayError('too_large', `${call}: the ${what} is limited to ${max} characters`);
    return checked.ok ? checked.text : null;
  }

  /** Host controls: everyone sees what they change, so no later broadcast's LAN copy may overtake one. */
  async #hostRequest(message: { t: string; [key: string]: Json | undefined }): Promise<void> {
    this.#lan.barrier();
    await this.#relay.request(message);
  }

  /**
   * The room's invite on this page: its URL with `?room=CODE`, or, for a link-only room (whose
   * code gets nobody in), `?join=<link>`. A friend who opens it gets in with `relay.joinInvite()`.
   * Same origin as the page, so `history.replaceState(null, '', room.inviteUrl())` works.
   */
  inviteUrl(base?: string): string {
    const url = new URL(base ?? pageUrl());
    url.searchParams.delete(INVITE_PARAM);
    url.searchParams.delete(LINK_PARAM);
    if (this.#linkOnly && this.#linkId) url.searchParams.set(LINK_PARAM, this.#linkId);
    else {
      if (this.#linkOnly) {
        this.#relay.warn('invite', 'invite_link_only', "room.inviteUrl(): this room is link-only and its link hasn't arrived yet, so the code's link won't get anyone in; await room.shareLink() first");
      }
      url.searchParams.set(INVITE_PARAM, this.#code);
    }
    return url.href;
  }

  /**
   * The room's short link: `https://play.gamerelay.io/<game>/<link>` when the game has a slug (set in
   * the dashboard), which previews with the room's name and the game's cover image and sends
   * players to the game's play URL with `?join=<link>`; otherwise this page's URL with
   * `?join=<link>`. Either way `relay.joinInvite()` joins it. The same link for the room's life,
   * and the way into a link-only room.
   */
  shareLink(): Promise<string> {
    // The server makes the link for the room we're in now, which a closed room isn't.
    const closed = this.#shareLink ? null : this.#closedError('room.shareLink');
    if (closed) return Promise.reject(closed);
    this.#shareLink ??= this.#relay.request({ t: 'share_link' }).then(
      (data) => {
        const { link, url } = (data ?? {}) as { link?: string; url?: string | null };
        if (!link) throw new GameRelayError('internal', 'room.shareLink: the server sent no link');
        this.#linkId = link;
        if (url) return (this.#shareUrl = url);
        const page = new URL(pageUrl());
        page.searchParams.delete(INVITE_PARAM);
        page.searchParams.set(LINK_PARAM, link);
        return (this.#shareUrl = page.href);
      },
      (err: unknown) => {
        this.#shareLink = null;
        throw err;
      },
    );
    return this.#shareLink;
  }

  /**
   * Share the invite: the room's short link (`shareLink`, fetched when you entered the room), or
   * its code's (`inviteUrl`) from a server without short links. The share sheet on phones, the clipboard elsewhere. Resolves with
   * what happened (`'cancelled'` if the player closed the share sheet). Rejects for a link-only
   * room whose link it couldn't get: its code gets nobody in.
   */
  async shareInvite(text = 'Join my game'): Promise<'shared' | 'copied' | 'cancelled'> {
    // The link fetched on entering the room, so the share stays in the tap; only if it isn't here
    // yet (or the server has no short links) does this wait, or fall back to the code's link.
    const url =
      this.#shareUrl ??
      (await this.shareLink().catch((err: unknown) => {
        if (this.#linkOnly) throw err;
        return this.inviteUrl();
      }));
    if (typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: document.title, text, url });
        return 'shared';
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
        // Share refused (no user gesture, permissions): copy instead.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch (err) {
      throw new GameRelayError('unsupported', `room.shareInvite: this page can't copy (${err instanceof Error ? err.message : 'no clipboard'}); show room.inviteUrl() for the player to copy`, { cause: err });
    }
    return 'copied';
  }

  /** Relay any JSON value to everyone else, or to one player with `{ to }`. */
  send(data: Json, options: SendOptions = {}): void {
    if (this.#gone()) return;
    const h = this.#timers.firing ? true : undefined; // a timer's effects: dropped if we're no longer the host
    if (looksPositional(data) && this.#sendRate.hit(this.#relay.now())) {
      this.#relay.warn('send_positions', 'send_positions', "room.send() of x/y more than 20×/s: you're hand-writing sync; use entities (room.define(kind, fields), then its .spawn()) and the SDK smooths it, sends it to late joiners and cleans up after players who leave");
    }
    this.#queueSend(data, options.to, options.reliable !== false, h === true);
  }

  /**
   * Every relayed send goes out here. With the LAN shortcut open, a broadcast is numbered and a copy
   * races to LAN peers; the server still gets (and relays) every message as before.
   */
  #queueSend(data: Json, to: PlayerId | undefined, reliable: boolean, host: boolean, supersedable = false): void {
    if (!this.#live) return; // the SDK's own late sends (entities, timers): the game's calls warn first
    const broadcast = to === undefined && this.#lan.enabled;
    const d = broadcast ? (this.#lan.wrap(data, host, supersedable) as unknown as Json) : data;
    if (!broadcast) this.#lan.barrier();
    this.#relay.queue({ t: 'send', d, to, r: reliable ? undefined : false, h: host ? true : undefined });
  }

  /**
   * Everything else the room sends goes out here. What others will see (state, claims, chat, seed,
   * a step down) is a barrier for the LAN shortcut: no later broadcast's LAN copy may overtake it.
   */
  #queue(m: Outgoing): void {
    if (!this.#live) return; // the SDK's own late sends (batched state, claim retries, heartbeats)
    if (m.t !== 'heartbeat' && m.t !== 'visibility') this.#lan.barrier();
    this.#relay.queue(m);
  }

  /**
   * The LAN shortcut: this room's relays and credentials (the server only gives them to players in
   * a room, for that room). Asked for on joining, after a reconnect, and again well before they
   * expire. No connection is tried until the first answer; a server without relays (or a failed
   * ask) means the LAN only, and a failed refresh keeps the credentials we have.
   */
  #fetchIce(): void {
    if (!this.#relay.lanEnabled) return;
    this.#iceAt = this.#relay.now();
    const none = (why: string) => {
      if (this.#iceHave) return;
      if (this.#relay.lanForceRelay) console.info(`[gamerelay] LAN shortcut: no relays (${why})`);
      void this.#lan.setRelays(null);
    };
    this.#relay
      .request({ t: 'turn' })
      .then((data) => {
        const reply = data as { ice?: RTCIceServer[]; direct?: boolean } | undefined;
        const allowed = reply?.direct === true;
        if (allowed !== this.#directAllowed) {
          this.#directAllowed = allowed;
          this.#lan.directChanged();
        }
        const ice = reply?.ice;
        if (!ice?.length) return none('none on this server');
        this.#iceHave = true;
        void this.#lan.setRelays(ice);
      })
      .catch((err: GameRelayError) => none(err.message));
  }

  /**
   * The players you have a player-to-player channel with (`connect({ p2p })`). Their broadcasts
   * reach you over it as well as through the server, and you keep whichever comes first.
   * @experimental
   */
  p2pPeers(): PlayerId[] {
    return this.#lan.peers();
  }

  /**
   * How the player-to-player channel with a player goes: `'direct'` (the same network, or a party
   * member over the internet) or `'relay'` (through a TURN relay). `null`: no channel, or not known yet.
   * @experimental
   */
  p2pRoute(playerId: PlayerId): 'direct' | 'relay' | null {
    return this.#lan.route(playerId);
  }

  /** @deprecated The old name of `p2pPeers`. */
  lanPeers(): PlayerId[] {
    return this.p2pPeers();
  }

  /** @deprecated The old name of `p2pRoute`. */
  lanRoute(playerId: PlayerId): 'direct' | 'relay' | null {
    return this.p2pRoute(playerId);
  }

  /** Host only. Shallow-merges `patch` into the shared, persisted room state (`null` deletes a key). */
  setState(patch: JsonObject): void {
    if (this.#gone()) return; // before the local write, so a closed room's state stays what was sent
    if (!this.isHost) throw new GameRelayError('not_host', 'Only the host can set state');
    // Only the game's own calls count toward the rate warning; timers and teams write state too.
    if (this.#batchPatch) this.#batchCounted = true;
    else this.#countState();
    this.#writeState(patch);
  }

  /** Apply and send a state patch (or add it to the running batch). The SDK's own writes use this. */
  #writeState(patch: JsonObject): void {
    if (!this.isHost) throw new GameRelayError('not_host', 'Only the host can set state');
    this.#state = applyPatch(this.#state, patch);
    if (this.#batchPatch) Object.assign(this.#batchPatch, patch);
    else this.#queue({ t: 'set_state', patch });
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
      if (Object.keys(patch).length > 0) this.#queue({ t: 'set_state', patch });
    }
  }

  /** Host only: ask the server for a new `room.seed` (a new round). Everyone gets a `seed` event. */
  reseed(): void {
    if (this.#gone()) return;
    if (!this.isHost) throw new GameRelayError('not_host', 'Only the host can pick a new seed');
    this.#queue({ t: 'reseed' });
  }

  /** Send a chat line to the room (max 120 characters, single line). Arrives as a `chat` event for everyone, you included. */
  chat(text: string): void {
    if (this.#gone()) return;
    const checked = normalizeChat(text);
    if (!checked.ok) {
      throw checked.reason === 'empty'
        ? new GameRelayError('bad_request', 'Chat messages cannot be empty')
        : new GameRelayError('too_large', `Chat messages are limited to ${LIMITS.maxChatLength} characters`);
    }
    this.#queue({ t: 'chat', text: checked.text });
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

  /**
   * Create an entity you own. Write its fields every frame; the SDK sends changes (~20/s).
   * @deprecated Use the kind's handle: `const ships = room.define('ship', …)`, then `ships.spawn(…)`.
   */
  spawn(kind: string, initial: Record<string, unknown>, options?: SpawnOptions): Entity {
    // It returns the entity, so it can't just drop: it throws, as a kind's spawn does.
    const closed = this.#closedError('room.spawn');
    if (closed) throw closed;
    return this.#entities.spawn(kind, initial, options);
  }

  /**
   * Host only: start a timer that fires `room.on('timer', name, …)` on whoever is host when it falls
   * due, exactly once, even if the host changes meanwhile. It lives in room state as a deadline on
   * the server clock, so everyone can show `room.timeLeft(name)`.
   */
  timer(name: string, ms: number): void {
    if (this.#gone()) return; // before the local state write, as setState
    this.#timers.set(name, ms);
  }

  /** Host only: cancel a timer. */
  clearTimer(name: string): void {
    if (this.#gone()) return;
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
    // Closed: we don't get it (as a pending claim on close), and the warning says why.
    if (this.#gone()) return Promise.resolve(false);
    return this.#claims.claim(key);
  }

  /** Let go of a claim you hold (the host may release any). Everyone gets a `released` event. */
  release(key: string): void {
    if (this.#gone()) return;
    this.#claims.release(key);
  }

  /** Who holds `key`, or null. */
  holder(key: string): PlayerId | null {
    return this.#claims.holder(key);
  }

  /** Who holds `key`, or null. @deprecated The old name of `holder` (it reads like the `claimed` event). */
  claimed(key: string): PlayerId | null {
    return this.#claims.holder(key);
  }

  /**
   * Ask the host and wait for its answer: `const r = await room.request('buy', { item })`. Rejects
   * if the host refuses (`throw room.reject('why')`), changes before answering (`host_changed`) or
   * doesn't answer in 5 s (`timeout`).
   */
  request(type: string, data: Json = null): Promise<Json> {
    const closed = this.#closedError('room.request');
    if (closed) return Promise.reject(closed);
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
    if (this.#gone()) return;
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
    if (this.#gone()) return;
    if (!this.isHost) throw new GameRelayError('not_host', 'room.assignTeams: only the host assigns teams; check room.isHost');
    if (!Number.isInteger(n) || n < 1 || n > this.#maxPlayers) {
      throw new GameRelayError('bad_request', `room.assignTeams(n): n must be a whole number from 1 to ${this.#maxPlayers} (the room's maxPlayers)`);
    }
    const teams = balanceTeams(this.#players.map((p) => p.id), this.#teams(), n, options.rebalance === true);
    this.#writeState({ [TEAMS_KEY]: teams, [TEAM_COUNT_KEY]: n });
  }

  /** The team (0…n − 1) the host put this player on with `assignTeams`, or undefined. */
  teamOf(playerId: PlayerId): number | undefined {
    const team = this.#teams()[playerId];
    return typeof team === 'number' ? team : undefined;
  }

  #teams(): Record<PlayerId, number> {
    const raw = this.#state[TEAMS_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<PlayerId, number>) : {};
  }

  /** On the host, while teams are on: place newcomers and drop leavers (nobody else moves). */
  #keepTeams(): void {
    const n = this.#state[TEAM_COUNT_KEY];
    if (!this.isHost || typeof n !== 'number') return;
    const current = this.#teams();
    const next = balanceTeams(this.#players.map((p) => p.id), current, n, false);
    if (JSON.stringify(next) !== JSON.stringify(current)) this.#writeState({ [TEAMS_KEY]: next });
  }

  /**
   * Every entity of a kind: yours live, everyone else's smoothed about 100 ms in the past.
   * @deprecated Use the kind's handle: `ships.all()` (from `room.define`).
   */
  all(kind: string): Entity[] {
    return this.#entities.all(kind);
  }

  /** @deprecated Use the kind's handle: `ships.get(id)` (from `room.define`). */
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
    if (this.#gone()) return;
    const to = options.to === 'host' ? this.#hostId : options.to;
    this.#messages.emit(type, data, { to, echo: options.echo });
  }

  override on<K extends keyof RoomEvents>(event: K, handler: RoomEvents[K]): () => void;
  /** @deprecated Use the kind's handle: `ships.on('spawn', …)` (from `room.define`). */
  override on(event: 'spawn', kind: string, handler: (entity: Entity) => void): () => void;
  /** @deprecated Use the kind's handle: `ships.on('remove', …)` (from `room.define`). */
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

  /** @internal For the debug overlay, the eval scorer and e2e tests (`room[Symbol.for('gamerelay.debug')]()`): not part of the API. */
  [DEBUG](): RoomDebugInfo {
    return this.#debugInfo();
  }

  #debugInfo(): RoomDebugInfo {
    const lan = this.#relay.lanEnabled ? this.#lan.stats() : undefined;
    return { delayMs: this.#entities.delayMs, entities: this.#entities.counts(), hosted: this.#entities.hostedCounts(), lan };
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
    const was = this.#hostId; // our own view decides whether we just gained or lost the role
    this.#hostId = hostId;
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

  /** Leave the room (you get `closed` with `'left'`). */
  async leave(): Promise<void> {
    if (!this.#live) return;
    this.#relay.left(this);
    this.#closeLocal('left');
    await this.#relay.request({ t: 'leave_room' }).catch(() => undefined);
  }

  /** Stop this object's work without a `closed` event (it was replaced by a new one). */
  #dispose(): void {
    this.#closedAs ??= 'replaced';
    this.#live = false;
    this.#claims.close();
    this.#requests.close();
    this.#lan.close();
    this.#stopLoop();
    this.#unwatchVisibility();
  }

  #closeLocal(reason: CloseReason, message?: string, later = false): void {
    if (!this.#live) return;
    this.#closedAs = reason;
    this.#live = false;
    this.#claims.close();
    this.#requests.close();
    this.#lan.close();
    this.#stopLoop();
    this.#unwatchVisibility();
    // Closed now (nothing more goes out), but a handler that enters another room waits for the batch.
    if (later) queueMicrotask(() => this.fire('closed', reason, message));
    else this.fire('closed', reason, message);
  }

  /** Resync after a reconnect, emitting events for anything that changed. */
  #sync(info: RoomInfo): void {
    this.#lan.resync(); // the server doesn't replay what we missed: held LAN copies' server copies aren't coming
    this.#lan.stateAt(info.stateSeq);
    this.#fetchIce();
    const before = new Map(this.#players.map((p) => [p.id, p]));
    const after = new Set(info.players.map((p) => p.id));
    this.#players = frozen(info.players);
    for (const p of info.players) {
      if (before.has(p.id)) continue;
      this.#entities.playerJoined(p.id);
      this.#lan.add(p.id, false); // noted; reconnect() below starts with everyone at once
      this.fire('player_joined', p);
    }
    for (const id of before.keys()) {
      if (after.has(id)) continue;
      this.#entities.playerLeft(id);
      this.#inputs.playerLeft(id);
      this.#lan.remove(id); // not playerLeft: reconnect() below starts with everyone the cap allows
      this.fire('player_left', id, 'timeout');
    }
    // State first: becoming host here must work from the room's current state, not our stale copy
    // (teams, timers), or it would write the stale values back.
    this.#state = info.state;
    if (info.hostId !== this.#hostId) this.#hostMoved(info.hostId, this.#hostId);
    this.fire('state', this.state, info.state, info.hostId);
    this.#claims.sync(info.claims);
    this.#keepTeams();
    if (info.seed !== this.#seed) {
      this.#seed = info.seed;
      this.fire('seed', info.seed, info.hostId);
    }
    // Host controls that changed while we were away.
    const access: RoomAccess = { locked: info.locked ?? false, public: info.public ?? false, linkOnly: info.linkOnly ?? false, maxPlayers: info.maxPlayers };
    if (access.locked !== this.#locked || access.public !== this.#public || access.linkOnly !== this.#linkOnly || access.maxPlayers !== this.#maxPlayers) this.#setAccess(access, info.hostId);
    const listing: RoomListingInfo = { name: info.name ?? null, meta: info.meta ?? null };
    if (listing.name !== this.#name || JSON.stringify(listing.meta) !== JSON.stringify(this.#meta)) this.#setListing(listing, info.hostId);
    // Deliver chat that arrived while we were reconnecting.
    const seen = new Set(this.#chatHistory.map((m) => m.id));
    for (const m of info.chat ?? []) if (!seen.has(m.id)) this.#receiveChat(m);
    // Whatever LAN signalling went on while we were away went nowhere: start again.
    this.#lan.reconnect();
  }

  #receiveChat(message: ChatMessage): void {
    this.#chatHistory = frozen([...this.#chatHistory, message].slice(-LIMITS.chatHistory * 5));
    this.fire('chat', message);
  }

  /** A relayed message, from the server or (with the LAN shortcut) straight from its sender. */
  #receive(d: Json, from: PlayerId, at: number): void {
    if (this.#entities.receive(d, from, at) || this.#messages.receive(d, from, at) || this.#requests.receive(d, from) || this.#inputs.receive(d, from)) return;
    this.fire('message', d, from, { at });
  }

  #handle(msg: ServerMessage): void {
    // An event the server sent everyone (a host change, a join, a claim): a reaction we broadcast
    // to it must not reach a LAN peer before the event itself does. A state patch carries a number
    // instead (`Lan.stateAt`), which a LAN peer checks for itself: no barrier, no wait.
    if (msg.t !== 'message' && msg.t !== 'state') this.#lan.barrier();
    switch (msg.t) {
      case 'message':
        if (isSignal(msg.d)) return void this.#lan.signal(msg.from, msg.d);
        if (isWrapped(msg.d)) return this.#lan.receiveServer(msg.from, msg.d, msg.at);
        return this.#receive(msg.d, msg.from, msg.at);
      case 'seed':
        this.#seed = msg.seed;
        return this.fire('seed', msg.seed, msg.from);
      case 'chat':
        return this.#receiveChat(msg.message);
      case 'state':
        this.#state = applyPatch(this.#state, msg.patch);
        this.fire('state', this.state, msg.patch, msg.from);
        return this.#lan.stateAt(msg.seq); // after the handlers: what it frees comes after the patch
      case 'player_joined':
        this.#players = frozen([...this.#players.filter((p) => p.id !== msg.player.id), msg.player]);
        this.#entities.playerJoined(msg.player.id);
        this.#lan.add(msg.player.id, false); // the newcomer starts
        this.#keepTeams();
        return this.fire('player_joined', msg.player);
      case 'player_left':
        this.#players = frozen(this.#players.filter((p) => p.id !== msg.playerId));
        this.#entities.playerLeft(msg.playerId);
        this.#inputs.playerLeft(msg.playerId);
        this.#lan.playerLeft(msg.playerId);
        this.#keepTeams();
        return this.fire('player_left', msg.playerId, msg.reason);
      case 'player_disconnected':
      case 'player_reconnected': {
        const connected = msg.t === 'player_reconnected';
        this.#players = frozen(this.#players.map((p) => (p.id === msg.playerId ? { ...p, connected } : p)));
        return this.fire(msg.t, msg.playerId);
      }
      case 'host_changed':
        return this.#hostMoved(msg.hostId, msg.previousHostId);
      case 'claimed':
      case 'released':
      case 'claim_result':
        return this.#claims.receive(msg);
      case 'access':
        return this.#setAccess(msg, msg.from);
      case 'listing':
        return this.#setListing(msg, msg.from);
    }
  }

  #setAccess(access: Omit<RoomAccess, 'linkOnly'> & { linkOnly?: boolean }, from: PlayerId): void {
    this.#locked = access.locked;
    this.#public = access.public;
    // An older server's `access` doesn't say: it has no link-only rooms.
    this.#linkOnly = access.linkOnly ?? false;
    // Its invite is its short link now (`inviteUrl`): the host, who made it so, has it ready.
    // A microtask later, as in #adopt: this can run mid-batch, and asking flushes the outbox.
    if (this.#linkOnly && !this.#linkId && this.#live && this.isHost) queueMicrotask(() => void this.shareLink().catch(() => {}));
    this.#maxPlayers = access.maxPlayers;
    this.fire('access', { locked: access.locked, public: access.public, linkOnly: this.#linkOnly, maxPlayers: access.maxPlayers }, from);
  }

  #setListing(listing: RoomListingInfo, from: PlayerId): void {
    this.#name = listing.name;
    this.#meta = listing.meta;
    this.fire('listing', { name: listing.name, meta: listing.meta }, from);
  }
}

/** A list the game reads but can't change in place (`room.players`, `room.chatHistory`). */
function frozen<T>(list: T[]): T[] {
  return Object.freeze(list) as T[];
}

/** Keys a patch may not set: assigning them would change the state object's prototype, not its data. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function applyPatch(state: JsonObject, patch: JsonObject): JsonObject {
  const next = { ...state };
  for (const [k, v] of Object.entries(patch)) {
    // A patch comes from the server as parsed JSON, where `__proto__` is an ordinary key.
    if (UNSAFE_KEYS.has(k)) continue;
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
