/**
 * Wire protocol types. Dependency-free so the SDK can `import type` them.
 * Runtime validation lives in `schema.ts` and is checked against these types.
 *
 * Every message is `{ v, t, ...fields }` where `v` is the protocol version and
 * `t` is the message type.
 */

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type PlayerId = string;

/**
 * `relay`: host-authoritative, server only relays (v1).
 * `authoritative`: reserved for a future mode where the server runs a
 * developer-supplied `reducer(state, input)` in an isolate. Not implemented;
 * requesting it yields an `unsupported` error.
 */
export type RoomMode = 'relay' | 'authoritative';

export interface PlayerInfo {
  id: PlayerId;
  name: string;
  /** Set by the player's token: an image URL from your backend, or a short id/emoji for anonymous players. */
  avatar: string | null;
  joinedAt: number;
  connected: boolean;
  /** Stable index 0…maxPlayers − 1: kept across reconnects, reused only after its player leaves. For colours and spawn points. */
  slot: number;
}

/** One chat line. Name and avatar are the sender's at send time, filled in by the server. */
export type ChatMessage = {
  id: string;
  from: PlayerId;
  name: string;
  avatar: string | null;
  text: string;
  /** ms since epoch (server clock). */
  ts: number;
};

export interface RoomInfo {
  id: string;
  code: string;
  mode: RoomMode;
  maxPlayers: number;
  hostId: PlayerId;
  players: PlayerInfo[];
  state: JsonObject;
  stateSeq: number;
  /** Matchmaking pool, e.g. a game mode. */
  tag?: string;
  /** Most recent chat messages, oldest first. */
  chat: ChatMessage[];
  /** A random 32-bit seed the server picked (fair dice, shuffles, spawns); the host can ask for a new one. */
  seed: number;
  /** Take-once claims held now: key → holder. */
  claims: Record<string, PlayerId>;
  /** The host locked the room (`room.setAccess`): nobody new may join. Absent from older servers. */
  locked?: boolean;
  /** Listed by `listRooms` and open to quick match. Absent from older servers. */
  public?: boolean;
  /** What room lists show, set by the host (`room.setListing`). Absent until set. */
  name?: string;
  meta?: Json;
}

/** Public room as shown in a lobby list. (A type alias so it is assignable to `Json`.) */
export type RoomListing = {
  code: string;
  players: number;
  maxPlayers: number;
  tag: string | null;
  createdAt: number;
  /** The host's name for the room (`room.setListing`), or null. */
  name: string | null;
  /** Small JSON the host set with `room.setListing` (map, phase, lap…), or null. */
  meta: Json | null;
  /** Locked by the host: joining fails with `locked`. Listed only with `includeFull`. */
  locked: boolean;
  /** The host's player name, or null while nobody hosts. */
  hostName: string | null;
};

/** `desc`: higher scores are better (points). `asc`: lower is better (times). */
export type LeaderboardOrder = 'desc' | 'asc';

/** One player's best score on a board. (Type aliases so they are assignable to `Json`.) */
export type LeaderboardEntry = {
  /** 1-based; tied scores share a rank. */
  rank: number;
  playerId: PlayerId;
  name: string;
  score: number;
  updatedAt: number;
};

export type LeaderboardPage = {
  /** Null when nobody has submitted to this board yet. */
  order: LeaderboardOrder | null;
  entries: LeaderboardEntry[];
  /** The caller's own entry (even if outside `entries`), or null if they have no score. */
  me: LeaderboardEntry | null;
};

export type LeaderboardSubmitResult = {
  /** The player's best score on this board after the submit. */
  best: number;
  rank: number;
  /** True when this score became the player's new best. */
  improved: boolean;
};

export interface PartyMember {
  id: PlayerId;
  name: string;
  connected: boolean;
}

