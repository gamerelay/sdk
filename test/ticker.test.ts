import { describe, expect, jest, spyOn, test } from 'bun:test';
import { MAX_CATCH_UP, Ticker, intervalScheduler, pickScheduler, workerScheduler, type Scheduler } from '../src/core/ticker';

function fake() {
  let now = 0;
  let wake: (() => void) | null = null;
  const schedule: Scheduler = (_ms, w) => {
    wake = w;
    return () => {
      wake = null;
    };
  };
  return {
    ticker: new Ticker({ now: () => now, schedule }),
    advance(ms: number) {
      now += ms;
      wake?.();
    },
    get running() {
      return wake !== null;
    },
  };
}

describe('Ticker', () => {
  test('runs at a fixed step with a constant dt and a tick counter', () => {
    const f = fake();
    const calls: [number, number][] = [];
    f.ticker.add(20, (dt, tick) => calls.push([dt, tick]));
    for (let i = 0; i < 6; i++) f.advance(1000 / 60); // 100 ms
    expect(calls).toEqual([
      [0.05, 1],
      [0.05, 2],
    ]);
  });

  test(`after a stall, catches up at most ${MAX_CATCH_UP} steps, then drops the backlog`, () => {
    const f = fake();
    let n = 0;
    f.ticker.add(20, () => n++);
    f.advance(1000);
    expect(n).toBe(MAX_CATCH_UP);
    f.advance(50);
    expect(n).toBe(MAX_CATCH_UP + 1);
  });

  test('removing the last loop stops the scheduler', () => {
    const f = fake();
    const off = f.ticker.add(20, () => {});
    expect(f.running).toBe(true);
    off();
    expect(f.running).toBe(false);
  });

  test('a throwing loop is logged and the others keep running', () => {
    const f = fake();
    const err = spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    f.ticker.add(20, () => {
      throw new Error('boom');
    });
    f.ticker.add(20, () => n++);
    f.advance(50);
    expect(n).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  test('stepTime is each step’s scheduled time, however late the timer woke', () => {
    const f = fake();
    const at: (number | null)[] = [];
    f.ticker.add(30, () => at.push(f.ticker.stepTime()));
    for (const ms of [20, 13, 40, 7, 30]) f.advance(ms); // irregular wakes: 20, 33, 73, 80, 110
    expect(at.map((t) => Math.round(t! * 10) / 10)).toEqual([33.3, 66.7, 100]);
    expect(f.ticker.stepTime()).toBeNull(); // outside a step
  });

  test('after a dropped backlog, step times end at the wake', () => {
    const f = fake();
    const at: number[] = [];
    f.ticker.add(60, () => at.push(f.ticker.stepTime()!));
    f.advance(1000);
    expect(at).toHaveLength(MAX_CATCH_UP);
    expect(at.at(-1)).toBeCloseTo(1000, 5);
    expect(at[0]).toBeCloseTo(1000 - (MAX_CATCH_UP - 1) * (1000 / 60), 5);
  });

  test('rates outside 1–240 throw', () => {
    const f = fake();
    expect(() => f.ticker.add(0, () => {})).toThrow(/between 1 and 240/);
  });

  test('outside a browser, the scheduler is setInterval', () => {
    expect(pickScheduler(() => {})).toBe(intervalScheduler);
  });
});

describe('workerScheduler', () => {
  test('a worker error after stop() starts no fallback interval (SDK review #18)', () => {
    const g = globalThis as { Worker?: unknown };
    const saved = g.Worker;
    const workers: { onerror: ((e: { preventDefault(): void }) => void) | null; terminated: boolean }[] = [];
    g.Worker = class {
      onmessage: (() => void) | null = null;
      onerror: ((e: { preventDefault(): void }) => void) | null = null;
      terminated = false;
      constructor() {
        workers.push(this);
      }
      postMessage() {}
      terminate() {
        this.terminated = true;
      }
    };
    jest.useFakeTimers();
    try {
      let fellBack = 0;
      let woke = 0;
      const stop = workerScheduler(() => fellBack++)(10, () => woke++);
      stop();
      workers[0]!.onerror!({ preventDefault() {} }); // (an error event already queued)
      jest.advanceTimersByTime(100);
      expect(fellBack).toBe(0);
      expect(woke).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      // Still running, an error falls back to an interval, and stop() clears it.
      const stop2 = workerScheduler(() => fellBack++)(10, () => woke++);
      workers[1]!.onerror!({ preventDefault() {} });
      jest.advanceTimersByTime(35);
      expect(fellBack).toBe(1);
      expect(woke).toBe(3);
      stop2();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
      g.Worker = saved;
    }
  });
});
