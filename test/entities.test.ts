import { describe, expect, test } from 'bun:test';
import { FULL, REMOVE, SPAWN, TELEPORT } from '../src/core/codec';
import { createIdAllocator } from '../src/core/ids';
import { EntityStore, MAX_OWN, MAX_ROOM, type Entity } from '../src/sync/entities';
import { FakeNet, type NetOptions } from './fakeNet';

const SHIP = { x: 'number', y: 'number', alive: 'flag' } as const;
const FRAME = 1000 / 60;

function setup(opts: NetOptions = {}) {
  const net = new FakeNet(opts);
  const warns: string[] = [];
  const aWarns: string[] = [];
  const events: string[] = [];
  let a!: EntityStore;
  let b!: EntityStore;
  const ta = net.join('pa', 'ada', (d, f, at) => a.receive(d, f, at));
  const tb = net.join('pb', 'bo', (d, f, at) => b.receive(d, f, at));
  a = new EntityStore(ta, { warn: (_kind, key, message) => aWarns.push(`${key} | ${message}`) }, createIdAllocator(() => 0.1));
  b = new EntityStore(
    tb,
    {
      warn: (_kind, key) => warns.push(key),
      onSpawn: (e) => events.push(`spawn ${e.id}`),
      onRemove: (e, reason) => events.push(`remove ${e.id} ${reason}`),
    },
    createIdAllocator(() => 0.2),
  );
  /** Run both stores for `ms` at 60 frames per second. */
  const run = (ms: number) => {
    const end = net.now + ms;
    while (net.now + FRAME <= end) {
      net.advanceTo(net.now + FRAME);
      a.tick();
      b.tick();
    }
    net.advanceTo(end);
  };
  return { net, a, b, warns, aWarns, events, run };
}

