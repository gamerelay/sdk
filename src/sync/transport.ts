import type { Json, PlayerId, PlayerInfo } from '@gamerelay/protocol/types';

/** What the sync modules need from a room: sending, the server clock, and who's who. */
export interface SyncTransport {
  readonly me: PlayerId;
  /** `host`: a host-only write, which the server drops if we're no longer the host. */
  send(data: Json, options: { to?: PlayerId; reliable: boolean; host?: boolean }): void;
  /** The server's clock (ms), as estimated by `relay.now()`. */
  now(): number;
  player(id: PlayerId): PlayerInfo | undefined;
  /** The room's current host (host-owned entities need it; without it they can't be created). */
  hostId?(): PlayerId;
  /**
   * The server-clock moment the game's current write stands for: inside a `relay.tick` step, the
   * step's scheduled time (the timer may wake late); otherwise now. Default: `now()`.
   */
  writeTime?(): number;
  /** False while disconnected: sync modules hold their sends. Default: always ready. */
  ready?(): boolean;
}
