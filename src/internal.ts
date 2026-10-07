/**
 * What the relay and its rooms say to each other, out of reach of game code: nothing here is
 * exported by the package (only `index.ts` is), so a page can't call it, and a model guessing names
 * can't find it. Tests import it directly.
 */
import type { Json, PartyInfo, PlayerId, RoomClientMessage, RoomInfo, ServerMessage } from '@gamerelay/protocol/types';
import type { WarningKind } from './debug/warnings';
import type { LanStats } from './sync/lan';

/** Passed to the constructors: `new GameRelay()` and `new Room()` from game code throw without it. */
export const CREATE: unique symbol = Symbol('gamerelay.create');

/** The room debug hook (the overlay, the eval scorer, e2e tests): not a promise, so not a name. */
export const DEBUG: unique symbol = Symbol.for('gamerelay.debug') as never;

export type Outgoing = { [K in RoomClientMessage['t']]: Omit<Extract<RoomClientMessage, { t: K }>, 'v'> }[RoomClientMessage['t']];
export type Request = { t: string; [key: string]: Json | undefined };

/** What a room needs from its relay. */
export interface RelayLink {
  readonly connected: boolean;
  /** Connected and back in the room: what we queue now goes straight to the server. */
  readonly serverReady: boolean;
  readonly party: PartyInfo | null;
  /** Player to player (`p2p`) is on, through the relay only, or direct with party members. */
  readonly lanEnabled: boolean;
  readonly lanForceRelay: boolean;
  readonly lanDirect: 'party' | null;
  queue(message: Outgoing): void;
  request(message: Request): Promise<Json | undefined>;
  now(): number;
  /** The server-clock moment of the running `tick` step, else now. */
  writeTime(): number;
  tick(rate: number, fn: (dt: number, tick: number) => void): () => void;
  warn(kind: WarningKind, key: string, message: string): void;
  newEntityId(kind: string, owner: PlayerId): string;
  /** A broadcast queued now gets through the server's rate limit: its p2p copy may race. */
  lanWithinRate(): boolean;
  /** The room was left: the relay forgets it (if it's still the relay's room). */
  left(room: object): void;
}

export interface RoomDebugInfo {
  delayMs: number;
  entities: Record<string, number>;
  hosted: Record<string, number>;
  lan: LanStats | undefined;
}

/** What the relay does to its room. */
export interface RoomControl {
  /** A server message for this room. */
  handle(msg: ServerMessage): void;
  /** Resync after a reconnect, with events for whatever changed. */
  sync(info: RoomInfo): void;
  /** Out of the room: stop, and fire `closed`. */
  close(reason: 'left' | 'lost' | 'kicked' | 'closed', message?: string): void;
  /** Stop without a `closed` event (a new object replaces this one). */
  dispose(): void;
  /** The connection is closed or replaced: close the p2p channels too. */
  closeLan(): void;
  /** The server rate-limited us: p2p copies pause too. */
  lanPause(): void;
  /** Our party changed: direct connections follow who's in it. */
  lanPartyChanged(): void;
  /** For the debug overlay. */
  debugInfo(): RoomDebugInfo;
}

/** Each relay's link (what its rooms use), for tests: the relay's own code holds it privately. */
export const relays = new WeakMap<object, RelayLink>();

export function linkOf(relay: object): RelayLink {
  const l = relays.get(relay);
  if (!l) throw new Error('[gamerelay] not a relay');
  return l;
}

/** Each live room's controls, set by its constructor. */
export const rooms = new WeakMap<object, RoomControl>();

export function control(room: object): RoomControl {
  const c = rooms.get(room);
  if (!c) throw new Error('[gamerelay] not a room');
  return c;
}

/**
 * The server the SDK talks to by default. The `<script>` build sets it to the origin it was loaded
 * from (`global.ts`); everything else keeps https://gamerelay.io.
 */
export const defaults = { url: 'https://gamerelay.io' };
