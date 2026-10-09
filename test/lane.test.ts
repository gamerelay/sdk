import { expect, test } from 'bun:test';
import { lane } from '../src/core/lane';

test('a simulated network lane delivers in the order it was given, across millisecond edges', async () => {
  const send = lane({ latency: 20, jitter: 8 });
  const got: number[] = [];
  const n = 3000;
  for (let i = 0; i < n; i++) {
    send(() => got.push(i));
    // Spread the sends over several milliseconds, a few per tick, like a game's frames.
    if (i % 50 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  while (got.length < n) await new Promise((r) => setTimeout(r, 10));
  const outOfOrder = got.findIndex((v, i) => i > 0 && v < got[i - 1]!);
  expect(outOfOrder).toBe(-1);
});

test('the lane still delays: nothing arrives before half the latency less the jitter', async () => {
  const send = lane({ latency: 100, jitter: 10 });
  const t0 = performance.now();
  const at = await new Promise<number>((r) => send(() => r(performance.now())));
  expect(at - t0).toBeGreaterThanOrEqual(39);
});
