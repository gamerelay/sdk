import { describe, expect, test } from 'bun:test';
import { LIMITS } from '@gamerelay/protocol/limits';
import { MAX_BATCH, PACE_BURST, PACE_PER_SECOND, SendBudget } from '../src/core/budget';

describe('SendBudget: the server’s rate limit, as the server charges it', () => {
  test('a frame is charged all at once; one the server would drop costs nothing (review 5)', () => {
    const b = new SendBudget(0);
    b.sent(PACE_BURST - 30, 0);
    expect(b.left(0)).toBe(30);
    b.sent(40, 0); // the server drops the whole frame: no tokens spent
    expect(b.left(0)).toBe(30);
    b.sent(30, 0);
    expect(b.left(0)).toBe(0);
  });

  test('a message is allowed only if any frame it ends up in can be paid for (review 5)', () => {
    const b = new SendBudget(0);
    b.sent(PACE_BURST - 30, 0);
    // 30 left: a frame of up to 64 might be dropped, so none of it may race over the LAN.
    expect(b.allows(0, 0)).toBe(false);
    const c = new SendBudget(0);
    expect(c.allows(0, 0)).toBe(true);
    expect(c.allows(PACE_BURST - MAX_BATCH, 0)).toBe(true);
    expect(c.allows(PACE_BURST - MAX_BATCH + 1, 0)).toBe(false); // the queue ahead of it uses the rest
  });

  test('it refills a little under the server’s rate, and holds back a little of its burst', () => {
    expect(PACE_PER_SECOND).toBeLessThan(LIMITS.ratePerSecond);
    expect(PACE_BURST).toBeLessThan(LIMITS.rateBurst);
    const b = new SendBudget(0);
    b.sent(PACE_BURST, 0);
    expect(b.allows(0, 0)).toBe(false);
    expect(b.left(1000)).toBeCloseTo(PACE_PER_SECOND);
    expect(b.allows(0, 1000)).toBe(true);
  });

  test('a new connection starts full, like the server’s new bucket; a resume flush then spends it (review 5)', () => {
    const b = new SendBudget(0);
    b.sent(PACE_BURST, 0);
    b.reset(10);
    expect(b.left(10)).toBe(PACE_BURST);
    b.sent(200, 10); // the outbox kept during the outage goes out at once
    expect(b.allows(0, 10)).toBe(false);
  });
});