describe('EntityStore: local entities', () => {
  test('spawn needs define, a value for every field, and the right types', () => {
    const { a } = setup();
    expect(() => a.spawn('ship', { x: 0, y: 0, alive: true })).toThrow(/call room.define\('ship'/);
    a.define('ship', SHIP);
    expect(() => a.spawn('ship', { x: 0, y: 0 })).toThrow(/starting value for 'alive'/);
    expect(() => a.spawn('ship', { x: 0, y: 0, alive: true, vx: 1 })).toThrow(/ship has no field 'vx'/);
    expect(() => a.spawn('ship', { x: '0', y: 0, alive: true })).toThrow(/'number' field/);
  });

  test('define twice: same fields is fine, different fields throws', () => {
    const { a } = setup();
    a.define('ship', SHIP);
    expect(() => a.define('ship', SHIP)).not.toThrow();
    expect(() => a.define('ship', { x: 'number' })).toThrow(/already called with different fields/);
  });

  test('your entity is live and writable; bad writes are skipped with one warning each, never thrown', () => {
    const { a, aWarns } = setup();
    a.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 1, y: 2, alive: true });
    expect(mine.mine).toBe(true);
    expect(mine.owner.name).toBe('ada');
    mine.x = 5;
    expect(mine.x).toBe(5);
    expect(a.all('ship')).toEqual([mine]);
    for (let frame = 0; frame < 3; frame++) {
      mine.vx = 1; // undeclared
      (mine as { id: string }).id = 'x'; // read-only
      mine.x = 'far'; // wrong type
    }
    expect(mine.x).toBe(5);
    expect(mine.id).not.toBe('x');
    // The hook sees every skipped write; the relay's Warnings prints each key once, then counts.
    expect([...new Set(aWarns.map((w) => w.split(' | ')[0]))]).toEqual(['write:ship:vx', 'write:ship:id', 'write:ship:x']);
    expect(aWarns[0]).toMatch(/ship has no field 'vx'; add it to room.define\('ship'.*skipped/);
    expect(aWarns[1]).toMatch(/read-only/);
    expect(aWarns[2]).toMatch(/'number' field/);
    expect({ ...mine }).toEqual({ id: mine.id, kind: 'ship', owner: mine.owner, mine: true, x: 5, y: 2, alive: true });
  });

  test('sends a full spawn first, then only changed fields, unreliable unless discrete', () => {
    const { a, net, run } = setup();
    a.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    run(20);
    const [spawn] = net.updates('pa');
    expect(spawn!.reliable).toBe(true);
    expect(spawn!.e[0]![1]).toBe(SPAWN | FULL);
    expect(spawn!.e[0]![2]).toEqual([0, 0, 1, 0, 2, true]);
    expect(typeof spawn!.e[0]![3]).toBe('string');
    net.sent.length = 0;
    mine.x = 5;
    run(60);
    const [move] = net.updates('pa');
    expect(move!.e[0]!.slice(1, 3)).toEqual([0, [0, 5]]);
    expect(move!.reliable).toBe(false);
    net.sent.length = 0;
    mine.alive = false;
    run(60);
    expect(net.updates('pa')[0]!.reliable).toBe(true);
  });

  test('sends at the kind rate (20/s) even when written every frame', () => {
    const { a, net, run } = setup();
    a.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    for (let i = 0; i < 60; i++) {
      mine.x = i;
      run(FRAME);
    }
    expect(net.updates('pa').length).toBeGreaterThanOrEqual(19);
    expect(net.updates('pa').length).toBeLessThanOrEqual(21);
  });

  test('a full update goes out every second even when nothing changes', () => {
    const { a, net, run } = setup();
    a.define('ship', SHIP);
    a.spawn('ship', { x: 0, y: 0, alive: true });
    run(2100);
    const full = net.updates('pa').filter((m) => (m.e[0]![1] & FULL) !== 0);
    expect(full.length).toBe(3); // spawn, +1 s, +2 s
  });

  test('teleport() marks the next update', () => {
    const { a, net, run } = setup();
    a.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    run(60);
    net.sent.length = 0;
    mine.teleport();
    mine.x = 900;
    run(60);
    expect(net.updates('pa')[0]!.e[0]![1] & TELEPORT).toBe(TELEPORT);
  });

  test('remove(): gone locally at once, then a removal goes out, and later writes are skipped', () => {
    const { net } = setup();
    const removed: string[] = [];
    const store = new EntityStore(
      net.join('pc', 'cy', () => {}),
      { onRemove: (e, r) => removed.push(`${e.kind} ${r}`), warn: (_k, key) => removed.push(`warn ${key}`) },
    );
    store.define('ship', SHIP);
    const mine = store.spawn('ship', { x: 0, y: 0, alive: true });
    store.tick();
    mine.remove();
    expect(store.all('ship')).toEqual([]);
    expect(store.get(mine.id)).toBeUndefined();
    expect(removed).toEqual(['ship removed']);
    mine.x = 1;
    mine.x = 2;
    expect(removed).toEqual(['ship removed', 'warn write:ship:removed', 'warn write:ship:removed']);
    store.tick();
    const last = net.updates('pc').at(-1)!;
    expect(last.e[0]).toEqual([mine.id, REMOVE, []]);
    expect(last.reliable).toBe(true);
  });

  test('at most MAX_OWN entities per player', () => {
    const { a } = setup();
    a.define('dot', { x: 'number' });
    for (let i = 0; i < MAX_OWN; i++) a.spawn('dot', { x: i });
    expect(() => a.spawn('dot', { x: 0 })).toThrow(/at most 256/);
  });

  test('big bursts split into messages under the limit', () => {
    const { a, net, run } = setup();
    a.define('dot', { label: 'text' });
    for (let i = 0; i < 200; i++) a.spawn('dot', { label: 'x'.repeat(200) });
    run(20);
    const msgs = net.updates('pa');
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of net.sent) expect(JSON.stringify(m.data).length).toBeLessThan(16 * 1024);
    expect(msgs.reduce((n, m) => n + m.e.length, 0)).toBe(200);
  });
});

