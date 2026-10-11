import { describe, expect, test } from 'bun:test';
import { SampleBuffer, angleDelta, type BufferField } from '../src/core/buffer';

const XY: BufferField[] = [{ kind: 'linear' }, { kind: 'linear' }];

describe('angleDelta', () => {
  test('takes the short way round, including negative differences', () => {
    expect(angleDelta(0, 0.5)).toBeCloseTo(0.5);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(angleDelta(0, -7)).toBeCloseTo(-7 + 2 * Math.PI);
    expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI);
  });
});

describe('SampleBuffer', () => {
  test('interpolates between the samples around t', () => {
    const b = new SampleBuffer(XY);
    b.push(0, [0, 0]);
    b.push(100, [10, 20]);
    expect(b.read(50)).toEqual([5, 10]);
  });

  test('before the first sample, shows the first sample', () => {
    const b = new SampleBuffer(XY);
    b.push(100, [3, 4]);
    expect(b.read(0)).toEqual([3, 4]);
  });

  test('past the newest sample, extrapolates for at most 250 ms, then holds', () => {
    const b = new SampleBuffer(XY);
    b.push(0, [0, 0]);
    b.push(100, [10, 0]);
    expect(b.read(150)[0]).toBeCloseTo(15);
    expect(b.read(350)[0]).toBeCloseTo(35);
    expect(b.read(5000)[0]).toBeCloseTo(35);
  });

  test('never extrapolates from samples far apart (a rest keyframe, then the first move)', () => {
    const b = new SampleBuffer(XY);
    b.push(0, [0, 0]); // resting keyframe
    b.push(600, [15, 0]); // first sample after it started moving
    expect(b.read(700)[0]).toBe(15); // hold, not 15 + 15/600 × 100
  });

  test('angles interpolate across ±π the short way', () => {
    const b = new SampleBuffer([{ kind: 'angle' }]);
    b.push(0, [3]);
    b.push(100, [-3]);
    const mid = b.read(50)[0] as number;
    expect(Math.abs(mid)).toBeGreaterThan(3); // near ±π, not near 0
  });

  test('step fields show the earlier sample until the next one', () => {
    const b = new SampleBuffer([{ kind: 'linear' }, { kind: 'step' }]);
    b.push(0, [0, true]);
    b.push(100, [10, false]);
    expect(b.read(99)[1]).toBe(true);
    expect(b.read(100)[1]).toBe(false);
  });

  test('undefined values carry forward from the previous sample', () => {
    const b = new SampleBuffer(XY);
    b.push(0, [1, 2]);
    b.push(100, [undefined, 4]);
    expect(b.read(100)).toEqual([1, 4]);
  });

  test('a teleport sample snaps: hold the old value until its time, then jump', () => {
    const b = new SampleBuffer(XY);
    b.push(0, [0, 0]);
    b.push(100, [900, 0], true);
    expect(b.read(50)[0]).toBe(0);
    expect(b.read(99)[0]).toBe(0);
    expect(b.read(100)[0]).toBe(900);
  });

  test('an unannounced jump far beyond normal movement snaps and is reported', () => {
    const b = new SampleBuffer(XY);
    let jumped = false;
    for (let i = 0; i <= 5; i++) jumped ||= b.push(i * 50, [i * 5, 0]);
    expect(jumped).toBe(false);
    expect(b.push(300, [2000, 0])).toBe(true);
    expect(b.read(275)[0]).toBe(25); // held, not sliding toward 2000
  });

  test('a fast start after a long rest snaps at most once, then the estimate recovers', () => {
    const b = new SampleBuffer(XY);
    for (let i = 0; i < 10; i++) b.push(i * 200, [0, 0]); // rate 5, resting
    const jumps: boolean[] = [];
    for (let i = 1; i <= 10; i++) jumps.push(b.push(2000 + i * 200, [i * 150, 0])); // 750 units/s
    expect(jumps.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(jumps.slice(2).some(Boolean)).toBe(false);
  });

  test('starting to move is not a jump', () => {
    const b = new SampleBuffer(XY);
    for (let i = 0; i < 5; i++) b.push(i * 50, [0, 0]);
    expect(b.push(250, [30, 0])).toBe(false);
  });

  test('custom smoothing and smoothing off', () => {
    const b = new SampleBuffer([{ kind: 'linear', smooth: () => 42 }, { kind: 'linear', smooth: false }]);
    b.push(0, [0, 0]);
    b.push(100, [10, 10]);
    expect(b.read(50)).toEqual([42, 0]);
  });

  test('samples that arrive out of order are placed by time', () => {
    const b = new SampleBuffer(XY);
    b.push(0, [0, 0]);
    b.push(200, [20, 0]);
    b.push(100, [10, 0]);
    expect(b.read(150)[0]).toBeCloseTo(15);
  });

  test('keeps at most `capacity` samples', () => {
    const b = new SampleBuffer(XY, { capacity: 4 });
    for (let i = 0; i < 10; i++) b.push(i, [i, 0]);
    expect(b.size).toBe(4);
    expect(b.latestTime).toBe(9);
  });

  test('a seed sample teaches nothing about the usual step: a real jump after it still snaps (fourth review of #6)', () => {
    const b = new SampleBuffer([{ kind: 'linear' }], { minJump: 50 });
    b.push(0, [0], false, true); // what was shown at a handover
    b.push(100, [300]); // the new host's first update: far from it, but not a step
    for (let t = 150; t <= 250; t += 50) b.push(t, [300 + (t - 100) / 10]); // a steady 5 per sample
    expect(b.push(300, [815])).toBe(true); // a respawn without teleport()
  });

  describe('a late sample (SDK review #8)', () => {
    test('a field it leaves out is the one before it in time, not the newest', () => {
      const b = new SampleBuffer(XY);
      b.push(0, [0, 0]);
      b.push(200, [20, 200]);
      b.push(100, [10, undefined]); // late, and y unchanged since t=0
      expect(b.read(100)).toEqual([10, 0]);
    });

    test('it fills in what the samples after it left out', () => {
      const b = new SampleBuffer(XY);
      b.push(0, [0, 0]);
      b.push(200, [undefined, 50]); // x unchanged since the sender's last send…
      b.push(100, [10, 25]); // …which arrives late: x was 10 by then
      expect(b.read(200)).toEqual([10, 50]);
    });

    test('a teleport is judged against the sample before it, so a late one isn’t a jump', () => {
      const b = new SampleBuffer([{ kind: 'linear' }], { minJump: 50 });
      for (let t = 0; t <= 300; t += 50) b.push(t, [t / 10]); // a steady 5 per sample
      expect(b.push(400, [1000], true)).toBe(false); // a respawn, announced
      // The sample at 350 comes after it: next to 300 (30 → 35) it's an ordinary step.
      expect(b.push(350, [35])).toBe(false);
    });

    test('the samples it fills in are judged again: a filled gap isn’t a jump (fourth review of #8)', () => {
      const b = new SampleBuffer([{ kind: 'linear' }], { minJump: 50 });
      for (let t = 0; t <= 150; t += 50) b.push(t, [t / 10]); // a steady 5 per sample
      b.push(250, [undefined]); // unchanged since the sender's last send…
      b.push(300, [515]); // …so this looks like a jump from 15
      b.push(200, [505]); // the last send, late: 505 by then, so 250 was 505 and 300 is a step of 10
      expect(b.read(275)[0]).toBeCloseTo(510);
    });

    test('older than every sample kept, it doesn’t overwrite values sent after it (review of #8)', () => {
      const b = new SampleBuffer(XY);
      b.push(85, [1, 0]);
      b.push(90, [undefined, 1]); // x unchanged since 85
      b.push(100, [undefined, 2]);
      b.read(105); // 85 is behind what's shown: dropped, but 90 and 100 know their x was sent at 85
      b.push(80, [0, undefined]);
      expect(b.latest()).toEqual([1, 2]);
    });

    test('older than every sample kept, what it carried still reaches the samples that left it out (second review of #8)', () => {
      // A reliable change (held) behind faster updates that leave it out as unchanged since.
      const b = new SampleBuffer([{ kind: 'linear' }, { kind: 'step' }]);
      b.push(90, [1, false]);
      b.push(100, [2, undefined]);
      b.push(110, [3, undefined]);
      b.read(115); // 90 is behind what's shown: dropped
      b.push(95, [undefined, true]);
      expect(b.latest()).toEqual([3, true]);
      expect(b.read(110)).toEqual([3, true]);
    });

    test('the sample after it is judged against it, not an older one: not a jump any more (second review of #8)', () => {
      const b = new SampleBuffer([{ kind: 'linear' }], { minJump: 50 });
      for (let t = 0; t <= 30; t += 10) b.push(t, [t / 10]);
      expect(b.push(200, [200])).toBe(true); // 3 → 200: a jump, next to 30
      b.push(100, [100]); // late: 3 → 100 → 200 is a steady move
      expect(b.read(150)[0]).toBeCloseTo(150);
    });
  });

  test('a seed (what was shown, at a handover) is glided from, but no velocity comes from it', () => {
    const b = new SampleBuffer(XY);
    b.push(1000, [5, 0], false, true);
    b.push(1050, [9, 0]); // the new writer's first update, 50 ms after
    expect(b.read(1025)).toEqual([7, 0]);
    expect(b.read(1200)).toEqual([9, 0]); // held, not 5 → 9 carried on for 250 ms
  });
});

/** A small seeded random generator, so a failing case can be replayed by its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('any arrival order (invariants)', () => {
  const FIELDS: BufferField[] = [{ kind: 'linear' }, { kind: 'linear' }, { kind: 'step' }];
  /**
   * A sender's updates as the SDK sends them: each carries only the fields that changed (a "still
   * here" carries none), and about one in eight is a full update. Returns them with the true values
   * at each update's time.
   */
  function sender(random: () => number, n: number) {
    const truth = [0, 0, 0];
    const out: { t: number; values: (number | undefined)[]; truth: number[] }[] = [];
    for (let i = 0; i < n; i++) {
      const full = random() < 0.125;
      const values = truth.map((_, j) => {
        if (random() < 0.4) truth[j] = truth[j]! + 1 + Math.floor(random() * 5);
        return full ? truth[j] : undefined;
      });
      const prev = out.at(-1)?.truth ?? [0, 0, 0];
      truth.forEach((v, j) => {
        if (v !== prev[j]) values[j] = v;
      });
      out.push({ t: (i + 1) * 10, values, truth: truth.slice() });
    }
    // The first update is the spawn: it carries everything.
    out[0]!.values = out[0]!.truth.slice();
    return out;
  }
  /** Shuffled: `late` of them arrive anywhere, the rest a few places out of order at most. */
  function arrival(random: () => number, n: number, late: number) {
    const order = [...Array(n).keys()];
    for (let i = 0; i < n - 1; i++) if (random() < 0.3) [order[i], order[i + 1]] = [order[i + 1]!, order[i]!];
    for (let k = 0; k < late; k++) {
      const [x] = order.splice(Math.floor(random() * n), 1);
      order.splice(Math.floor(random() * n), 0, x!);
    }
    return order;
  }

  test('with every update kept, each sample ends up with the values the sender had then', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = rng(seed);
      const sent = sender(random, 40);
      const b = new SampleBuffer(FIELDS, { capacity: 1000 });
      for (const i of arrival(random, sent.length, 5)) b.push(sent[i]!.t, sent[i]!.values);
      // Read in time order: each read lands on a sample's time, so it's that sample's values.
      for (const s of sent) expect({ seed, t: s.t, v: b.read(s.t) }).toEqual({ seed, t: s.t, v: s.truth });
    }
  });

  test('with a small buffer dropping old samples, the newest still ends up with the sender’s last values', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = rng(seed);
      const sent = sender(random, 40);
      const b = new SampleBuffer(FIELDS, { capacity: 2 + Math.floor(random() * 6) });
      for (const i of arrival(random, sent.length, 8)) b.push(sent[i]!.t, sent[i]!.values);
      expect({ seed, v: b.latest() }).toEqual({ seed, v: sent.at(-1)!.truth });
    }
  });

  test('a very late sample dropped at once doesn’t move the dropped marker back (fifth review of #8)', () => {
    const b = new SampleBuffer([{ kind: 'linear' }], { capacity: 2 });
    b.push(100, [1]); // D: carries x
    b.push(110, [undefined]);
    b.push(120, [undefined]); // over capacity: D dropped, x was sent at 100
    b.push(50, [7]); // very late, older than everything: dropped at once
    b.push(80, [8]); // later than that one, but still older than D
    expect(b.latest()).toEqual([1]); // not 8: D's value was sent after it
  });

  test('a seed is never extrapolated from, wherever it lands (fifth review of #6)', () => {
    const b = new SampleBuffer([{ kind: 'linear' }]);
    b.push(1000, [50], false, true); // what was shown at the handover
    b.push(960, [10]); // a host update from before it, late
    expect(b.read(1100)).toEqual([50]); // not 50 + (50 − 10) × 100/40 = 150
  });
});
