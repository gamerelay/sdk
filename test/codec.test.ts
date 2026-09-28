import { describe, expect, test } from 'bun:test';
import { FULL, compileSchema, checkValue, decodeChanges, encodeChanges, isEntry, roundTo } from '../src/core/codec';

const ship = () => compileSchema('ship', { x: 'number', h: 'angle', alive: 'flag', name: 'text', inv: 'value' });

describe('compileSchema', () => {
  test('defaults: precision 0.01, 20 updates per second, stable hash', () => {
    const s = ship();
    expect(s.fields.map((f) => [f.name, f.type, f.precision])).toEqual([
      ['x', 'number', 0.01],
      ['h', 'angle', 0.01],
      ['alive', 'flag', 0.01],
      ['name', 'text', 0.01],
      ['inv', 'value', 0.01],
    ]);
    expect(s.rate).toBe(20);
    expect(s.index.get('alive')).toBe(2);
    expect(ship().hash).toBe(s.hash);
    expect(compileSchema('ship', { x: 'number' }).hash).not.toBe(s.hash);
  });

  test('long form sets precision and smoothing', () => {
    const smooth = () => 1;
    const s = compileSchema('ship', { x: { type: 'number', precision: 1, smooth } }, 30);
    expect(s.fields[0]).toMatchObject({ precision: 1, smooth });
    expect(s.rate).toBe(30);
  });

  test('bad definitions throw with the fix in the message', () => {
    expect(() => compileSchema('9ship', { x: 'number' })).toThrow(/must start with a letter/);
    expect(() => compileSchema('ship', {})).toThrow(/give 1 to 32 fields/);
    expect(() => compileSchema('ship', { x: 'float' as never })).toThrow(/needs a type/);
    expect(() => compileSchema('ship', { owner: 'text' })).toThrow(/can't be a field name/);
    expect(() => compileSchema('ship', { x: 'number' }, 0)).toThrow(/rate/);
  });
});

describe('the size of one entity', () => {
  test('a kind whose update could pass the message limit is refused at define time', () => {
    const v = { type: 'value' } as const;
    expect(() => compileSchema('big', { a: v, b: v, c: v })).not.toThrow();
    expect(() => compileSchema('big', { a: v, b: v, c: v, d: v })).toThrow(/could reach about 16 KB/);
    const t = { type: 'text' } as const;
    const texts = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, t]));
    expect(() => compileSchema('texts', texts(16))).not.toThrow();
    // 32 × 256 characters is up to ~24 KB of UTF-8: too big for one message.
    expect(() => compileSchema('texts', texts(32))).toThrow(/over the 13 KB limit/);
  });
});

describe('checkValue', () => {
  const s = ship();
  test('accepts the right types', () => {
    expect(() => checkValue('ship', s.fields[0]!, 1.5)).not.toThrow();
    expect(() => checkValue('ship', s.fields[2]!, false)).not.toThrow();
    expect(() => checkValue('ship', s.fields[4]!, { a: [1] })).not.toThrow();
  });
  test('rejects wrong types', () => {
    expect(() => checkValue('ship', s.fields[0]!, '1')).toThrow("ship.x is a 'number' field; got string");
    expect(() => checkValue('ship', s.fields[0]!, Number.NaN)).toThrow(/got NaN/);
    expect(() => checkValue('ship', s.fields[2]!, 1)).toThrow(/'flag' field/);
    expect(() => checkValue('ship', s.fields[4]!, () => 1)).toThrow(/'value' field/);
    expect(() => checkValue('ship', s.fields[4]!, { big: 'x'.repeat(5000) })).toThrow(/over 4 KB/);
    expect(() => checkValue('ship', s.fields[3]!, 'é'.repeat(200))).not.toThrow();
  });
});

test('roundTo', () => {
  expect(roundTo(1.23456, 0.01)).toBe(1.23);
  expect(roundTo(0.1 + 0.2, 0.01)).toBe(0.3);
  expect(roundTo(17.6, 1)).toBe(18);
});

describe('encodeChanges / decodeChanges', () => {
  test('first time sends everything; then only what changed', () => {
    const s = ship();
    const sent: unknown[] = [];
    const values: unknown[] = [1.234, 0.5, true, 'ada', { k: 1 }];
    const first = encodeChanges(s, values, sent, false);
    expect(first.pairs).toEqual([0, 1.23, 1, 0.5, 2, true, 3, 'ada', 4, { k: 1 }]);
    expect(first.discrete).toBe(true);
    values[0] = 1.2341; // rounds to the same wire value
    values[1] = 0.75;
    const second = encodeChanges(s, values, sent, false);
    expect(second.pairs).toEqual([1, 0.75]);
    expect(second.discrete).toBe(false);
    values[4] = { k: 1 }; // equal JSON, new object
    expect(encodeChanges(s, values, sent, false).pairs).toEqual([]);
    values[2] = false;
    expect(encodeChanges(s, values, sent, false)).toEqual({ pairs: [2, false], discrete: true });
    expect(encodeChanges(s, values, sent, true).pairs.length).toBe(10);
  });

  test('decode gives a sparse array, or null when malformed', () => {
    const s = ship();
    const out = decodeChanges(s, [1, 0.5, 2, false]);
    expect(out).toEqual([undefined, 0.5, false, undefined, undefined]);
    expect(decodeChanges(s, [1])).toBeNull();
    expect(decodeChanges(s, [9, 1])).toBeNull();
    expect(decodeChanges(s, [0, 'x'])).toBeNull();
    expect(decodeChanges(s, 'nope')).toBeNull();
  });

  test('isEntry', () => {
    expect(isEntry(['ship:a:1', FULL, [0, 1], 'h'])).toBe(true);
    expect(isEntry(['ship:a:1', 0, []])).toBe(true);
    expect(isEntry([1, 0, []])).toBe(false);
    expect(isEntry(['ship:a:1', 0])).toBe(false);
  });
});