describe('EntityStore: others’ entities', () => {
  test('appear after the smoothing delay, with their owner, and read-only (writes skipped with a warning)', () => {
    const { a, b, events, warns, run } = setup();
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    run(10);
    expect(b.all('ship')).toEqual([]);
    run(200);
    const seen = b.all('ship');
    expect(seen.length).toBe(1);
    expect(seen[0]!.id).toBe(mine.id);
    expect(seen[0]!.owner.name).toBe('ada');
    expect(seen[0]!.mine).toBe(false);
    expect(events).toEqual([`spawn ${mine.id}`]);
    const before = seen[0]!.x;
    let reached = false;
    for (const s of b.all('ship')) s.x = 1; // the eval's mistake: a loop over all()
    reached = true; // …and the code after it still runs
    seen[0]!.teleport();
    seen[0]!.remove();
    expect(reached).toBe(true);
    expect(seen[0]!.x).toBe(before);
    expect(b.all('ship')).toHaveLength(1);
    expect(warns.filter((w) => w.startsWith('write:'))).toEqual(['write:ship:owner', 'write:ship:owner', 'write:ship:owner']);
  });

  test('motion is interpolated between updates', () => {
    const { a, b, run } = setup();
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    const xs: number[] = [];
    for (let i = 0; i < 120; i++) {
      mine.x = i * 5; // 300 units per second
      run(FRAME);
      const e = b.get(mine.id);
      if (e) xs.push(e.x as number);
    }
    const steps = xs.slice(1).map((x, i) => x - xs[i]!);
    const moving = steps.filter((d) => d > 0);
    expect(moving.length).toBeGreaterThan(40); // moves most frames, not only when updates land
    expect(Math.max(...moving)).toBeLessThan(15); // no lurches (a 50 ms update is 15 units)
  });

  test('a discrete change shows at its moment on the timeline, not on arrival', () => {
    const { a, b, run } = setup({ latency: 40 });
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    run(600);
    mine.alive = false;
    run(40);
    expect(b.get(mine.id)!.alive).toBe(true);
    run(400);
    expect(b.get(mine.id)!.alive).toBe(false);
  });

  test('a teleport snaps instead of sliding', () => {
    const { a, b, run } = setup();
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    run(500);
    mine.teleport();
    mine.x = 900;
    const xs: number[] = [];
    for (let i = 0; i < 40; i++) {
      run(FRAME);
      xs.push(b.get(mine.id)!.x as number);
    }
    expect(xs.every((x) => x === 0 || x === 900)).toBe(true);
    expect(xs.at(-1)).toBe(900);
  });

  test('removal reaches others in order, as reason "removed", after the last change', () => {
    const { a, b, events, run } = setup();
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    run(300);
    const seen = b.get(mine.id)!;
    mine.alive = false;
    mine.remove(); // same frame: the change must still go out first
    run(300);
    expect(b.all('ship')).toEqual([]);
    expect(events.at(-1)).toBe(`remove ${mine.id} removed`);
    expect(seen.alive).toBe(false);
  });

  test('when the owner leaves, its entities go, as reason "left"', () => {
    const { a, b, events, run } = setup();
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    run(300);
    b.playerLeft('pa');
    run(300);
    expect(b.all('ship')).toEqual([]);
    expect(events.at(-1)).toBe(`remove ${mine.id} left`);
  });

  test('a joiner gets a full update of everything you own, sent only to them', () => {
    const { a, net, run } = setup();
    a.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 3, y: 4, alive: true });
    run(100);
    net.sent.length = 0;
    a.playerJoined('pb');
    const [msg] = net.updates('pa');
    expect(msg!.to).toBe('pb');
    expect(msg!.reliable).toBe(true);
    expect(msg!.e[0]!.slice(0, 3)).toEqual([mine.id, SPAWN | FULL, [0, 3, 1, 4, 2, true]]);
  });

  test('updates wait for define', () => {
    const { a, b, run } = setup();
    a.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 7, y: 0, alive: true });
    run(300);
    expect(b.all('ship')).toEqual([]);
    b.define('ship', SHIP);
    run(300);
    expect(b.get(mine.id)?.x).toBe(7);
  });

  test('only the owner writes: a spoofed update is ignored', () => {
    const { a, b, net, run } = setup();
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 1, y: 0, alive: true });
    run(300);
    b.receive({ $gr: 'u', t: net.now, e: [[mine.id, 0, [0, 777]]] }, 'pc', net.now);
    run(300);
    expect(b.get(mine.id)!.x).toBe(1);
  });

  test('wild stamps fall back to server time', () => {
    const { b, net, run } = setup();
    b.define('ship', SHIP);
    run(100);
    expect(() => b.receive({ $gr: 'u', t: net.now, e: [['ship:zzzzzzzz:1', SPAWN | FULL, [0, 1, 1, 2, 2, true]]] }, 'pa', net.now)).not.toThrow(); // no hash: ignored
    const c = new EntityStore(net.join('pd', 'di', () => {}));
    c.define('ship', SHIP);
    c.spawn('ship', { x: 1, y: 2, alive: true });
    c.tick();
    const real = net.updates('pd').at(-1)!;
    b.receive({ $gr: 'u', t: net.now + 60_000, e: real.e }, 'pd', net.now); // stamp 60 s in the future
    run(400);
    expect(b.all('ship').map((e) => e.owner.name)).toEqual(['di']);
  });

  test('only position fields (x, y, z) can count as a jump: a velocity spike eases', () => {
    const { a, b, warns, run } = setup();
    const KIND = { x: 'number', vx: 'number' } as const;
    a.define('ship', KIND);
    b.define('ship', KIND);
    const mine = a.spawn('ship', { x: 0, vx: 0 });
    run(3500); // at rest long enough for a few keyframes
    mine.vx = 400; // starts thrusting: velocity leaps, position doesn't
    const vxs: number[] = [];
    for (let i = 0; i < 30; i++) {
      run(FRAME);
      vxs.push(b.get(mine.id)!.vx as number);
    }
    expect(warns).not.toContain('jump:ship');
    expect(vxs.some((v) => v > 0 && v < 400)).toBe(true); // eased, not snapped
  });

  test('C2: a new page load from the same player replaces its old entities at once', () => {
    const { net, b, events, run } = setup();
    b.define('ship', SHIP);
    const old = new EntityStore(net.join('pa', 'ada', () => {}), {}, createIdAllocator(() => 0.5));
    old.define('ship', SHIP);
    const first = old.spawn('ship', { x: 1, y: 0, alive: true });
    for (let i = 0; i < 20; i++) {
      old.tick();
      run(FRAME);
    }
    expect(b.get(first.id)).toBeDefined();
    const reloaded = new EntityStore(net.join('pa', 'ada', () => {}), {}, createIdAllocator(() => 0.6));
    reloaded.define('ship', SHIP);
    const second = reloaded.spawn('ship', { x: 2, y: 0, alive: true });
    for (let i = 0; i < 30; i++) {
      reloaded.tick();
      run(FRAME);
    }
    expect(b.all('ship').map((e) => e.id)).toEqual([second.id]);
    expect(events).toContain(`remove ${first.id} expired`);
  });

  test('C2: an entity whose connected owner goes silent for 3 s expires', () => {
    const { net, b, events } = setup();
    b.define('ship', SHIP);
    const owner = new EntityStore(net.join('pa', 'ada', () => {}));
    owner.define('ship', SHIP);
    const mine = owner.spawn('ship', { x: 1, y: 0, alive: true });
    owner.tick();
    for (let t = 0; t < 2500; t += FRAME) {
      net.advanceTo(net.now + FRAME);
      b.tick();
    }
    expect(b.get(mine.id)).toBeDefined(); // owner silent but not yet 3 s
    for (let t = 0; t < 1500; t += FRAME) {
      net.advanceTo(net.now + FRAME);
      b.tick();
    }
    expect(b.get(mine.id)).toBeUndefined();
    expect(events).toContain(`remove ${mine.id} expired`);
  });

  test('I2: nobody can claim another player’s future entity ids', () => {
    const { a, b, net, run } = setup();
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    const first = a.spawn('ship', { x: 1, y: 0, alive: true });
    run(300);
    const session = first.id.split(':')[1];
    const [, , , hash] = net.updates('pa')[0]!.e[0]!;
    const next = `ship:${session}:2`;
    b.receive({ $gr: 'u', t: net.now, e: [[next, SPAWN | FULL, [0, 666, 1, 0, 2, true], hash!]] }, 'pc', net.now);
    const second = a.spawn('ship', { x: 5, y: 0, alive: true });
    expect(second.id).toBe(next);
    run(300);
    expect(b.get(next)!.owner.name).toBe('ada');
    expect(b.get(next)!.x).toBe(5);
  });

  test('I3: when the owner stops, others stop at the same place (no overshoot)', () => {
    const { a, b, run } = setup({ latency: 60 });
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    run(300);
    for (let i = 0; i <= 60; i++) {
      mine.x = Math.min(400, i * (400 / 60)); // 400 px/s for 1 s, then stop at 400
      run(FRAME);
    }
    let max = 0;
    for (let i = 0; i < 90; i++) {
      run(FRAME);
      max = Math.max(max, b.get(mine.id)!.x as number);
    }
    expect(max).toBeLessThanOrEqual(401);
    expect(b.get(mine.id)!.x).toBe(400);
  });

  test('I5: nothing is sent while disconnected, and a full update goes out on reconnect', () => {
    const net = new FakeNet();
    let up = false;
    const base = net.join('pa', 'ada', () => {});
    const store = new EntityStore({ ...base, ready: () => up });
    store.define('ship', SHIP);
    const mine = store.spawn('ship', { x: 0, y: 0, alive: true });
    for (let i = 0; i < 120; i++) {
      mine.x = i;
      net.advanceTo(net.now + FRAME);
      store.tick();
    }
    expect(net.updates('pa')).toEqual([]);
    up = true;
    net.advanceTo(net.now + FRAME);
    store.tick();
    const [first] = net.updates('pa');
    expect(first!.e[0]![1] & FULL).toBe(FULL);
  });

  test('I6: an entity kept from the spawn event keeps updating without calling all()', () => {
    const { net, a, run } = setup();
    let kept: Entity | undefined;
    const viewer = new EntityStore(net.join('pe', 'ed', (d, f, at) => viewer.receive(d, f, at)), { onSpawn: (e) => (kept = e) });
    a.define('ship', SHIP);
    viewer.define('ship', SHIP);
    const mine = a.spawn('ship', { x: 0, y: 0, alive: true });
    for (let i = 0; i < 30; i++) {
      run(FRAME);
      viewer.tick();
    }
    expect(kept).toBeDefined();
    mine.x = 77;
    for (let i = 0; i < 30; i++) {
      run(FRAME);
      viewer.tick();
    }
    expect(kept!.x).toBe(77);
  });

  test('your own outage (offline, or the whole page frozen) never expires everyone else’s entities', () => {
    for (const mode of ['offline', 'frozen'] as const) {
      const net = new FakeNet();
      let online = true;
      const events: string[] = [];
      let owner!: EntityStore;
      let viewer!: EntityStore;
      owner = new EntityStore(net.join('pa', 'ada', (d, f, at) => owner.receive(d, f, at)));
      const tv = net.join('pb', 'bo', (d, f, at) => {
        if (online) viewer.receive(d, f, at);
      });
      viewer = new EntityStore(
        { ...tv, ready: () => mode === 'frozen' || online },
        { onSpawn: () => events.push('spawn'), onRemove: (_e, r) => events.push(`remove ${r}`) },
      );
      owner.define('ship', SHIP);
      viewer.define('ship', SHIP);
      const mine = owner.spawn('ship', { x: 0, y: 0, alive: true });
      const step = (ms: number, viewerRuns: boolean) => {
        for (let t = 0; t < ms; t += FRAME) {
          net.advanceTo(net.now + FRAME);
          owner.tick();
          if (viewerRuns) viewer.tick();
        }
      };
      step(500, true);
      const held = viewer.get(mine.id);
      expect(held).toBeDefined();
      online = false;
      step(5000, mode === 'offline'); // frozen: the viewer's page runs nothing at all
      online = true;
      step(1500, true);
      expect(events).toEqual(['spawn']);
      expect(viewer.get(mine.id)).toBe(held);
    }
  });

  test('sends of one rate share a schedule: 10 entities spawned on different frames, ~20 messages a second', () => {
    const { a, net, run } = setup();
    a.define('dot', { x: 'number' });
    const dots = [];
    for (let i = 0; i < 10; i++) {
      dots.push(a.spawn('dot', { x: 0 }));
      run(FRAME);
    }
    run(500);
    net.sent.length = 0;
    for (let f = 0; f < 60; f++) {
      for (const d of dots) d.x = (d.x as number) + 1;
      run(FRAME);
    }
    expect(net.updates('pa').length).toBeLessThanOrEqual(22);
  });

  test('different builds warn instead of garbling', () => {
    const { a, b, warns, run } = setup();
    a.define('ship', SHIP);
    b.define('ship', { x: 'number', y: 'number' });
    a.spawn('ship', { x: 0, y: 0, alive: true });
    run(300);
    expect(b.all('ship')).toEqual([]);
    expect(warns).toContain('fields:ship');
  });

  test('the SDK channel is recognised and anything else is left alone', () => {
    const { b } = setup();
    expect(b.receive({ hello: 1 }, 'pa', 0)).toBe(false);
    expect(b.receive('text', 'pa', 0)).toBe(false);
    expect(b.receive({ $gr: 'u', e: 'junk' }, 'pa', 0)).toBe(true);
  });

  test('counts() by kind, yours and visible others', () => {
    const { a, b, run } = setup();
    a.define('ship', SHIP);
    b.define('ship', SHIP);
    a.spawn('ship', { x: 0, y: 0, alive: true });
    b.spawn('ship', { x: 0, y: 0, alive: true });
    run(300);
    expect(b.counts()).toEqual({ ship: 2 });
  });
});

