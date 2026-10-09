import { describe, expect, test } from 'bun:test';
import type { JsonObject, PlayerInfo, RoomInfo } from '@gamerelay/protocol/types';
import { looksPositional } from '../src/debug/rate';
import { GameRelayError, Room, type GameRelay } from '../src/index';
import { CREATE, control } from '../src/internal';

const player = (id: string, slot: number): PlayerInfo => ({ id, name: id, avatar: null, joinedAt: slot, connected: true, slot });

/** A Room on a stand-in relay that records what it would send and warn. */
function makeRoom(me: string, info: Partial<RoomInfo>) {
  const queued: { t: string; patch?: JsonObject }[] = [];
  const warned: string[] = [];
  const messages: string[] = [];
  const clock = { now: 1000 };
  const loops: (() => void)[] = [];
  const requests: Record<string, unknown>[] = [];
  const relay = {
    connected: true,
    room: null,
    queue: (m: { t: string; patch?: JsonObject }) => queued.push(m),
    now: () => clock.now,
    tick: (_rate: number, fn: () => void) => (loops.push(fn), () => {}),
    warn: (_kind: string, key: string, message: string) => (warned.push(key), messages.push(message)),
    newEntityId: (kind: string) => `${kind}:t:1`,
    request: async (m: Record<string, unknown>) => void requests.push(m),
    left: () => {},
  } as unknown as GameRelay;
  const full: RoomInfo = { id: 'r', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId: 'pa', players: [], state: {}, stateSeq: 0, chat: [], seed: 1, claims: {}, ...info };
  return { room: new Room(CREATE, relay as never, full, me), queued, requests, warned, messages, clock, step: () => loops.forEach((fn) => fn()) };
}

