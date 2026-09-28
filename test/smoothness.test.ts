import { describe, expect, test } from 'bun:test';
import type { Json } from '@gamerelay/protocol/types';
import { createIdAllocator } from '../src/core/ids';
import { EntityStore } from '../src/sync/entities';
import { FakeNet, type NetOptions } from './fakeNet';

const FRAME = 1000 / 60;
const R = 200;
const W = 1.5; // rad/s → 300 units per second, a fast ship
const truth = (t: number): [number, number] => [R * Math.cos((W * t) / 1000), R * Math.sin((W * t) / 1000)];
const vel = (t: number): [number, number] => [-R * W * Math.sin((W * t) / 1000), R * W * Math.cos((W * t) / 1000)];

/** Arena's followRemote (examples/arena.html), unchanged in behaviour. */
function arenaFollower() {
  const s = { x: 0, y: 0, tx: 0, ty: 0, tvx: 0, tvy: 0, tAt: 0, seen: false };
  return {
    receive(p: { x: number; y: number; vx: number; vy: number }, now: number) {
      Object.assign(s, { tx: p.x, ty: p.y, tvx: p.vx, tvy: p.vy, tAt: now });
    },
    frame(now: number, dt: number): [number, number] {
      const age = Math.min(0.25, (now - s.tAt) / 1000);
      const ex = s.tx + s.tvx * age;
      const ey = s.ty + s.tvy * age;
      if (!s.seen || Math.hypot(ex - s.x, ey - s.y) > 220) {
        s.x = ex;
        s.y = ey;
        s.seen = true;
      }
      const k = Math.min(1, dt * 15);
      s.x += (ex - s.x) * k;
      s.y += (ey - s.y) * k;
      return [s.x, s.y];
    },
  };
}

function metrics(path: [number, number][], want: [number, number][]) {
  const err = path.reduce((sum, p, i) => sum + Math.hypot(p[0] - want[i]![0], p[1] - want[i]![1]), 0) / path.length;
  const jerk = path.slice(2).map((p, i) => Math.hypot(p[0] - 2 * path[i + 1]![0] + path[i]![0], p[1] - 2 * path[i + 1]![1] + path[i]![1]));
  jerk.sort((a, b) => a - b);
  return { err, jerk: jerk[Math.floor(jerk.length * 0.99)]! };
}

function run(opts: NetOptions) {
  const net = new FakeNet(opts);
  let owner!: EntityStore;
  let viewer!: EntityStore;
  const arena = arenaFollower();
  const to = net.join('owner', 'ada', (d, f, at) => owner.receive(d, f, at));
  const arenaOwner = net.join('arena', 'arena', () => {});
  const tv = net.join('viewer', 'bo', (d, from, at) => {
    if (from === 'arena') arena.receive(d as { x: number; y: number; vx: number; vy: number }, net.now);
    else viewer.receive(d, from, at);
  });
  owner = new EntityStore(to, {}, createIdAllocator(() => 0.3));
  viewer = new EntityStore(tv, {}, createIdAllocator(() => 0.4));
  const SHIP = { x: 'number', y: 'number' } as const;
  owner.define('ship', SHIP);
  viewer.define('ship', SHIP);
  const mine = owner.spawn('ship', { x: R, y: 0 });

  const sdk: [number, number][] = [];
  const sdkWant: [number, number][] = [];
  const old: [number, number][] = [];
  const oldWant: [number, number][] = [];
  let nextArenaSend = 0;
  for (let t = 0; t < 8000; t += FRAME) {
    net.advanceTo(t);
    [mine.x, mine.y] = truth(t);
    owner.tick();
    viewer.tick();
    if (t >= nextArenaSend) {
      nextArenaSend += 50;
      const [x, y] = truth(t);
      const [vx, vy] = vel(t);
      arenaOwner.send({ x: Math.round(x), y: Math.round(y), vx: Math.round(vx), vy: Math.round(vy) } as Json, { reliable: false });
    }
    const e = viewer.all('ship')[0];
    const a = arena.frame(t, FRAME / 1000);
    if (t < 1500 || !e) continue; // warm-up
    sdk.push([e.x as number, e.y as number]);
    sdkWant.push(truth(viewer.renderTime()));
    old.push(a);
    oldWant.push(truth(t));
  }
  return { sdk: metrics(sdk, sdkWant), arena: metrics(old, oldWant), delay: viewer.delay.ms };
}

describe('smoothness', () => {
  test('on a clean network the SDK tracks the path closely', () => {
    const r = run({});
    console.log('clean', JSON.stringify(r));
    expect(r.sdk.err).toBeLessThan(2);
  });

  test('under 120 ms latency, 30 ms jitter and 5% loss: better than Arena’s hand-tuned smoothing', () => {
    const r = run({ latency: 120, jitter: 30, loss: 0.05, seed: 7 });
    console.log('bad network', JSON.stringify(r));
    expect(r.sdk.err).toBeLessThan(r.arena.err);
    expect(r.sdk.jerk).toBeLessThanOrEqual(r.arena.jerk * 1.25);
    expect(r.delay).toBeLessThanOrEqual(500);
  });
});

