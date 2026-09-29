import { LIMITS } from '@gamerelay/protocol/limits';
import type { Warn } from '../debug/warnings';
import type { ClaimResultMsg, ClaimedMsg, PlayerId, ReleasedMsg } from '@gamerelay/protocol/types';
import { GameRelayError } from '../errors';

export interface ClaimDeps {
  me: PlayerId;
  isHost(): boolean;
  queue(message: { t: 'claim' | 'release'; key: string }): void;
  fire(event: 'claimed' | 'released', key: string, playerId: PlayerId): void;
  warn: Warn;
  /** A local monotonic clock, ms. */
  now(): number;
  /** False while we're not back in the room: time offline doesn't count toward a retry. */
  ready?(): boolean;
}

/**
 * A claim with no answer this long is sent again. Claims go out in batches without a request id, so
 * a frame the server dropped (its rate limit) loses the claim silently; a repeat is safe, as the
 * server answers it with whoever holds the key.
 */
export const CLAIM_RETRY_MS = 5000;
/** Sends of one claim before it gives up and settles from the table (`claimed` broadcasts). */
export const CLAIM_TRIES = 3;

interface Waiting {
  promise: Promise<boolean>;
  resolve: (won: boolean) => void;
  /** When it was last sent (the local clock). */
  at: number;
  tries: number;
}

function checkKey(where: string, key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length < 1 || key.length > LIMITS.maxClaimKeyLength) {
    throw new GameRelayError('bad_request', `${where}: the key must be a string of 1–${LIMITS.maxClaimKeyLength} characters, e.g. the entity id of the thing being taken`);
  }
}

/**
 * Take-once claims, decided by the server. The table here mirrors the server's and changes only on
 * its `claimed` / `released` broadcasts, so every client sees the same order. A claim waits for the
 * server's `claim_result`; across a reconnect, `sync` settles it from the resent table instead.
 */
export class Claims {
  readonly #d: ClaimDeps;
  readonly #held = new Map<string, PlayerId>();
  readonly #waiting = new Map<string, Waiting>();
  #warnedLimit = false;

  constructor(deps: ClaimDeps) {
    this.#d = deps;
  }

  claim(key: string): Promise<boolean> {
    checkKey(`room.claim(${JSON.stringify(key)})`, key);
    const holder = this.#held.get(key);
    if (holder !== undefined) return Promise.resolve(holder === this.#d.me);
    const waiting = this.#waiting.get(key);
    if (waiting) return waiting.promise;
    let resolve!: (won: boolean) => void;
    const promise = new Promise<boolean>((r) => (resolve = r));
    this.#waiting.set(key, { promise, resolve, at: this.#d.now(), tries: 1 });
    this.#d.queue({ t: 'claim', key });
    return promise;
  }

  release(key: string): void {
    checkKey(`room.release(${JSON.stringify(key)})`, key);
    const holder = this.#held.get(key);
    if (holder === undefined) return;
    if (holder !== this.#d.me && !this.#d.isHost()) {
      throw new GameRelayError('not_host', `room.release('${key}'): only the player holding it, or the host, can release a claim`);
    }
    this.#d.queue({ t: 'release', key });
  }

  holder(key: string): PlayerId | null {
    return this.#held.get(key) ?? null;
  }

  receive(message: ClaimedMsg | ReleasedMsg | ClaimResultMsg): void {
    switch (message.t) {
      case 'claimed':
        this.#held.set(message.key, message.playerId);
        this.#d.fire('claimed', message.key, message.playerId);
        return;
      case 'released':
        this.#held.delete(message.key);
        this.#d.fire('released', message.key, message.playerId);
        return;
      case 'claim_result': {
        if (message.holder === null && !this.#warnedLimit) {
          this.#warnedLimit = true;
          this.#d.warn('claims', 'claims:limit', `this room holds ${LIMITS.maxClaims} claims; release keys you're done with (room.release)`);
        }
        this.#settle(message.key, message.holder === this.#d.me);
        return;
      }
    }
  }

  /** After a (re)join: adopt the server's table, fire events for what changed, settle or re-send pending claims. */
  sync(table: Record<string, PlayerId>): void {
    for (const [key, holder] of [...this.#held]) {
      if (table[key] === holder) continue;
      this.#held.delete(key);
      this.#d.fire('released', key, holder);
    }
    for (const [key, holder] of Object.entries(table)) {
      if (this.#held.get(key) === holder) continue;
      this.#held.set(key, holder);
      this.#d.fire('claimed', key, holder);
    }
    for (const [key, waiting] of [...this.#waiting]) {
      const holder = this.#held.get(key);
      if (holder !== undefined) this.#settle(key, holder === this.#d.me);
      else {
        // The claim or its answer was lost with the socket: a fresh start.
        waiting.at = this.#d.now();
        waiting.tries = 1;
        this.#d.queue({ t: 'claim', key });
      }
    }
  }

  /**
   * Called by the room's loop: re-send claims that got no answer, and after the last try settle
   * them from the table, so a claim never hangs. A late answer after that is ignored.
   */
  tick(): void {
    const now = this.#d.now();
    const ready = this.#d.ready?.() ?? true;
    for (const [key, waiting] of this.#waiting) {
      if (!ready) waiting.at = now; // the rejoin's `sync` re-sends it
      if (now - waiting.at < CLAIM_RETRY_MS) continue;
      if (waiting.tries >= CLAIM_TRIES) {
        const won = this.#held.get(key) === this.#d.me;
        this.#d.warn('claims', 'claims:timeout', `room.claim('${key}'): the server didn't answer ${CLAIM_TRIES} tries in ${(CLAIM_TRIES * CLAIM_RETRY_MS) / 1000} s, so it resolved ${won}; if the claim did land, room.on('claimed') reports it`);
        this.#settle(key, won);
        continue;
      }
      waiting.at = now;
      waiting.tries++;
      this.#d.queue({ t: 'claim', key });
    }
  }

  /** The room closed: pending claims resolve false. */
  close(): void {
    for (const key of [...this.#waiting.keys()]) this.#settle(key, false);
  }

  #settle(key: string, won: boolean): void {
    const waiting = this.#waiting.get(key);
    if (!waiting) return;
    this.#waiting.delete(key);
    waiting.resolve(won);
  }
}