describe('host-owned entities', () => {
  const DRONE = { x: 'number', y: 'number' } as const;
  function room3() {
    const net = new FakeNet();
    const events: string[] = [];
    const warned: string[] = [];
    const stores: Record<string, EntityStore> = {};
    for (const [id, name] of [['pa', 'ada'], ['pb', 'bo'], ['pc', 'cy']] as const) {
      stores[id] = new EntityStore(
        net.join(id, name, (d, f, at) => stores[id]!.receive(d, f, at)),
        { onSpawn: (e) => events.push(`${id} spawn ${e.kind}`), warn: (_k, _key, message) => warned.push(`${id}: ${message}`) },
        createIdAllocator(() => ({ pa: 0.1, pb: 0.2, pc: 0.3 })[id]),
      );
      stores[id]!.define('drone', DRONE);
    }
    net.host = 'pa';
    const run = (ms: number) => {
      const end = net.now + ms;
      while (net.now + FRAME <= end) {
        net.advanceTo(net.now + FRAME);
        for (const s of Object.values(stores)) s.tick();
      }
    };
    const handOver = (to: string) => {
      const prev = net.host;
      net.host = to;
      for (const s of Object.values(stores)) s.hostChanged(to, prev);
    };
    return { net, events, warned, a: stores.pa!, b: stores.pb!, c: stores.pc!, run, handOver };
  }

  test('only the host can create host entities', () => {
    const { b } = room3();
    expect(() => b.spawn('drone', { x: 0, y: 0 }, { owner: 'host' })).toThrow(/only the host can create host entities/);
  });

  test('hostedCounts counts host entities per kind, on the host and on others (eval scorer)', () => {
    const { a, b, run } = room3();
    a.spawn('drone', { x: 1, y: 2 }, { owner: 'host' });
    a.spawn('drone', { x: 3, y: 4 });
    run(300);
    expect(a.hostedCounts()).toEqual({ drone: 1 });
    expect(b.hostedCounts()).toEqual({ drone: 1 });
    expect(b.counts()).toEqual({ drone: 2 });
  });

  test('a host entity reaches others owned by the host, sent host-only', () => {
    const { a, b, net, run, warned } = room3();
    const d = a.spawn('drone', { x: 1, y: 2 }, { owner: 'host' });
    run(300);
    const seen = b.get(d.id)!;
    expect(seen.owner.name).toBe('ada');
    expect(seen.mine).toBe(false);
    expect(net.updates('pa').every((m) => m.host)).toBe(true);
    seen.x = 5;
    expect(seen.x).toBe(1);
    expect(warned).toEqual([
      `pb: ${d.id} belongs to the host; only the host can change it. Update in a loop over .mine() on the 'drone' handle (the ones you write), not .all(); or ask the host: room.emit('…', data, { to: 'host' }) (this write was skipped; the rest of your code keeps running)`,
    ]);
  });

  test('updates for a host entity from anyone but the current host are ignored', () => {
    const { a, b, net, run } = room3();
    const d = a.spawn('drone', { x: 1, y: 2 }, { owner: 'host' });
    run(300);
    const [, , , hash] = net.updates('pa')[0]!.e[0]!;
    b.receive({ $gr: 'u', t: net.now, e: [[d.id, 16 | 8, [0, 999, 1, 999], hash!]] }, 'pc', net.now);
    run(300);
    expect(b.get(d.id)!.x).toBe(1);
  });

  test('handover: the new host keeps the same objects, writes them, and everyone follows', () => {
    const { a, b, c, run, handOver } = room3();
    const d = a.spawn('drone', { x: 1, y: 0 }, { owner: 'host' });
    run(300);
    const onB = b.get(d.id)!;
    const onC = c.get(d.id)!;
    handOver('pb');
    expect(b.get(d.id)).toBe(onB);
    expect(onB.mine).toBe(true);
    onB.x = 50;
    run(400);
    expect(c.get(d.id)).toBe(onC);
    expect(onC.x).toBe(50);
    expect(onC.owner.name).toBe('bo');
  });

  test('handover away: the old host’s object turns read-only and follows the new host', () => {
    const { a, b, run, handOver } = room3();
    const d = a.spawn('drone', { x: 1, y: 0 }, { owner: 'host' });
    run(300);
    handOver('pb');
    expect(d.mine).toBe(false);
    d.x = 2; // skipped: pb writes it now
    expect(d.x).not.toBe(2);
    b.get(d.id)!.x = 70;
    run(400);
    expect(a.get(d.id)).toBe(d);
    expect(d.x).toBe(70);
  });

  test('the old host leaving never removes host entities', () => {
    const { a, b, c, run, handOver } = room3();
    const d = a.spawn('drone', { x: 1, y: 0 }, { owner: 'host' });
    run(300);
    handOver('pb');
    b.playerLeft('pa');
    c.playerLeft('pa');
    run(500);
    expect(c.get(d.id)).toBeDefined();
    expect(b.get(d.id)).toBeDefined();
  });

  test('a handover before the new host saw the spawn still takes it over and fires spawn', () => {
    const { a, b, events, handOver, net } = room3();
    const d = a.spawn('drone', { x: 3, y: 0 }, { owner: 'host' });
    a.tick();
    net.advanceTo(net.now + 1); // delivered, but b's timeline hasn't reached it
    expect(b.get(d.id)).toBeUndefined();
    handOver('pb');
    expect(b.get(d.id)?.x).toBe(3);
    expect(events).toContain('pb spawn drone');
  });

  test('a late joiner gets host entities from the current host', () => {
    const { a, run, net } = room3();
    const d = a.spawn('drone', { x: 4, y: 0 }, { owner: 'host' });
    run(300);
    let late!: EntityStore;
    late = new EntityStore(net.join('pd', 'di', (dd, f, at) => late.receive(dd, f, at)));
    late.define('drone', DRONE);
    a.playerJoined('pd');
    for (let t = 0; t < 400; t += FRAME) {
      net.advanceTo(net.now + FRAME);
      late.tick();
    }
    expect(late.get(d.id)?.x).toBe(4);
  });

  test('a new host continues ids minted by the old one (no hijack guard for host entities)', () => {
    const { a, b, c, run, handOver } = room3();
    const d = a.spawn('drone', { x: 1, y: 0 }, { owner: 'host' });
    const mineOnA = a.spawn('drone', { x: 9, y: 9 }); // a player entity in a's session too
    run(300);
    handOver('pb');
    b.get(d.id)!.x = 33;
    run(400);
    expect(c.get(d.id)!.x).toBe(33);
    expect(c.get(mineOnA.id)!.owner.name).toBe('ada');
  });
});


