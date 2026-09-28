import type { ErrorCode } from '@gamerelay/protocol/types';

export class GameRelayError extends Error {
  constructor(
    readonly code: ErrorCode | 'disconnected' | 'host_changed' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'GameRelayError';
  }
}
