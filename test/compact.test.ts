import { afterEach, expect, test } from 'bun:test';
import { advance, connectFake, roomInfo, settle } from './fakeRelay';

let done: (() => void) | null = null;
afterEach(() => {
  done?.();
  done = null;
});

const joined = (id: string, slot: number) => ({ t: 'player_joined', player: { id, name: id, avatar: null, joinedAt: 0, connected: true, slot } });

test('a player who joins in the same batch as our join’s reply is in the room, and their compact messages are theirs', async () => {
  const fake = await connectFake('pa');
  done = fake.done;
  const { relay } = fake;
  const socket = fake.socket();
  expect(socket.url).toMatch(/[?&]caps=(?:[a-z]+,)*compact\b/);
  const joining = relay.createRoom();
  await settle();
  const rid = socket.sentOf('create_room').at(-1)!.rid;
  // The server's outbox put all of this in one frame: the join is handled before the Room exists.
  socket.deliver({ t: 'batch', m: [{ t: 'room', room: roomInfo('pa'), you: 'pa' }, { t: 'reply', rid, data: { roomId: 'r1' } }, joined('pb', 1)] });
  const room = await joining;
  expect(room.players.map((p) => p.id)).toEqual(['pa', 'pb']);
  const got: [unknown, string][] = [];
  room.on('message', (d, from) => got.push([d, from]));
  socket.deliver({ t: 'm', s: 1, d: 'hi', at: Date.now() });
  socket.deliver({ t: 'player_left', playerId: 'pb', reason: 'left' });
  socket.deliver(joined('pc', 1)); // slot 1 again, a new holder
  socket.deliver({ t: 'm', s: 1, d: 'yo', at: Date.now() });
  socket.deliver({ t: 'm', s: 5, d: 'nobody', at: Date.now() }); // no holder: dropped
  expect(got).toEqual([
    ['hi', 'pb'],
    ['yo', 'pc'],
  ]);
});

test('what follows our join’s reply in the same batch reaches the new Room, not the old one or none', async () => {
  const fake = await connectFake('pa');
  done = fake.done;
  const { relay } = fake;
  const socket = fake.socket();
  const enter = async (code: string, id: string, state: Record<string, number>) => {
    const joining = relay.joinRoom(code);
    await settle();
    const rid = socket.sentOf('join_room').at(-1)!.rid;
    const info = { ...roomInfo('pa'), id, code, hostId: 'pb', players: [...roomInfo('pa').players, { id: 'pb', name: 'pb', avatar: null, joinedAt: 0, connected: true, slot: 1 }] };
    socket.deliver({ t: 'batch', m: [{ t: 'room', room: info, you: 'pa' }, { t: 'reply', rid, data: { roomId: id } }, { t: 'state', from: 'pb', patch: state, seq: 1 }] });
    return joining;
  };
  const first = await enter('AAAA', 'r1', { round: 1 });
  expect(first.state).toEqual({ round: 1 });
  const firstState: unknown[] = [];
  first.on('state', (s) => firstState.push(s));
  const second = await enter('BBBB', 'r2', { round: 7 });
  expect(second.state).toEqual({ round: 7 });
  expect(first.state).toEqual({ round: 1 });
  expect(firstState).toEqual([]);
});

test('switching rooms: the old room’s closed fires after the batch, so a handler that enters another room sees it whole', async () => {
  const fake = await connectFake('pa');
  done = fake.done;
  const { relay } = fake;
  const socket = fake.socket();
  /** Ask to join, then return a function that delivers the server's batch synchronously. */
  const ask = async (code: string, id: string, extra: Record<string, unknown>[] = []) => {
    const joining = relay.joinRoom(code);
    await settle();
    const rid = socket.sentOf('join_room').at(-1)!.rid;
    return { joining, answer: () => socket.deliver({ t: 'batch', m: [{ t: 'room', room: { ...roomInfo('pa'), id, code }, you: 'pa' }, { t: 'reply', rid, data: { roomId: id } }, ...extra] }) };
  };
  const one = await ask('AAAA', 'r1');
  one.answer();
  const first = await one.joining;
  let stateAtClose: unknown = 'not fired';
  first.on('closed', () => (stateAtClose = relay.room?.state));
  const two = await ask('BBBB', 'r2', [{ t: 'state', from: 'pa', patch: { round: 7 }, seq: 1 }]);
  two.answer();
  // The batch is handled and the old room is closed, but its handler hasn't run yet.
  expect(stateAtClose).toBe('not fired');
  const second = await two.joining;
  // It ran after the whole batch: the new room already had the batch's state.
  expect(stateAtClose).toEqual({ round: 7 });
  expect(relay.room).toBe(second);
});

test('a link-only room asks for its share link after the join’s batch, not in the middle of it', async () => {
  const fake = await connectFake('pa');
  done = fake.done;
  const { relay } = fake;
  const socket = fake.socket();
  const joining = relay.joinRoom('AAAA');
  await settle();
  const rid = socket.sentOf('join_room').at(-1)!.rid;
  socket.deliver({ t: 'batch', m: [{ t: 'room', room: { ...roomInfo('pa'), linkOnly: true }, you: 'pa' }, { t: 'reply', rid, data: { roomId: 'r1' } }, joined('pb', 1)] });
  expect(socket.sentOf('share_link')).toEqual([]);
  const room = await joining;
  await settle();
  expect(socket.sentOf('share_link').length).toBe(1);
  expect(room.players.map((p) => p.id)).toEqual(['pa', 'pb']);
});