describe('a simulation rate that doesn’t divide into the send rate', () => {
  /** The owner moves a ship 10 units per step at `simHz`; the SDK sends 20/s; the viewer draws at 60 fps. */
  function steps(simHz: number) {
    const net = new FakeNet({});
    let owner!: EntityStore;
    let viewer!: EntityStore;
    const to = net.join('owner', 'ada', (d, f, at) => owner.receive(d, f, at));
    const tv = net.join('viewer', 'bo', (d, f, at) => viewer.receive(d, f, at));
    owner = new EntityStore(to, {}, createIdAllocator(() => 0.3));
    viewer = new EntityStore(tv, {}, createIdAllocator(() => 0.4));
    owner.define('ship', { x: 'number' });
    viewer.define('ship', { x: 'number' });
    const mine = owner.spawn('ship', { x: 0 });
    const out: number[] = [];
    let nextSim = 0;
    let last: number | null = null;
    for (let t = 0; t < 6000; t += FRAME) {
      net.advanceTo(t);
      while (nextSim <= t) {
        mine.x = (mine.x as number) + 10;
        nextSim += 1000 / simHz;
      }
      owner.tick();
      viewer.tick();
      const x = viewer.all('ship')[0]?.x as number | undefined;
      if (t > 1500 && x !== undefined && last !== null) out.push(x - last);
      if (x !== undefined) last = x;
    }
    return out;
  }

  test('updates are stamped with when the values were written, so others see an even speed (30, 15, 12 Hz)', () => {
    for (const hz of [30, 15, 12]) {
      const d = steps(hz);
      const want = (10 * hz) / 60; // units per frame
      // Most frames move the same amount (the delay adapting at the start can nudge a few).
      const off = d.map((v) => Math.abs(v - want) / want).sort((x, y) => x - y);
      expect(off[Math.floor(off.length * 0.95)]!).toBeLessThan(0.1);
      expect(off.at(-1)!).toBeLessThan(0.4);
      expect(d.filter((v) => v === 0)).toEqual([]); // never stalls
    }
  });

  test('writes inside a tick are stamped at the step’s scheduled time, not when the timer woke', () => {
    // 45 Hz steps run on 60 Hz wakes, so they land up to 16.7 ms late; the ticker knows when each
    // step was due and the transport's writeTime passes that on.
    const net = new FakeNet({});
    let owner!: EntityStore;
    let viewer!: EntityStore;
    let stepAt: number | null = null;
    const base = net.join('owner', 'ada', (d, f, at) => owner.receive(d, f, at));
    const to = { ...base, writeTime: () => stepAt ?? net.now };
    const tv = net.join('viewer', 'bo', (d, f, at) => viewer.receive(d, f, at));
    owner = new EntityStore(to, {}, createIdAllocator(() => 0.3));
    viewer = new EntityStore(tv, {}, createIdAllocator(() => 0.4));
    owner.define('ship', { x: 'number' });
    viewer.define('ship', { x: 'number' });
    const mine = owner.spawn('ship', { x: 0 });
    const d: number[] = [];
    let nextSim = 0;
    let last: number | null = null;
    for (let t = 0; t < 6000; t += FRAME) {
      net.advanceTo(t);
      while (nextSim <= t) {
        stepAt = nextSim;
        mine.x = (mine.x as number) + 10;
        nextSim += 1000 / 45;
      }
      stepAt = null;
      owner.tick();
      viewer.tick();
      const x = viewer.all('ship')[0]?.x as number | undefined;
      if (t > 1500 && x !== undefined && last !== null) d.push(x - last);
      if (x !== undefined) last = x;
    }
    const want = 7.5;
    const off = d.map((v) => Math.abs(v - want) / want).sort((x, y) => x - y);
    expect(off[Math.floor(off.length * 0.95)]!).toBeLessThan(0.1);
  });

  test('a game loop that runs after the send, with late scheduled times, never looks stopped (PR #6 review)', () => {
    // The room's send loop was added first, so each wake sends, then the game's step writes with a
    // scheduled time up to a step behind real time.
    const net = new FakeNet({});
    let owner!: EntityStore;
    let viewer!: EntityStore;
    const base = net.join('owner', 'ada', (d, f, at) => owner.receive(d, f, at));
    const to = { ...base, writeTime: () => net.now - 12 };
    const tv = net.join('viewer', 'bo', (d, f, at) => viewer.receive(d, f, at));
    owner = new EntityStore(to, {}, createIdAllocator(() => 0.3));
    viewer = new EntityStore(tv, {}, createIdAllocator(() => 0.4));
    owner.define('ship', { x: 'number' });
    viewer.define('ship', { x: 'number' });
    const mine = owner.spawn('ship', { x: 0 });
    const d: number[] = [];
    let last: number | null = null;
    for (let t = 0; t < 4000; t += FRAME) {
      net.advanceTo(t);
      owner.tick(); // the send loop first…
      mine.x = (mine.x as number) + 5; // …then the game's step
      viewer.tick();
      const x = viewer.all('ship')[0]?.x as number | undefined;
      if (t > 1500 && x !== undefined && last !== null) d.push(x - last);
      if (x !== undefined) last = x;
    }
    const stills = net.updates('owner').flatMap((m) => m.e).filter((e) => e[2].length === 0);
    expect(stills).toEqual([]); // it never stopped, so no "still here" samples
    expect(Math.min(...d)).toBeGreaterThan(4);
  });

  test('stamps never run backwards or ahead of the clock', () => {
    const net = new FakeNet({});
    const owner = new EntityStore(net.join('owner', 'ada', () => {}), {}, createIdAllocator(() => 0.3));
    owner.define('ship', { x: 'number' });
    const mine = owner.spawn('ship', { x: 0 });
    for (let t = 0; t < 3000; t += FRAME) {
      net.advanceTo(t);
      if (Math.floor(t / 33) % 2 === 0) mine.x = t;
      owner.tick();
    }
    const sent = net.updates('owner');
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.t).toBeGreaterThanOrEqual(sent[i - 1]!.t);
    expect(sent.every((m) => m.t <= 3000)).toBe(true);
  });
});
