import { describe, expect, test } from 'bun:test';
import { balanceTeams } from '../src/sync/teams';

describe('balanceTeams', () => {
  test('newcomers go to the smallest team, lowest index first', () => {
    expect(balanceTeams(['a', 'b', 'c'], {}, 2, false)).toEqual({ a: 0, b: 1, c: 0 });
  });
  test('nobody already on a team moves', () => {
    expect(balanceTeams(['a', 'b', 'c', 'd'], { a: 0, b: 0, c: 0 }, 2, false)).toEqual({ a: 0, b: 0, c: 0, d: 1 });
  });
  test('rebalance moves the latest joiners off the biggest team', () => {
    expect(balanceTeams(['a', 'b', 'c', 'd'], { a: 0, b: 0, c: 0, d: 1 }, 2, true)).toEqual({ a: 0, b: 0, c: 1, d: 1 });
    expect(balanceTeams(['a', 'b', 'c', 'd', 'e'], { a: 0, b: 0, c: 0, d: 0, e: 0 }, 3, true)).toEqual({ a: 0, b: 0, c: 1, d: 2, e: 1 });
  });
  test('rebalance leaves teams that are already even alone', () => {
    expect(balanceTeams(['a', 'b', 'c'], { a: 1, b: 0, c: 1 }, 2, true)).toEqual({ a: 1, b: 0, c: 1 });
  });
  test('players who left drop out; teams past n are reassigned', () => {
    expect(balanceTeams(['a', 'c'], { a: 0, b: 1, c: 2 }, 2, false)).toEqual({ a: 0, c: 1 });
  });
  test('one team holds everyone', () => {
    expect(balanceTeams(['a', 'b'], {}, 1, false)).toEqual({ a: 0, b: 0 });
  });
});
