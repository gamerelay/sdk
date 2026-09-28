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
});