describe('Room resync', () => {
  test('becoming host in a resync keeps the teams the room has now, not our stale copy', () => {
    const stale = { $teams: { pa: 0, pb: 1, pc: 0 }, $teamCount: 2 };
    const { room, queued } = makeRoom('pb', { hostId: 'pa', players: [player('pa', 0), player('pb', 1), player('pc', 2)], state: stale });
    const fresh = { $teams: { pa: 0, pb: 1, pc: 1, pd: 0 }, $teamCount: 2 };
    control(room).sync({
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
    expect(messages[0]).toContain('use entities (room.define(kind, fields), then its .spawn())');
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

test('a state patch cannot reach the state object’s prototype: __proto__, constructor and prototype are skipped', () => {
  const { room } = makeRoom('pb', { hostId: 'pa', players: [player('pa', 0), player('pb', 1)] });
  // As the server delivers it: parsed JSON, where `__proto__` is an own key like any other.
  const patch = JSON.parse('{"__proto__":{"isAdmin":true},"constructor":{"name":"x"},"prototype":1,"score":3}') as JsonObject;
  control(room).handle({ v: 1, t: 'state', from: 'pa', patch, seq: 1 } as never);
  expect(room.state.score).toBe(3);
  expect(Object.getPrototypeOf(room.state)).toBe(Object.prototype);
  expect((room.state as Record<string, unknown>).isAdmin).toBeUndefined();
  expect(room.state.constructor).toBe(Object);
  expect(Object.keys(room.state)).toEqual(['score']);
});

describe('host controls', () => {
  const players = [player('pa', 0), player('pb', 1)];
  const host = () => makeRoom('pa', { hostId: 'pa', players });

  test('a non-host is refused before anything is sent', async () => {
    const { room, requests } = makeRoom('pb', { hostId: 'pa', players });
    await expect(room.kick('pa')).rejects.toMatchObject({ code: 'not_host' });
    await expect(room.setAccess({ locked: true })).rejects.toMatchObject({ code: 'not_host' });
    await expect(room.setListing({ name: 'x' })).rejects.toMatchObject({ code: 'not_host' });
    await expect(room.transferHost('pb')).rejects.toMatchObject({ code: 'not_host' });
    expect(requests).toEqual([]);
  });

  test('kick bans by default, and sends the message cleaned up', async () => {
    const { room, requests } = host();
    await room.kick('pb', { message: ' be\nnice ' });
    await room.kick('pb', { ban: false, message: '   ' });
    expect(requests).toEqual([
      { t: 'kick', playerId: 'pb', ban: undefined, message: 'be nice' },
      { t: 'kick', playerId: 'pb', ban: false, message: undefined },
    ]);
    await expect(room.kick('pa')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(room.kick('pb', { message: 'x'.repeat(121) })).rejects.toMatchObject({ code: 'too_large' });
    expect(requests).toHaveLength(2);
  });

  test('setAccess checks maxPlayers against the limits and the players in the room', async () => {
    const { room, requests } = host();
    await expect(room.setAccess({ maxPlayers: 1 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(room.setAccess({ maxPlayers: 65 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(room.setAccess({ maxPlayers: 2.5 })).rejects.toMatchObject({ code: 'bad_request' });
    await room.setAccess({ maxPlayers: 2, locked: true });
    expect(requests).toEqual([{ t: 'set_access', locked: true, public: undefined, maxPlayers: 2 }]);
  });

  test('setListing checks the name and the size of meta (in UTF-8 bytes)', async () => {
    const { room, requests } = host();
    await expect(room.setListing({ name: 'x'.repeat(49) })).rejects.toMatchObject({ code: 'too_large' });
    await expect(room.setListing({ meta: { s: 'é'.repeat(260) } })).rejects.toMatchObject({ code: 'too_large' }); // 260 characters, 520+ bytes
    await room.setListing({ name: '  Pro\tlobby ', meta: { lap: 1 } });
    await room.setListing({ name: null, meta: null });
    expect(requests).toEqual([
      { t: 'set_listing', name: 'Pro lobby', meta: { lap: 1 } },
      { t: 'set_listing', name: null, meta: null },
    ]);
  });

  test('transferHost refuses yourself', async () => {
    const { room, requests } = host();
    await expect(room.transferHost('pa')).rejects.toMatchObject({ code: 'bad_request' });
    await room.transferHost('pb');
    expect(requests).toEqual([{ t: 'transfer_host', playerId: 'pb' }]);
  });

  test('the limits match the server at their edges', async () => {
    const { room, requests } = host();
    await room.setAccess({ maxPlayers: 64 });
    await expect(room.setAccess({ maxPlayers: 0 })).rejects.toMatchObject({ code: 'bad_request' });
    const pad = JSON.stringify({ p: '' }).length;
    await room.setListing({ meta: { p: 'x'.repeat(512 - pad) } }); // exactly 512 bytes
    await expect(room.setListing({ meta: { p: 'x'.repeat(513 - pad) } })).rejects.toMatchObject({ code: 'too_large' });
    await room.setListing({ name: '🏎️'.repeat(48) }); // characters, not bytes
    await room.kick('pb', { message: 'x'.repeat(120) });
    expect(requests.map((r) => r.t)).toEqual(['set_access', 'set_listing', 'set_listing', 'kick']);
  });

  test('a blank name clears it, and omitted options are sent as undefined', async () => {
    const { room, requests } = host();
    await room.setListing({ name: ' \n\t ' });
    await room.setListing({ meta: { lap: 1 } });
    await room.setAccess({});
    expect(requests).toEqual([
      { t: 'set_listing', name: null, meta: undefined },
      { t: 'set_listing', name: undefined, meta: { lap: 1 } },
      { t: 'set_access', locked: undefined, public: undefined, maxPlayers: undefined },
    ]);
  });

  test('once the host role moves away, the controls refuse locally', async () => {
    const { room, requests } = host();
    control(room).handle({ v: 1, t: 'host_changed', hostId: 'pb', previousHostId: 'pa' });
    await expect(room.setAccess({ locked: true })).rejects.toMatchObject({ code: 'not_host' });
    await expect(room.kick('pb')).rejects.toMatchObject({ code: 'not_host' });
    expect(requests).toEqual([]);
  });

  test('starts from the room info, with defaults for an older server', () => {
    const now = makeRoom('pa', { locked: true, public: true, name: 'Night race', meta: { lap: 2 } }).room;
    expect([now.locked, now.isPublic, now.name, now.meta]).toEqual([true, true, 'Night race', { lap: 2 }]);
    const old = makeRoom('pa', {}).room;
    expect([old.locked, old.isPublic, old.name, old.meta]).toEqual([false, false, null, null]);
  });

  test('access and listing messages update the room and fire their events', () => {
    const { room } = makeRoom('pb', { hostId: 'pa', players });
    const seen: unknown[] = [];
    room.on('access', (access, from) => seen.push(['access', access, from]));
    room.on('listing', (listing, from) => seen.push(['listing', listing, from]));
    control(room).handle({ v: 1, t: 'access', locked: true, public: true, maxPlayers: 6, from: 'pa' });
    control(room).handle({ v: 1, t: 'listing', name: 'Dunes', meta: { phase: 'racing' }, from: 'pa' });
    expect([room.locked, room.isPublic, room.maxPlayers, room.name, room.meta]).toEqual([true, true, 6, 'Dunes', { phase: 'racing' }]);
    expect(seen).toEqual([
      // An older server's access doesn't say linkOnly: it has none.
      ['access', { locked: true, public: true, linkOnly: false, maxPlayers: 6 }, 'pa'],
      ['listing', { name: 'Dunes', meta: { phase: 'racing' } }, 'pa'],
    ]);
    control(room).handle({ v: 1, t: 'access', locked: false, public: false, linkOnly: true, maxPlayers: 6, from: 'pa' });
    expect(room.linkOnly).toBe(true);
    expect(seen.at(-1)).toEqual(['access', { locked: false, public: false, linkOnly: true, maxPlayers: 6 }, 'pa']);
  });

  test('a resync fires access and listing only for what changed while away', () => {
    const { room } = makeRoom('pb', { hostId: 'pa', players });
    const seen: string[] = [];
    room.on('access', () => seen.push('access'));
    room.on('listing', () => seen.push('listing'));
    const info: RoomInfo = { id: 'r', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId: 'pa', players, state: {}, stateSeq: 0, chat: [], seed: 1, claims: {} };
    control(room).sync(info);
    expect(seen).toEqual([]);
    control(room).sync({ ...info, locked: true });
    expect(seen).toEqual(['access']);
    control(room).sync({ ...info, locked: true, meta: { lap: 3 } });
    expect(seen).toEqual(['access', 'listing']);
    expect([room.locked, room.meta]).toEqual([true, { lap: 3 }]);
  });
});

describe('a closed room (SDK review, 2026-10-09)', () => {
  const two = (me: string) => makeRoom(me, { hostId: 'pa', players: [player('pa', 0), player('pb', 1)] });

  test('sends nothing: each of the game’s void calls is dropped with a warning, not thrown', async () => {
    const { room, queued, requests, warned } = two('pa');
    await room.leave();
    const left = queued.length;
    const asked = requests.length;
    room.send({ hi: 1 });
    room.emit('fire', null, { echo: false });
    room.setState({ round: 2 });
    room.assignTeams(2);
    room.chat('still here?');
    room.reseed();
    expect(queued.length).toBe(left);
    expect(requests.length).toBe(asked);
    expect(warned.filter((k) => k === 'left_room').length).toBe(6);
  });

  test('setState is dropped before the local write: the closed room’s state stays what everyone had', async () => {
    const { room } = two('pa');
    room.setState({ round: 1 });
    await room.leave();
    room.setState({ round: 2 });
    room.assignTeams(2);
    expect(room.state).toEqual({ round: 1 });
  });

  test('host-only calls are dropped for a non-host too, not refused with not_host', () => {
    const { room, queued, warned } = two('pb');
    control(room).close('kicked');
    expect(() => room.setState({ round: 2 })).not.toThrow();
    expect(() => room.reseed()).not.toThrow();
    expect(() => room.assignTeams(2)).not.toThrow();
    expect(queued.length).toBe(0);
    expect(warned.filter((k) => k === 'left_room').length).toBe(3);
  });

  test('emit on a closed room doesn’t run its own handler either', async () => {
    const { room } = two('pa');
    let echoed = 0;
    room.on('fire', () => echoed++);
    await room.leave();
    room.emit('fire');
    expect(echoed).toBe(0);
  });

  test('promise calls reject with disconnected (as one waiting at the close does); claim resolves false with a warning', async () => {
    const { room, requests, warned } = two('pa');
    await room.leave();
    const asked = requests.length;
    for (const call of [() => room.request('buy'), () => room.kick('pb'), () => room.shareLink()]) {
      const err = await call().then(
        () => null,
        (e: GameRelayError) => e,
      );
      expect(err?.code).toBe('disconnected');
      expect(err?.message).toContain('room ABCD is closed (you left it)');
    }
    expect(await room.claim('flag')).toBe(false);
    expect(warned).toContain('left_room');
    expect(requests.length).toBe(asked);
  });

  test('the warning names why it closed', () => {
    const cases: [(r: Room) => void, string][] = [
      [(r) => control(r).close('kicked'), '(you were removed from it)'],
      [(r) => control(r).close('closed'), '(it was closed)'],
      [(r) => control(r).close('lost'), '(the connection to it was lost)'],
      [(r) => control(r).dispose(), '(entering it again gave you a new room object)'],
    ];
    for (const [close, why] of cases) {
      const { room, messages } = two('pa');
      close(room);
      room.send(1);
      expect(messages.at(-1)).toContain(why);
    }
  });

  test('the SDK’s own sends after a close are dropped quietly: the warning is only for the game’s calls', () => {
    const { room, queued, warned, clock, step } = two('pa');
    // A timer handler that leaves: its batched setState is queued by the SDK after the close.
    room.on('timer', 'end', () => {
      room.setState({ over: true });
      control(room).close('left');
    });
    room.timer('end', 10);
    clock.now += 20;
    const before = queued.length;
    step();
    expect(queued.slice(before).filter((m) => m.t === 'set_state')).toEqual([]);
    expect(warned).not.toContain('left_room');
  });

  test('a close asked for with later fires closed a microtask later, already closed before then', async () => {
    const { room, queued } = two('pa');
    const fired: string[] = [];
    room.on('closed', (reason) => fired.push(reason));
    control(room).close('left', undefined, true);
    expect(fired).toEqual([]);
    room.send(1);
    expect(queued.length).toBe(0);
    await Promise.resolve();
    expect(fired).toEqual(['left']);
  });
});

describe('a closed room, the rest of its calls (SDK review, 2026-10-09)', () => {
  const two = (me: string) => makeRoom(me, { hostId: 'pa', players: [player('pa', 0), player('pb', 1)] });

  test('timer and clearTimer are dropped before they write the deadline into room.state', async () => {
    const { room, queued, warned } = two('pa');
    room.timer('round', 5000);
    const state = room.state;
    await room.leave();
    const left = queued.length;
    room.timer('next', 5000);
    room.clearTimer('round');
    expect(room.state).toEqual(state);
    expect(room.timeLeft('next')).toBeNull();
    expect(queued.length).toBe(left);
    expect(warned.filter((k) => k === 'left_room').length).toBe(2);
  });

  test('input and release are dropped with the warning; spawn throws, as a kind’s spawn does', async () => {
    const { room, queued, warned } = two('pa');
    room.define('dot', { x: 'number' });
    await room.leave();
    const left = queued.length;
    room.input({ left: true });
    room.release('flag');
    expect(queued.length).toBe(left);
    expect(warned.filter((k) => k === 'left_room').length).toBe(2);
    expect(() => room.spawn('dot', { x: 1 })).toThrow('room ABCD is closed');
  });

  test('host controls reject as closed (disconnected) before the host check, for whoever calls them', async () => {
    for (const me of ['pa', 'pb']) {
      const { room } = two(me);
      control(room).close('kicked');
      const calls = [() => room.kick(me === 'pa' ? 'pb' : 'pa'), () => room.setAccess({ locked: true }), () => room.setListing({ name: 'x' }), () => room.transferHost(me === 'pa' ? 'pb' : 'pa')];
      for (const call of calls) {
        const err = await call().then(
          () => null,
          (e: GameRelayError) => e,
        );
        expect(err?.code).toBe('disconnected');
      }
    }
  });
});

test('a link-only access change asks for the share link a microtask later, not while its batch is handled', async () => {
  const { room, requests } = makeRoom('pa', { hostId: 'pa', players: [player('pa', 0)] });
  control(room).handle({ v: 1, t: 'access', from: 'pa', locked: false, public: false, linkOnly: true, maxPlayers: 8 } as never);
  expect(requests.filter((r) => r.t === 'share_link')).toEqual([]);
  await Promise.resolve();
  expect(requests.filter((r) => r.t === 'share_link').length).toBe(1);
});
