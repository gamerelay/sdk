import { describe, expect, test } from 'bun:test';
import { DelayEstimator } from '../src/core/clock';

describe('DelayEstimator', () => {
  test('starts at 100 ms and jumps to the first estimate', () => {
    const d = new DelayEstimator();
    expect(d.ms).toBe(100);
    d.observe(40, 50);
    expect(d.ms).toBe(90); // 40 age + 50 interval + 3 × 0 variation
  });

  test('steady ages converge on age + interval', () => {
    const d = new DelayEstimator();
    for (let i = 0; i < 400; i++) d.observe(30, 50);
    expect(d.ms).toBeCloseTo(80, 0);
  });

  test('jittery ages add margin', () => {
    const d = new DelayEstimator();
    for (let i = 0; i < 400; i++) d.observe(i % 2 ? 10 : 70, 50);
    expect(d.ms).toBeGreaterThan(150);
  });

  test('moves gradually, never jumping after the first sample', () => {
    const d = new DelayEstimator();
    d.observe(30, 50);
    const before = d.ms;
    d.observe(300, 50);
    expect(d.ms - before).toBeLessThan(20);
  });

  test('stays within 60–500 ms', () => {
    const low = new DelayEstimator();
    low.observe(0, 1);
    expect(low.ms).toBe(60);
    const high = new DelayEstimator();
    high.observe(2000, 50);
    expect(high.ms).toBe(500);
  });
});
