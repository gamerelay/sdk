import { describe, expect, test } from 'bun:test';
import { createIdAllocator, kindOf, mintedBy, ownerTag } from '../src/core/ids';

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

  test('an owner’s ids end their session in its tag, which only that sender matches (security review)', () => {
    const next = createIdAllocator(() => 0.5);
    const id = next('ship', 'p_ada');
    expect(id).toMatch(/^ship:[0-9a-z]{15}:1$/);
    const session = id.split(':')[1]!;
    expect(session.slice(8)).toBe(ownerTag('p_ada'));
    expect(mintedBy(session, 'p_ada')).toBe(true);
    expect(mintedBy(session, 'p_bo')).toBe(false);
    expect(mintedBy('vsess000', 'p_bo')).toBeUndefined(); // an older SDK's: can't be told
  });

  test('kindOf reads the kind back', () => {
    expect(kindOf('drone:abcd1234:7')).toBe('drone');
    expect(kindOf('nocolon')).toBe('');
  });
});
