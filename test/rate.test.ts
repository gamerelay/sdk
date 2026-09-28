import { expect, test } from 'bun:test';
import { Rate } from '../src/debug/rate';

test('Rate says true once, on the hit that goes over the limit in a 1 s window', () => {
  const r = new Rate(3);
  expect([0, 10, 20, 30, 40].map((t) => r.hit(t))).toEqual([false, false, false, true, false]);
  expect(r.hit(1100)).toBe(false); // a new window
});