describe('onLeave: host', () => {
  const FLAG = { x: 'number', y: 'number', held: 'flag' } as const;
  function room() {
    const net = new FakeNet();
    const events: string[] = [];
    const stores: Record<string, EntityStore> = {};
    const join = (id: string, name: string, seed: number) => {
      stores[id] = new EntityStore(
        net.join(id, name, (d, f, at) => stores[id]?.receive(d, f, at)),
        {
          onSpawn: (e) => events.push(`${id} spawn ${e.id}`),
          onRemove: (e, reason) => events.push(`${id} remove ${e.id} ${reason}`),
        },
        createIdAllocator(() => seed),
      );
      stores[id]!.define('flag', FLAG);
      for (const [other, s] of Object.entries(stores)) if (other !== id) s.playerJoined(id);
      return stores[id]!;
    };
    join('pa', 'ada', 0.1);
    join('pb', 'bo', 0.2);
    join('pc', 'cy', 0.3);
    net.host = 'pa';
    const run = (ms: number) => {
      const end = net.now + ms;
      while (net.now + FRAME <= end) {
        net.advanceTo(net.now + FRAME);
        for (const s of Object.values(stores)) s.tick();
      }
    };
    /** `id` leaves for good, in the server's order: player_left first, then a host change if it hosted. */
    const leave = (id: string, newHost?: string) => {
      net.leave(id);
      delete stores[id];
      for (const s of Object.values(stores)) s.playerLeft(id);
      if (newHost) {
        const prev = net.host;
        net.host = newHost;
        for (const s of Object.values(stores)) s.hostChanged(newHost, prev);
      }
    };
    return { net, events, stores, join, run, leave };
  }

  test('a player’s flag stays in the world when they leave, and the host writes it', () => {
    const { stores, events, run, leave } = room();
    const flag = stores.pb!.spawn('flag', { x: 5, y: 0, held: true }, { onLeave: 'host' });
    run(300);
    const onA = stores.pa!.get(flag.id)!;
    const onC = stores.pc!.get(flag.id)!;
    leave('pb');
    run(50);
    expect(stores.pa!.get(flag.id)).toBe(onA);
    expect(onA.mine).toBe(true);
    expect(onA.owner.name).toBe('ada');
    onA.x = 9;
    onA.held = false;
    run(400);
    expect(stores.pc!.get(flag.id)).toBe(onC);
    expect(onC.x).toBe(9);
    expect(onC.held).toBe(false);
    expect(onC.mine).toBe(false);
    expect(events.filter((e) => e.includes('remove'))).toEqual([]);
  });

  test('without the option the entity goes, as before', () => {
    const { stores, events, run, leave } = room();
    const flag = stores.pb!.spawn('flag', { x: 5, y: 0, held: true });
    run(300);
    leave('pb');
    run(400);
    expect(stores.pa!.get(flag.id)).toBeUndefined();
    expect(events).toContain(`pa remove ${flag.id} left`);
  });

  test('when the host itself leaves, the new host ends up writing it', () => {
    const { net, stores, events, run, leave } = room();
    net.host = 'pc';
    const flag = stores.pc!.spawn('flag', { x: 5, y: 0, held: true }, { onLeave: 'host' });
    run(300);
    const onA = stores.pa!.get(flag.id)!;
    const onB = stores.pb!.get(flag.id)!;
    leave('pc', 'pa');
    expect(stores.pa!.get(flag.id)).toBe(onA);
    expect(onA.mine).toBe(true);
    onA.x = 9;
    run(400);
    expect(onB.x).toBe(9);
    expect(events.filter((e) => e.includes('remove'))).toEqual([]);
  });

  test('a late joiner receives the flag bit and honours it', () => {
    const { stores, join, run, leave } = room();
    const flag = stores.pb!.spawn('flag', { x: 5, y: 0, held: true }, { onLeave: 'host' });
    run(300);
    const d = join('pd', 'di', 0.4);
    run(300);
    expect(d.get(flag.id)?.x).toBe(5);
    leave('pb');
    stores.pa!.get(flag.id)!.x = 7;
    run(400);
    expect(d.get(flag.id)?.x).toBe(7);
  });

  test('the conversion keeps the buffer: no jump back on the non-host', () => {
    const { stores, run, leave } = room();
    const flag = stores.pb!.spawn('flag', { x: 0, y: 0, held: true }, { onLeave: 'host' });
    for (let i = 1; i <= 30; i++) {
      flag.x = i * 10;
      run(1000 / 30);
    }
    const onC = stores.pc!.get(flag.id)!;
    const before = onC.x as number;
    leave('pb');
    run(20);
    expect(onC.x as number).toBeGreaterThanOrEqual(before);
  });
});

