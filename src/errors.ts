import type { ErrorCode } from '@gamerelay/protocol/types';

/** Every `code` a `GameRelayError` can have: the server's codes, plus the SDK's own three. */
export type GameRelayErrorCode = ErrorCode | 'disconnected' | 'host_changed' | 'timeout';

/** What every SDK call rejects or throws with: check `err.code`. */
export class GameRelayError extends Error {
  constructor(
    readonly code: GameRelayErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GameRelayError';
  }
}
