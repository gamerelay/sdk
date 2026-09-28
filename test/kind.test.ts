import { describe, expect, test } from 'bun:test';
import type { JsonObject, PlayerInfo, RoomInfo } from '@gamerelay/protocol/types';
import { Room, type GameRelay } from '../src/index';

const player = (id: string, slot: number): PlayerInfo => ({ id, name: id, avatar: null, joinedAt: slot, connected: true, slot });

function makeRoom() {
  const queued: { t: string; patch?: JsonObject; d?: unknown }[] = [];
  const warns: string[] = [];
  let seq = 0;
  const relay = {
    connected: true,
    room: null,
    queue: (m: { t: string }) => queued.push(m),
    now: () => 1000,
    writeTime: () => 1000,
    tick: () => () => {},
    warn: (_kind: string, key: string) => warns.push(key),
    newEntityId: (kind: string) => `${kind}:t:${++seq}`,
    request: async () => undefined,
  } as unknown as GameRelay;
  const info: RoomInfo = { id: 'r', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId: 'pa', players: [player('pa', 0)], state: {}, stateSeq: 0, chat: [], seed: 1, claims: {} };
  return { room: new Room(relay, info, 'pa'), queued, warns };
}

describe('kind handles (room.define returns one)', () => {
  test('spawn, all and get work through the handle', () => {
    const { room } = makeRoom();
    const ships = room.define('ship', { x: 'number', alive: 'flag' });
    expect(ships.name).toBe('ship');
    const me = ships.spawn({ x: 1, alive: true });
    expect(ships.all()).toEqual([me]);
    expect(ships.get(me.id)).toBe(me);
    expect(room.all('ship')).toEqual([me]); // the string form still works
  });

  test('mine() is the ones you write now: yours, and host entities while you are host', () => {
    const { room } = makeRoom(); // pa is the host
    const ships = room.define('ship', { x: 'number' });
    const drones = room.define('drone', { x: 'number' });
    const me = ships.spawn({ x: 1 });
    const gone = ships.spawn({ x: 2 });
    gone.remove();
    const d = drones.spawn({ x: 3 }, { owner: 'host' });
    expect(ships.mine()).toEqual([me]);
    expect(drones.mine()).toEqual([d]);
    for (const s of ships.mine()) s.x += 1; // the loop the guide shows: never throws
    expect(me.x).toBe(2);
  });

  test('get only finds entities of its own kind', () => {
    const { room } = makeRoom();
    const ships = room.define('ship', { x: 'number' });
    const coins = room.define('coin', { x: 'number' });
    const c = coins.spawn({ x: 1 });
    expect(ships.get(c.id)).toBeUndefined();
    expect(coins.get(c.id)).toBe(c);
  });

  test('on("spawn" | "remove") subscribe to that kind and return an unsubscribe', () => {
    const { room } = makeRoom();
    const ships = room.define('ship', { x: 'number' });
    const coins = room.define('coin', { x: 'number' });
    const seen: string[] = [];
    const off = ships.on('spawn', (s) => seen.push(`spawn ${s.kind}`));
    ships.on('remove', (s, reason) => seen.push(`remove ${s.kind} ${reason}`));
    const s = ships.spawn({ x: 0 });
    coins.spawn({ x: 0 });
    s.remove();
    off();
    ships.spawn({ x: 1 });
    expect(seen).toEqual(['spawn ship', 'remove ship removed']);
    expect(() => ships.on('nope' as 'spawn', () => {})).toThrow(/'spawn' or 'remove'/);
  });

  test('defining again with the same fields gives a working handle; different fields throw', () => {
    const { room } = makeRoom();
    const a = room.define('ship', { x: 'number' });
    const b = room.define('ship', { x: 'number' });
    const s = a.spawn({ x: 1 });
    expect(b.get(s.id)).toBe(s);
    expect(() => room.define('ship', { x: 'number', y: 'number' })).toThrow(/different fields/);
  });

  test('a handle from a room you left throws, saying to define again', () => {
    const { room } = makeRoom();
    const ships = room.define('ship', { x: 'number' });
    room.dispose();
    expect(() => ships.all()).toThrow(/belongs to a room you left; call room\.define\('ship', …\) again/);
    expect(() => ships.spawn({ x: 0 })).toThrow(/belongs to a room you left/);
  });

  test('field types check out in TypeScript (test/types/kind.types.ts)', () => {
    const proc = Bun.spawnSync(['bunx', 'tsc', '-p', new URL('./types/tsconfig.json', import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toBe('');
    expect(proc.exitCode).toBe(0);
  }, 30_000);
});

describe('friction fixes', () => {
  test('room.all() of a kind nobody defined warns once, suggesting the closest', () => {
    const { room, warns } = makeRoom();
    room.define('ship', { x: 'number' });
    expect(room.all('shp')).toEqual([]);
    room.all('shp');
    expect(warns).toEqual(['kind:shp']);
  });

  test('a text value over 256 characters says so', () => {
    const { room } = makeRoom();
    const tags = room.define('tag', { label: 'text' });
    expect(() => tags.spawn({ label: 'x'.repeat(300) })).toThrow(/tag\.label is a 'text' field of at most 256 characters; got 300/);
  });
});
