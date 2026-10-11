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

describe('one stamp per message, from the fresh values in it (SDK review #4)', () => {
  /**
   * A ship stepped at 30 Hz on 60 fps frames, sent on the 20 Hz grid, next to a resting one whose
   * keyframes go in the same sends. Returns each send's stamp and when the ship was last written.
   */
  function sends(hostMover: boolean) {
    const net = new FakeNet({});
    let owner!: EntityStore;
    const to = net.join('owner', 'ada', (d, f, at) => owner.receive(d, f, at));
    net.join('viewer', 'bo', () => {});
    net.host = 'owner';
    owner = new EntityStore(to, {}, createIdAllocator(() => 0.3));
    owner.define('ship', { x: 'number' });
    owner.spawn('ship', { x: 5 }); // at rest: keyframes only, nothing new in them
    const mover = owner.spawn('ship', { x: 0 }, hostMover ? { owner: 'host' } : {});
    const out: { t: number; written: number }[] = [];
    let nextSim = 0;
    let written = 0;
    for (let t = 0; t < 6000; t += FRAME) {
      net.advanceTo(t);
      if (nextSim <= t) {
        mover.x = (mover.x as number) + 10;
        written = t;
        while (nextSim <= t) nextSim += 1000 / 30;
      }
      const before = net.updates('owner').length;
      owner.tick();
      for (const m of net.updates('owner').slice(before)) {
        if (m.e.some((e) => e[0] === mover.id && e[2].length > 0)) out.push({ t: m.t, written: Math.round(written) });
      }
    }
    return out;
  }

  test('a keyframe with nothing new in the same message doesn’t pull the movers’ stamp up to now', () => {
    const out = sends(false);
    expect(out.length).toBeGreaterThan(100);
    expect(out.filter((s) => s.t !== s.written)).toEqual([]);
  });

  test('a "still here" sent alone doesn’t push the next message’s changes up to it (second review of #4)', () => {
    const net = new FakeNet({});
    let owner!: EntityStore;
    const to = net.join('owner', 'ada', (d, f, at) => owner.receive(d, f, at));
    net.join('viewer', 'bo', () => {});
    owner = new EntityStore(to, {}, createIdAllocator(() => 0.3));
    owner.define('ship', { x: 'number' });
    // Frames are numbered; sends go on the 50 ms grid, every third frame (0, 3, 6, …). The mover is
    // written on frames 1, 4, 7, …: each write waits a frame for its send. The stopper is written
    // once every 1.2 s, on frame 2 (mod 72): sent on the next grid frame, it's quiet 50 ms later, on
    // frame 5, between the mover's write on frame 4 and its send on frame 6: a "still here" alone.
    const stopper = owner.spawn('ship', { x: 0 });
    const mover = owner.spawn('ship', { x: 0 });
    const bad: { t: number; written: number }[] = [];
    let checked = 0;
    let written = 0;
    let stopperWritten = 0;
    for (let f = 0; f < 360; f++) {
      const t = f * FRAME;
      net.advanceTo(t);
      if (f % 72 === 2) {
        stopper.x = (stopper.x as number) + 10;
        stopperWritten = Math.round(t);
      }
      if (f % 3 === 1) {
        mover.x = (mover.x as number) + 10;
        written = Math.round(t);
      }
      const before = net.updates('owner').length;
      owner.tick();
      for (const m of net.updates('owner').slice(before)) {
        if (!m.e.some((e) => e[0] === mover.id && e[2].length > 0)) continue;
        checked++;
        // A message's stamp is its newest change: the stopper's, when its change is in it too.
        const newest = m.e.some((e) => e[0] === stopper.id && e[2].length > 0) ? Math.max(written, stopperWritten) : written;
        if (m.t !== newest) bad.push({ t: m.t, written: newest });
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  test('a change written just after a keyframe or a spawn went is never stamped before it (third review of #4)', () => {
    // The send loop runs first in each wake, then the game's step writes with its scheduled time,
    // before the send. A resting ship's keyframe goes out alone, stamped "now", and the step right
    // after it moves the ship once (a door opening). A second ship is spawned, and moved once by
    // the step right after its spawn went.
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
    const door = owner.spawn('ship', { x: 0 });
    let late: ReturnType<typeof owner.spawn> | undefined;
    const seen = new Map<string, number[]>();
    const movedAt = new Map<string, number>();
    const shown: number[] = []; // what the viewer shows from 0.2 s to 0.9 s after each move
    for (let t = 0; t < 2600; t += FRAME) {
      net.advanceTo(t);
      const before = net.updates('owner').length;
      owner.tick();
      for (const m of net.updates('owner').slice(before)) {
        for (const e of m.e) {
          const stamps = seen.get(e[0]) ?? [];
          seen.set(e[0], [...stamps, m.t]);
          // Its keyframe a second in, with nothing new: it moves in the step right after.
          if (e[0] === door.id && t > 500 && door.x === 0) door.x = 50;
          if (e[0] === late?.id && stamps.length === 0) late.x = 50;
          if (!movedAt.has(e[0]) && (e[0] === door.id ? door : late)?.x === 50) movedAt.set(e[0], t);
        }
      }
      if (t > 1500 && !late) late = owner.spawn('ship', { x: 0 });
      viewer.tick();
      for (const [id, at] of movedAt) if (t > at + 200 && t < at + 900) shown.push(viewer.get(id)!.x as number);
    }
    expect(door.x).toBe(50);
    expect(late?.x).toBe(50);
    for (const [id, stamps] of seen) {
      for (let i = 1; i < stamps.length; i++) expect({ id, t: stamps[i]! }).toEqual({ id, t: Math.max(stamps[i]!, stamps[i - 1]!) });
    }
    // Others see where they ended up, not the keyframe's (or the spawn's) older values after it.
    expect(shown.length).toBeGreaterThan(50);
    expect(shown.filter((x) => x !== 50)).toEqual([]);
  });

  test('an idle entity’s keyframe doesn’t pull a change in the same message up to its last stamp (fourth review of #4)', () => {
    // Frames are 16.7 ms. A (20/s) moves on frames 110 and 113 (its step: 50 ms), is sent on frame
    // 114 (1900 ms), and its "still here" goes alone on frame 118 (1967 ms). B (10/s) is written in
    // that frame's step, scheduled 12 ms earlier, and sent on frame 120 (2000 ms) with A's
    // keyframe, which has nothing new.
    const net = new FakeNet({});
    let stepAt: number | null = null;
    const owner = new EntityStore({ ...net.join('owner', 'ada', () => {}), writeTime: () => stepAt ?? net.now }, {}, createIdAllocator(() => 0.3));
    net.join('viewer', 'bo', () => {});
    owner.define('ship', { x: 'number' });
    owner.define('slow', { x: 'number' }, { rate: 10 });
    const a = owner.spawn('ship', { x: 0 });
    const b = owner.spawn('slow', { x: 0 });
    let written = 0;
    for (let f = 0; f <= 120; f++) {
      const t = f * FRAME;
      net.advanceTo(t);
      if (f === 110) a.x = 4;
      if (f === 113) a.x = 5;
      owner.tick();
      if (f === 118) {
        stepAt = t - 12;
        b.x = 5;
        written = Math.round(stepAt);
        stepAt = null;
      }
    }
    const sent = net.updates('owner');
    expect(sent.at(-2)!.e).toEqual([[a.id, 0, []]]); // the "still here", alone
    const last = sent.at(-1)!;
    expect(last.e.map((e) => [e[0], e[2]])).toEqual([
      [a.id, [0, 5]],
      [b.id, [0, 5]],
    ]); // A's keyframe (nothing new) and B's change
    expect(last.t).toBe(written);
  });

  test('a player who just joined isn’t sent a change stamped before their full update (fourth review of #4)', () => {
    const net = new FakeNet({});
    let owner!: EntityStore;
    let late!: EntityStore;
    const base = net.join('owner', 'ada', (d, f, at) => owner.receive(d, f, at));
    owner = new EntityStore({ ...base, writeTime: () => net.now - 12 }, {}, createIdAllocator(() => 0.3));
    owner.define('ship', { x: 'number' });
    const door = owner.spawn('ship', { x: 0 });
    const shown: number[] = [];
    let joinedAt = -1;
    for (let t = 0; t < 2000; t += FRAME) {
      net.advanceTo(t);
      owner.tick();
      if (joinedAt < 0 && t > 500) {
        const tl = net.join('late', 'cy', (d, f, at) => late.receive(d, f, at));
        late = new EntityStore(tl, {}, createIdAllocator(() => 0.5));
        late.define('ship', { x: 'number' });
        owner.playerJoined('late'); // its full update goes now…
        door.x = 50; // …and the step right after it opens the door
        joinedAt = t;
      }
      if (joinedAt >= 0) {
        late.tick();
        if (t > joinedAt + 200 && t < joinedAt + 900) shown.push(late.get(door.id)!.x as number);
      }
    }
    expect(shown.length).toBeGreaterThan(30);
    expect(shown.filter((x) => x !== 50)).toEqual([]);
  });

  test('host entities keep their own stamps: our own entities’ keyframes don’t pull them up either', () => {
    const out = sends(true);
    expect(out.length).toBeGreaterThan(100);
    expect(out.filter((s) => s.t !== s.written)).toEqual([]);
  });
});

describe('stamps under any write schedule (invariants)', () => {
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test('nobody is ever sent a newer value with an older stamp', () => {
    // Entities only ever move forward (x grows), so in stamp order, what anyone receives for an
    // entity must never go back. Writes come in random steps, some before the send in a frame and
    // some after it with a scheduled time up to a frame earlier; kinds send at 10–60/s; entities
    // spawn, rest, move and are removed; a player joins partway.
    for (let seed = 1; seed <= 40; seed++) {
      const random = rng(seed);
      const net = new FakeNet({});
      let stepAt: number | null = null;
      const owner = new EntityStore({ ...net.join('owner', 'ada', () => {}), writeTime: () => stepAt ?? net.now }, {}, createIdAllocator(() => 0.3));
      net.join('viewer', 'bo', () => {});
      const rates = [10, 20, 30, 60];
      for (const r of rates) owner.define(`k${r}`, { x: 'number' }, { rate: r });
      const live: ReturnType<typeof owner.spawn>[] = [];
      const spawn = () => live.push(owner.spawn(`k${rates[Math.floor(random() * rates.length)]}`, { x: 0 }));
      const step = (t: number) => {
        for (const e of live) if (random() < 0.15) e.x = (e.x as number) + 1 + Math.floor(random() * 3);
        if (random() < 0.02) spawn();
        if (random() < 0.01 && live.length > 1) live.splice(Math.floor(random() * live.length), 1)[0]!.remove();
        void t;
      };
      for (let i = 0; i < 4; i++) spawn();
      let joinedAt = -1;
      for (let f = 0; f < 240; f++) {
        const t = f * FRAME;
        net.advanceTo(t);
        if (random() < 0.5) {
          stepAt = t;
          step(t); // the game's step before the send
        }
        owner.tick();
        if (f === 120) {
          // Between the send and the game's step: the joiner's full update goes before its writes.
          net.join('late', 'cy', () => {});
          joinedAt = net.updates('owner').length;
          owner.playerJoined('late');
        }
        if (random() < 0.5) {
          stepAt = t - random() * FRAME; // after the send, scheduled up to a frame earlier
          step(t);
        }
        stepAt = null;
      }
      const all = net.updates('owner');
      const streams = {
        viewer: all.filter((m) => m.to === undefined),
        late: all.slice(joinedAt).filter((m) => m.to === undefined || m.to === 'late'),
      };
      for (const [who, msgs] of Object.entries(streams)) {
        const seen = new Map<string, { t: number; x: number }[]>();
        for (const m of msgs) {
          for (const [id, , pairs] of m.e) {
            const i = pairs.indexOf(0);
            if (i < 0 || i % 2 !== 0) continue;
            seen.set(id, [...(seen.get(id) ?? []), { t: m.t, x: pairs[i + 1] as number }]);
          }
        }
        for (const [id, list] of seen) {
          const byStamp = [...list].sort((a, b) => a.t - b.t); // stable: ties keep send order
          for (let i = 1; i < byStamp.length; i++) {
            if (byStamp[i]!.x < byStamp[i - 1]!.x) expect({ seed, who, id, at: byStamp[i]!.t, x: byStamp[i]!.x }).toEqual({ seed, who, id, at: byStamp[i]!.t, x: byStamp[i - 1]!.x });
          }
        }
      }
    }
  });
});
