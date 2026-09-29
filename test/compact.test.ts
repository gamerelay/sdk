import { afterEach, expect, test } from 'bun:test';
import { connectFake, roomInfo, settle } from './fakeRelay';

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
  expect(socket.url).toContain('compact=1');
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
