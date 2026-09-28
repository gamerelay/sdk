import { describe, expect, test } from 'bun:test';
import type { JsonObject, PlayerInfo, RoomInfo } from '@gamerelay/protocol/types';
import { looksPositional } from '../src/debug/rate';
import { Room, type GameRelay } from '../src/index';

const player = (id: string, slot: number): PlayerInfo => ({ id, name: id, avatar: null, joinedAt: slot, connected: true, slot });

/** A Room on a stand-in relay that records what it would send and warn. */
function makeRoom(me: string, info: Partial<RoomInfo>) {
  const queued: { t: string; patch?: JsonObject }[] = [];
  const warned: string[] = [];
  const messages: string[] = [];
  const clock = { now: 1000 };
  const loops: (() => void)[] = [];
  const relay = {
    connected: true,
    room: null,
    queue: (m: { t: string; patch?: JsonObject }) => queued.push(m),
    now: () => clock.now,
    tick: (_rate: number, fn: () => void) => (loops.push(fn), () => {}),
    warn: (_kind: string, key: string, message: string) => (warned.push(key), messages.push(message)),
    newEntityId: (kind: string) => `${kind}:t:1`,
    request: async () => undefined,
  } as unknown as GameRelay;
  const full: RoomInfo = { id: 'r', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId: 'pa', players: [], state: {}, stateSeq: 0, chat: [], seed: 1, claims: {}, ...info };
  return { room: new Room(relay, full, me), queued, warned, messages, clock, step: () => loops.forEach((fn) => fn()) };
}

describe('Room resync', () => {
  test('becoming host in a resync keeps the teams the room has now, not our stale copy', () => {
    const stale = { $teams: { pa: 0, pb: 1, pc: 0 }, $teamCount: 2 };
    const { room, queued } = makeRoom('pb', { hostId: 'pa', players: [player('pa', 0), player('pb', 1), player('pc', 2)], state: stale });
    const fresh = { $teams: { pa: 0, pb: 1, pc: 1, pd: 0 }, $teamCount: 2 };
    room.sync({
      id: 'r', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId: 'pb', stateSeq: 5, chat: [], seed: 1, claims: {},
      players: [player('pa', 0), player('pb', 1), player('pc', 2), player('pd', 3)],
      state: fresh,
    });
    expect(room.isHost).toBe(true);
    expect(queued.filter((m) => m.t === 'set_state')).toEqual([]);
    expect(room.teamOf('pc')).toBe(1);
  });
});

describe('setState rate warning', () => {
  const host = () => makeRoom('pa', { hostId: 'pa', players: [player('pa', 0)] });

  test('10 calls spread over 900 ms stay quiet', () => {
    const { room, warned, clock } = host();
    for (let i = 0; i < 10; i++) {
      room.setState({ n: i });
      clock.now += 90;
    }
    expect(warned).toEqual([]);
  });

  test('11 calls in one second warn once, naming the fix', () => {
    const { room, warned, messages } = host();
    for (let i = 0; i < 12; i++) room.setState({ n: i });
    expect(warned).toEqual(['set_state']);
    expect(messages[0]).toContain('use room.define + room.spawn');
  });

  test("a timer's handler batch counts once, however many setState calls it makes", () => {
    const { room, warned, clock, step } = host();
    room.on('timer', 'round', () => {
      for (let i = 0; i < 12; i++) room.setState({ n: i });
    });
    room.timer('round', 10);
    clock.now += 20;
    step();
    expect(room.state.n).toBe(11);
    expect(warned).toEqual([]);
  });
});

describe('raw send of positions', () => {
  test('21 position sends in a second warn once; 20 do not', () => {
    const a = makeRoom('pa', { hostId: 'pa', players: [player('pa', 0)] });
    for (let i = 0; i < 20; i++) a.room.send({ x: i, y: 2 });
    expect(a.warned).toEqual([]);
    a.room.send({ x: 21, y: 2 });
    a.room.send({ x: 22, y: 2 });
    expect(a.warned).toEqual(['send_positions']);
  });

  test('fast sends without positions, and a single tap with a position, stay quiet', () => {
    const a = makeRoom('pa', { hostId: 'pa', players: [player('pa', 0)] });
    for (let i = 0; i < 50; i++) a.room.send({ type: 'chat', text: 'hi' });
    a.room.send({ type: 'click', x: 1, y: 2 });
    expect(a.warned).toEqual([]);
  });
});

test('looksPositional', () => {
  expect(looksPositional({ x: 1, y: 2 })).toBe(true);
  expect(looksPositional({ type: 'p', pos: { x: 1, y: 2 } })).toBe(true);
  expect(looksPositional([{ x: 1, y: 2, id: 'a' }])).toBe(true);
  expect(looksPositional({ x: '1', y: 2 })).toBe(false);
  expect(looksPositional({ score: 3 })).toBe(false);
  expect(looksPositional('xy')).toBe(false);
  expect(looksPositional(null)).toBe(false);
});

describe('guessed event names', () => {
  test('room.on("playerJoined") warns with the built-in name; real names and customs stay quiet', () => {
    const { room, warned, messages } = makeRoom('pa', { hostId: 'pa', players: [player('pa', 0)] });
    room.on('playerJoined', () => {});
    room.on('player_joined', () => {});
    room.on('hit', () => {});
    room.on('host', () => {});
    room.on('constructor', () => {});
    expect(warned).toEqual(['event_name:playerJoined']);
    expect(messages).toEqual([
      "room.on('playerJoined') is a custom event (only room.emit('playerJoined') fires it); the built-in for a player arriving is room.on('player_joined')",
    ]);
  });

  test('a guessed name still works as a custom event', () => {
    const { room } = makeRoom('pa', { hostId: 'pa', players: [player('pa', 0)] });
    let got = 0;
    room.on('leave', () => got++);
    room.emit('leave', null, { echo: true });
    expect(got).toBe(1);
  });
});

test("room.timer() and clearTimer() don't count as setState calls (review)", () => {
  const { room, warned } = makeRoom('pa', { hostId: 'pa', players: [player('pa', 0)] });
  for (let i = 0; i < 8; i++) room.timer(`respawn:${i}`, 1000);
  for (let i = 0; i < 8; i++) room.clearTimer(`respawn:${i}`);
  expect(warned).toEqual([]);
});
