import { LIMITS, TokenBucket } from '@gamerelay/protocol/limits';
import { PROTOCOL_VERSION as V } from '@gamerelay/protocol/types';

/** The most messages the SDK batches into one frame. */
export const MAX_BATCH = 64;

const ITEM_OPEN = `{"v":${V},`;
/** How a batch of `batchItem`s starts on the wire; it ends `]}`. */
export const BATCH_OPEN = `{"v":${V},"t":"batch","m":[`;

/**
 * A queued message as it goes on the wire, with `v`: `{"v":1,` spliced onto its own JSON, so it
 * isn't copied to add `v`. One that has no fields, or a `v` of its own, is copied after all (the
 * splice would write `{"v":1,}` or a second `v`, and the server would refuse the frame).
 */
export function batchItem(m: object): string {
  const json = JSON.stringify(m);
  return json.length > 2 && !('v' in m) ? `${ITEM_OPEN}${json.slice(1)}` : JSON.stringify({ ...m, v: V });
}

/**
 * What the SDK lets itself spend: a little under the server's limit. The server charges frames as
 * they arrive, and frames sent evenly can arrive bunched up (a TCP stall, a busy tab), so pacing at
 * the exact limit would still have the server drop one now and then, and a dropped frame is lost.
 */
export const PACE_PER_SECOND = LIMITS.ratePerSecond * 0.9;
export const PACE_BURST = LIMITS.rateBurst - 16;

/**
 * This connection's rate limit, kept the way the server keeps it (a new bucket per connection,
 * charged per frame, a batch costing one token per message, and a frame it can't pay for dropped
 * whole) but with a margin (PACE_PER_SECOND, PACE_BURST). The outbox sends only what it pays for,
 * and the LAN shortcut asks it whether a broadcast queued now will reach the server.
 */
export class SendBudget {
  #bucket: TokenBucket;

  constructor(now: number) {
    this.#bucket = new TokenBucket(PACE_PER_SECOND, PACE_BURST, now);
  }

  /**
   * A new connection: the server's bucket for it starts full. Called on its welcome, after the
   * server made that bucket, so ours never refills ahead of it.
   */
  reset(now: number): void {
    this.#bucket = new TokenBucket(PACE_PER_SECOND, PACE_BURST, now);
  }

  /** A frame of `cost` messages went out. */
  sent(cost: number, now: number): void {
    this.#bucket.take(now, cost);
  }

  left(now: number): number {
    return this.#bucket.left(now);
  }

  /**
   * Whether a message queued now, behind `queued` others, gets through. It goes out in a frame of up
   * to `MAX_BATCH` that the server charges all at once, so that much has to be left after the queue.
   */
  allows(queued: number, now: number): boolean {
    return this.left(now) - queued >= MAX_BATCH;
  }
}