test('a remote entity past the room cap is dropped with a warning', () => {
  const net = new FakeNet({});
  const warns: string[] = [];
  const DOT = { x: 'number' } as const;
  let viewer!: EntityStore;
  const tv = net.join('pv', 'vi', (d, f, at) => viewer.receive(d, f, at));
  viewer = new EntityStore(tv, { warn: (_kind, key) => warns.push(key) }, createIdAllocator(() => 0.9));
  viewer.define('dot', DOT);
  const owners = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => {
    const t = net.join(id, id, () => {});
    const s = new EntityStore(t, {}, createIdAllocator(() => 0.1 + i / 10));
    s.define('dot', DOT);
    return s;
  });
  const flush = () => {
    for (let f = 0; f < 10; f++) {
      net.advanceTo(net.now + FRAME);
      for (const s of owners) s.tick();
      viewer.tick();
    }
  };
  for (const s of owners.slice(0, 4)) for (let i = 0; i < MAX_OWN; i++) s.spawn('dot', { x: i });
  flush();
  expect(viewer.all('dot').length).toBe(MAX_ROOM);
  expect(warns).toEqual([]);
  owners[4]!.spawn('dot', { x: 0 });
  flush();
  expect(viewer.all('dot').length).toBe(MAX_ROOM);
  expect(warns).toEqual(['room_full']);
});

test('a teleport goes out reliably, so loss can’t turn a respawn into a slide (eval 2026-09-27)', () => {
  const { net, a, b, warns, run } = setup();
  a.define('ship', SHIP);
  b.define('ship', SHIP);
  const ship = a.spawn('ship', { x: 0, y: 0, alive: true });
  run(1500); // past the first keyframe: later sends are plain updates
  net.blackout(net.now, net.now + 200); // every unreliable message in this window is lost
  ship.x = 900;
  ship.teleport();
  run(150);
  const carrying = net.updates('pa').filter((u) => u.e.some(([, flags]) => flags & TELEPORT));
  expect(carrying.length).toBeGreaterThan(0);
  expect(carrying.every((u) => u.reliable)).toBe(true);
  run(600);
  expect(warns).not.toContain('jump:ship');
  expect(b.all('ship')[0]!.x).toBeCloseTo(900, 0);
});
