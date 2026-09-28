import { describe, expect, test } from 'bun:test';
import { createIdAllocator, kindOf } from '../src/core/ids';

describe('entity ids', () => {
  test('are <kind>:<session>:<n>, counting up', () => {
    const next = createIdAllocator(() => 0.5);
    const a = next('ship');
    const b = next('ship');
    expect(a).toMatch(/^ship:[0-9a-z]{8}:1$/);
    expect(b).toMatch(/^ship:[0-9a-z]{8}:2$/);
    expect(a.split(':')[1]).toBe(b.split(':')[1]);
  });

  test('two page loads never share a session tag', () => {
    const a = createIdAllocator(() => 0.1)('ship');
    const b = createIdAllocator(() => 0.2)('ship');
    expect(a).not.toBe(b);
  });

  test('kindOf reads the kind back', () => {
    expect(kindOf('drone:abcd1234:7')).toBe('drone');
    expect(kindOf('nocolon')).toBe('');
  });
});
