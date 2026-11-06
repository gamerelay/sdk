import type { ErrorCode, ModerationReason } from '@gamerelay/protocol/types';

/**
 * Every `code` a `GameRelayError` can have: the server's codes, plus the SDK's own.
 * - `sign_in_expired`: your `idToken` returned an expired token (a cached one, or a device clock
 *   far off); reconnects keep asking it for a fresh one.
 * - `sign_in_required`: the game only lets signed-in players join, and nobody is signed in (or it's
 *   the provider's guest account). Show your sign-in, then connect again; reconnects stop.
 */
export type GameRelayErrorCode = ErrorCode | 'disconnected' | 'host_changed' | 'timeout' | 'sign_in_expired' | 'sign_in_required';

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

/**
 * A text moderation refused (`relay.moderate`, `relay.setName`): code `moderated`. `message` is
 * fine to show a player ("Invalid name: offensive language"); games that translate use `reason`.
 */
export class GameRelayModerationError extends GameRelayError {
  declare readonly code: 'moderated';
  constructor(
    /**
     * Why: `offensive`, `reserved`, `link`, `blocked`, `unsafe`, `charset`, `too_short`,
     * `too_long`, `empty`, or `unchecked` (the game's own server didn't answer in time, and the
     * game refuses names it can't check).
     */
    readonly reason: ModerationReason,
    message: string,
    /** The text that was checked. */
    readonly text: string,
    /** What the text was checked as: a name. */
    readonly type: 'name' = 'name',
  ) {
    super('moderated', message);
    this.name = 'GameRelayModerationError';
  }
}