test('moved by the party leader: the old room’s closed fires after the batch, with relay.room the party’s room', async () => {
  const fake = await connectFake('pa');
  done = fake.done;
  const { relay } = fake;
  const socket = fake.socket();
  const joining = relay.joinRoom('AAAA');
  await settle();
  const rid = socket.sentOf('join_room').at(-1)!.rid;
  socket.deliver({ t: 'batch', m: [{ t: 'room', room: roomInfo('pa'), you: 'pa' }, { t: 'reply', rid, data: { roomId: 'r1' } }] });
  const first = await joining;
  let atClose: unknown = 'not fired';
  first.on('closed', () => (atClose = relay.room?.state));
  socket.deliver({ t: 'batch', m: [{ t: 'room', room: { ...roomInfo('pa'), id: 'r2', code: 'BBBB' }, you: 'pa' }, { t: 'party_room', roomId: 'r2' }, { t: 'state', from: 'pa', patch: { round: 3 }, seq: 1 }] });
  expect(atClose).toBe('not fired');
  await settle();
  expect(atClose).toEqual({ round: 3 });
  expect(relay.room?.id).toBe('r2');
});

/** Connected and in room r1 (AAAA), as its host; `ask` sends a join and returns how to answer it. */
async function inFirstRoom() {
  const fake = await connectFake('pa');
  done = fake.done;
  const { relay } = fake;
  const socket = fake.socket();
  const ask = async (code: string) => {
    const joining = relay.joinRoom(code);
    joining.catch(() => {}); // a test that fails the join awaits it itself
    await settle();
    const rid = socket.sentOf('join_room').at(-1)!.rid as number;
    return {
      joining,
      rid,
      answer: (id: string, extra: Record<string, unknown> = {}) =>
        socket.deliver({ t: 'batch', m: [{ t: 'room', room: { ...roomInfo('pa'), id, code, ...extra }, you: 'pa' }, { t: 'reply', rid, data: { roomId: id } }] }),
    };
  };
  const first = await ask('AAAA');
  first.answer('r1');
  const room = await first.joining;
  /** What reached the server after the last join_room, as the `send`s' data and the other types. */
  const afterJoin = () => {
    const all = socket.messages;
    const at = all.findLastIndex((m) => m.t === 'join_room');
    return all
      .slice(at + 1)
      .filter((m) => m.t !== 'ping') // the relay's own, not the room's
      .map((m) => (m.t === 'send' ? m.d : m.t));
  };
  return { relay, socket, room, ask, afterJoin };
}

test('what the old room sends while a join waits for its answer never reaches the new room', async () => {
  const { relay, room, ask, afterJoin } = await inFirstRoom();
  room.send('before');
  const next = await ask('BBBB');
  // The send queued before the join went out ahead of it, to the room it was for.
  expect(afterJoin()).not.toContain('before');
  room.send('during');
  room.setState({ round: 2 });
  await advance(200);
  expect(afterJoin()).toEqual([]);
  next.answer('r2');
  const second = await next.joining;
  await advance(200);
  expect(afterJoin()).not.toContain('during');
  expect(afterJoin()).not.toContain('set_state');
  expect(relay.room).toBe(second);
  second.send('new');
  await advance(200);
  expect(afterJoin()).toContain('new');
});

test('a join that fails sends what waited, to the room we are still in', async () => {
  const { relay, socket, room, ask, afterJoin } = await inFirstRoom();
  const next = await ask('BBBB');
  room.send('during');
  await advance(200);
  expect(afterJoin()).toEqual([]);
  socket.deliver({ t: 'error', code: 'room_full', message: 'Room is full', rid: next.rid });
  await expect(next.joining).rejects.toThrow('Room is full');
  await advance(200);
  expect(afterJoin()).toContain('during');
  expect(relay.room).toBe(room);
  room.send('after');
  await advance(200);
  expect(afterJoin()).toContain('after');
});


test('batches are put together from each message’s text: every item keeps v, order holds, and multi-byte text splits frames under the limit (SDK review #24)', async () => {
  const { room, socket } = await inFirstRoom();
  const before = socket.frames.length;
  const big = '€'.repeat(2000); // 6000 UTF-8 bytes in 2000 characters
  for (let i = 0; i < 8; i++) room.send({ i, big });
  room.send({ i: 8, small: 'ok' });
  await advance(200);
  const frames = socket.frames.slice(before).filter((f) => f.t !== 'ping');
  const items = frames.flatMap((f) => (f.t === 'batch' ? (f.m as Record<string, unknown>[]) : [f]));
  expect(items.every((m) => m.v === 1)).toBe(true);
  const sends = items.filter((m) => m.t === 'send'); // (the room's own heartbeats ride along)
  expect(sends.map((m) => (m.d as { i: number }).i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const f of frames) expect(new TextEncoder().encode(JSON.stringify(f)).byteLength).toBeLessThanOrEqual(16_000);
  expect(frames.length).toBeGreaterThanOrEqual(4); // two 6 KB items per 15 KB frame at most
});