/** A group of players that moves between rooms together, following its leader. */
export interface PartyInfo {
  code: string;
  leaderId: PlayerId;
  members: PartyMember[];
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'too_large'
  | 'room_not_found'
  | 'room_full'
  | 'already_in_room'
  | 'not_in_room'
  | 'not_host'
  | 'player_not_found'
  | 'party_not_found'
  | 'party_full'
  | 'unsupported'
  /** Kicked from this room (by its host or the game's owner); joining it again is refused. */
  | 'banned'
  /** The room's host locked it: nobody new may join (players in it can still reconnect). */
  | 'locked'
  /** The game's account has as many players online as its plan allows. */
  | 'at_capacity'
  /** The game's account used its monthly traffic allowance (free plan); resets on the 1st. */
  | 'quota_exceeded'
  /** A leaderboard score broke one of the board's rules (set by the game's owner). */
  | 'rejected'
  /**
   * No new room: the game has as many open rooms as its plan allows, or this player already
   * made several that nobody joined (they expire after two idle minutes).
   */
  | 'too_many_rooms'
  | 'internal';

export type LeaveReason = 'left' | 'timeout' | 'kicked';

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

interface Base<T extends string> {
  v: ProtocolVersion;
  t: T;
}

/** Messages handled inside a Room. */
export interface SendMsg extends Base<'send'> {
  d: Json;
  /** Target a single player; omitted = everyone else in the room. */
  to?: PlayerId;
  /** `false` lets the server drop the message under backpressure. Default true. */
  r?: boolean;
  /** Host only: the server drops it unless the sender is the current host (a replaced host's late writes). */
  h?: boolean;
}
export interface SetStateMsg extends Base<'set_state'> {
  /** Shallow merge patch; a `null` value deletes the key (RFC 7386 at top level). */
  patch: JsonObject;
}
/** Reserved for server-authoritative mode. */
export interface InputMsg extends Base<'input'> {
  d: Json;
}
/** A chat line to everyone in the room (sender included). See `normalizeChat` for the rules. */
export interface ChatMsg extends Base<'chat'> {
  text: string;
}
/** Host only: ask the server for a fresh room seed (a new round). */
export interface ReseedMsg extends Base<'reseed'> {}
/** This player's tab became hidden or visible: host election prefers visible players. */
export interface VisibilityMsg extends Base<'visibility'> {
  hidden: boolean;
}
/** The host is alive and ticking (about 4 times a second). Silence for 1 s gets it replaced. */
export interface HeartbeatMsg extends Base<'heartbeat'> {}
/** The host can't keep its tick rate and asks to hand over; honoured only if a visible player can take it. */
export interface StepDownMsg extends Base<'step_down'> {}
/** Take `key` if nobody holds it. The server answers with `claim_result`; a win is also broadcast as `claimed`. */
export interface ClaimMsg extends Base<'claim'> {
  key: string;
}
/** Let go of a claim: its holder, or the host, may. */
export interface ReleaseMsg extends Base<'release'> {
  key: string;
}
export type RoomClientMessage =
  | SendMsg
  | SetStateMsg
  | InputMsg
  | ChatMsg
  | ReseedMsg
  | VisibilityMsg
  | HeartbeatMsg
  | StepDownMsg
  | ClaimMsg
  | ReleaseMsg;
export interface BatchMsg extends Base<'batch'> {
  m: RoomClientMessage[];
}

// Host controls: requests handled inside a Room, answered by `rid` (a reply, or an error such as
// `not_host`). Not batched.
/** Remove a player; with `ban` (default true) they can't join this room again until it closes. */
export interface KickMsg extends Base<'kick'> {
  rid: number;
  playerId: PlayerId;
  ban?: boolean;
  /** Shown to the kicked player (`closed('kicked', message)`). */
  message?: string;
}
/** Who may join. An omitted field stays as it is. */
export interface SetAccessMsg extends Base<'set_access'> {
  rid: number;
  /** No new players; players in the room stay, and a dropped one can still resume their seat. */
  locked?: boolean;
  public?: boolean;
  /** Never below the players seated now. */
  maxPlayers?: number;
}
/** What room lists show. An omitted field stays as it is; `null` (or an empty name) clears it. */
export interface SetListingMsg extends Base<'set_listing'> {
  rid: number;
  name?: string | null;
  meta?: Json;
}
/** Hand the host role to another connected player. */
export interface TransferHostMsg extends Base<'transfer_host'> {
  rid: number;
  playerId: PlayerId;
}
export type RoomRequestMessage = KickMsg | SetAccessMsg | SetListingMsg | TransferHostMsg;

/** Messages handled by the server / lobby layer. `rid` correlates replies. */
export interface CreateRoomMsg extends Base<'create_room'> {
  rid: number;
  maxPlayers?: number;
  mode?: RoomMode;
  /** Public rooms are eligible for quick match and room lists. */
  public?: boolean;
  tag?: string;
}
export interface JoinRoomMsg extends Base<'join_room'> {
  rid: number;
  code: string;
  /**
   * The SDK is getting back into the room it was in (after a reconnect). If it was kicked while
   * away, the server sends `removed` (kicked, with the message) before refusing, instead of
   * giving it a fresh seat.
   */
  resume?: boolean;
}
export interface QuickMatchMsg extends Base<'quick_match'> {
  rid: number;
  maxPlayers?: number;
  tag?: string;
}
export interface ListRoomsMsg extends Base<'list_rooms'> {
  rid: number;
  tag?: string;
  /** Also full and locked rooms (each listing says which). */
  includeFull?: boolean;
}
/** Players online in this game now. Reply: `{ players: number }`. */
export interface OnlineMsg extends Base<'online'> {
  rid: number;
}
export interface PartyCreateMsg extends Base<'party_create'> {
  rid: number;
}
export interface PartyJoinMsg extends Base<'party_join'> {
  rid: number;
  code: string;
}
export interface PartyLeaveMsg extends Base<'party_leave'> {
  rid: number;
}
export interface LeaveRoomMsg extends Base<'leave_room'> {
  rid: number;
}
export interface KvGetMsg extends Base<'kv_get'> {
  rid: number;
  key: string;
}
export interface KvSetMsg extends Base<'kv_set'> {
  rid: number;
  key: string;
  value: Json;
}
export interface LeaderboardSubmitMsg extends Base<'lb_submit'> {
  rid: number;
  board: string;
  score: number;
  /** Set by the board's first submit (default `desc`); later submits must match or omit it. */
  order?: LeaderboardOrder;
}
export interface LeaderboardTopMsg extends Base<'lb_top'> {
  rid: number;
  board: string;
  limit?: number;
}
export interface PingMsg extends Base<'ping'> {
  ts: number;
}
/**
 * Experimental: TURN relays and short-lived credentials for them, for the room we're in (the LAN
 * shortcut). Reply: `{ ice: IceServer[], direct: boolean }`: one entry per relay (none when the
 * server has no relays), and whether the owner allows direct connections between party members.
 */
export interface TurnMsg extends Base<'turn'> {
  rid: number;
}

export type LobbyClientMessage =
  | CreateRoomMsg
  | JoinRoomMsg
  | QuickMatchMsg
  | LeaveRoomMsg
  | KvGetMsg
  | KvSetMsg
  | LeaderboardSubmitMsg
  | LeaderboardTopMsg
  | PingMsg
  | TurnMsg
  | ListRoomsMsg
  | OnlineMsg
  | PartyCreateMsg
  | PartyJoinMsg
  | PartyLeaveMsg;

export type ClientMessage = LobbyClientMessage | RoomClientMessage | RoomRequestMessage | BatchMsg;
export type ClientMessageType = ClientMessage['t'];

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/**
 * What a game's plan includes beyond its limits, sent in `welcome` and listed by `GET /v1/plans`.
 * A flag that's off (or missing) means the plan doesn't include it. New features ship behind a
 * flag, so which tier gets them is a data change on the server.
 */
export interface PlanFeatures {
  /** Voice chat between players in a room (WebRTC audio). Reserved: not built yet. */
  voice: boolean;
  /** Unreliable, unordered delivery for `reliable: false` sends. Reserved: not built yet. */
  unreliable: boolean;
}
export const PLAN_FEATURES = ['voice', 'unreliable'] as const satisfies readonly (keyof PlanFeatures)[];

export interface WelcomeMsg extends Base<'welcome'> {
  playerId: PlayerId;
  /** What this game's plan includes. */
  features: PlanFeatures;
  /** Reconnecting as the same player within this window resumes your seat. */
  resumeGraceMs: number;
  serverTime: number;
  /** This connection's frame key, masked with `playerId` (`sign.ts`). Every client frame is signed with it. */
  k: string;
}
/** An `RTCIceServer`, as JSON. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}
export interface ReplyMsg extends Base<'reply'> {
  rid: number;
  data?: Json;
}
export interface ErrorMsg extends Base<'error'> {
  rid?: number;
  code: ErrorCode;
  message: string;
}
/** Full room snapshot, sent on join and on resume. */
export interface RoomMsg extends Base<'room'> {
  room: RoomInfo;
  you: PlayerId;
}
export interface PlayerJoinedMsg extends Base<'player_joined'> {
  player: PlayerInfo;
}
export interface PlayerLeftMsg extends Base<'player_left'> {
  playerId: PlayerId;
  reason: LeaveReason;
}
export interface PlayerDisconnectedMsg extends Base<'player_disconnected'> {
  playerId: PlayerId;
}
export interface PlayerReconnectedMsg extends Base<'player_reconnected'> {
  playerId: PlayerId;
}
export interface HostChangedMsg extends Base<'host_changed'> {
  hostId: PlayerId;
  previousHostId: PlayerId;
}
export interface MessageMsg extends Base<'message'> {
  from: PlayerId;
  d: Json;
  /** When the server received it (ms since the epoch, server clock; compare with `relay.now()`). */
  at: number;
}
/**
 * A `message` in the short form an SDK asks for with `/ws?compact=1`: `s` is the sender's room
 * slot (`PlayerInfo.slot`) instead of its id, and there's no `v`. A relayed message is most of a
 * game's traffic, and its envelope was about half of each one.
 */
export interface CompactMessageMsg {
  t: 'm';
  s: number;
  d: Json;
  at: number;
}
/** The room has a new seed (the host asked for one). Sent to everyone, the host included. */
export interface SeedMsg extends Base<'seed'> {
  seed: number;
  from: PlayerId;
}
export interface ChatReceivedMsg extends Base<'chat'> {
  message: ChatMessage;
}
export interface StateMsg extends Base<'state'> {
  from: PlayerId;
  patch: JsonObject;
  seq: number;
}
/** `playerId` took `key` (sent to everyone, the winner included). */
export interface ClaimedMsg extends Base<'claimed'> {
  key: string;
  playerId: PlayerId;
}
/** `key` is free again; `playerId` held it (released, or it left). */
export interface ReleasedMsg extends Base<'released'> {
  key: string;
  playerId: PlayerId;
}
/** The answer to your `claim`: who holds `key` now (you, if you won); null if the room is at its claim limit. */
export interface ClaimResultMsg extends Base<'claim_result'> {
  key: string;
  holder: PlayerId | null;
}
/** The host changed who may join (`set_access`). Sent to everyone, the host included. */
export interface AccessMsg extends Base<'access'> {
  locked: boolean;
  public: boolean;
  maxPlayers: number;
  from: PlayerId;
}
/** The host changed what room lists show (`set_listing`). Sent to everyone, the host included. */
export interface ListingMsg extends Base<'listing'> {
  name: string | null;
  meta: Json | null;
  from: PlayerId;
}
export interface PongMsg extends Base<'pong'> {
  ts: number;
  serverTime: number;
}
/** Your party changed; `null` = you are no longer in a party. */
export interface PartyMsg extends Base<'party'> {
  party: PartyInfo | null;
}
/** Your party leader moved the party into a room (a `room` snapshot was just sent). */
export interface PartyRoomMsg extends Base<'party_room'> {
  roomId: string;
}
/** You are out of the room: kicked (by its host or the game's owner), or the room was closed. */
export interface RemovedMsg extends Base<'removed'> {
  roomId: string;
  reason: 'kicked' | 'closed';
  /** Optional note from the moderator, shown to the player. */
  message?: string;
}
export interface ServerRestartingMsg extends Base<'server_restarting'> {
  reconnectInMs: number;
}

export type ServerMessage =
  | WelcomeMsg
  | ReplyMsg
  | ErrorMsg
  | RoomMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | PlayerDisconnectedMsg
  | PlayerReconnectedMsg
  | HostChangedMsg
  | MessageMsg
  | ChatReceivedMsg
  | StateMsg
  | SeedMsg
  | ClaimedMsg
  | ReleasedMsg
  | ClaimResultMsg
  | AccessMsg
  | ListingMsg
  | PongMsg
  | ServerRestartingMsg
  | PartyMsg
  | PartyRoomMsg
  | RemovedMsg
  | ServerBatchMsg
  | CompactMessageMsg;

export interface ServerBatchMsg extends Base<'batch'> {
  m: ServerMessage[];
}

export type ServerMessageType = ServerMessage['t'];
