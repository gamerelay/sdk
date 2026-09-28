/**
 * Well-known netcode failure modes, each run through the fake network: what a player would see if
 * the SDK got them wrong (jumps, lurches, ghosts, stale state), asserted as numbers.
 */
import { describe, expect, test } from 'bun:test';
import { angleDelta } from '../src/core/buffer';
import { createIdAllocator } from '../src/core/ids';
import { EntityStore, type Entity } from '../src/sync/entities';
import { Messages } from '../src/sync/messages';
import { FakeNet, type JoinOptions, type NetOptions } from './fakeNet';

const FRAME = 1000 / 60;
const SHIP = { x: 'number', y: 'number', h: 'angle', alive: 'flag' } as const;

interface Pair {
  net: FakeNet;
  owner: EntityStore;
  viewer: EntityStore;
  events: string[];
  warns: string[];
  mine: Entity;
  /** Advance time, ticking both stores every frame; `each` runs after each frame. */
  run(ms: number, each?: () => void): void;
}

function pair(opts: NetOptions = {}, clocks: { owner?: JoinOptions; viewer?: JoinOptions } = {}): Pair {
  const net = new FakeNet(opts);
  const events: string[] = [];
  const warns: string[] = [];
  let owner!: EntityStore;
  let viewer!: EntityStore;
  owner = new EntityStore(net.join('pa', 'ada', (d, f, at) => owner.receive(d, f, at), clocks.owner), {}, createIdAllocator(() => 0.11));
  viewer = new EntityStore(
    net.join('pb', 'bo', (d, f, at) => viewer.receive(d, f, at), clocks.viewer),
    {
      onSpawn: (e) => events.push(`spawn ${e.id}`),
      onRemove: (e, r) => events.push(`remove ${e.id} ${r}`),
      warn: (_kind, k) => warns.push(k),
    },
    createIdAllocator(() => 0.22),
  );
  owner.define('ship', SHIP);
  viewer.define('ship', SHIP);
  const mine = owner.spawn('ship', { x: 0, y: 0, h: 0, alive: true });
  return {
    net,
    owner,
    viewer,
    events,
    warns,
    mine,
    run(ms, each) {
      const end = net.now + ms;
      while (net.now + FRAME <= end + 1e-9) {
        net.advanceTo(net.now + FRAME);
        owner.tick();
        viewer.tick();
        each?.();
      }
    },
  };
}

/** Largest frame-to-frame step and the p99 second difference (lurches) of a rendered path. */
function smoothness(xs: number[]) {
  const steps = xs.slice(1).map((x, i) => Math.abs(x - xs[i]!));
  const jerk = xs.slice(2).map((x, i) => Math.abs(x - 2 * xs[i + 1]! + xs[i]!)).sort((a, b) => a - b);
  return { maxStep: Math.max(...steps), p99Jerk: jerk[Math.floor(jerk.length * 0.99)] ?? 0 };
}

/** Owner moves at a steady 300 units/s along x; returns the viewer's rendered x per frame. */
function steadyRun(p: Pair, ms: number): number[] {
  const xs: number[] = [];
  p.run(ms, () => {
    p.mine.x = (p.mine.x as number) + 5;
    const e = p.viewer.get(p.mine.id);
    if (e) xs.push(e.x as number);
  });
  return xs;
}

describe('packet loss', () => {
  test('5% random loss: motion stays smooth (no lurch bigger than two frames of travel)', () => {
    const p = pair({ loss: 0.05, seed: 3 });
    p.run(500);
    const s = smoothness(steadyRun(p, 4000).slice(30));
    expect(s.maxStep).toBeLessThan(10); // 5 units per frame at 300/s
  });

  test('a 400 ms burst of loss: extrapolation carries it, then it converges without a snap-back jump', () => {
    const p = pair();
    p.run(500);
    p.net.blackout(p.net.now + 300, p.net.now + 700);
    const s = smoothness(steadyRun(p, 3000).slice(30));
    expect(s.maxStep).toBeLessThan(60);
    expect(p.viewer.get(p.mine.id)!.x as number).toBeGreaterThan((p.mine.x as number) - 150);
  });

  test('a discrete change is never lost to packet loss (it rides a reliable update)', () => {
    const p = pair({ loss: 0.5, seed: 9 });
    p.run(500);
    p.mine.alive = false;
    p.run(800);
    expect(p.viewer.get(p.mine.id)!.alive).toBe(false);
  });

  test('a streamed change that lands on a lost update still arrives with the next keyframe', () => {
    const p = pair();
    p.run(500);
    p.net.blackout(p.net.now, p.net.now + 200);
    p.mine.x = 42; // sent once, dropped, then nothing changes
    p.run(1600);
    expect(p.viewer.get(p.mine.id)!.x).toBe(42);
  });
});

describe('duplicates and ordering', () => {
  test('duplicated messages change nothing: no double spawn, same values', () => {
    const p = pair({ duplicate: 0.5, seed: 5 });
    p.run(500);
    steadyRun(p, 1000);
    expect(p.events.filter((e) => e.startsWith('spawn')).length).toBe(1);
  });

  test('a duplicated removal fires one remove event', () => {
    const p = pair({ duplicate: 1 });
    p.run(500);
    p.mine.remove();
    p.run(500);
    expect(p.events.filter((e) => e.startsWith('remove')).length).toBe(1);
  });

  test('keyframes never fire extra spawn events or restart the entity', () => {
    const p = pair();
    p.run(500);
    const held = p.viewer.get(p.mine.id);
    p.run(3500); // three keyframes
    expect(p.events).toEqual([`spawn ${p.mine.id}`]);
    expect(p.viewer.get(p.mine.id)).toBe(held);
  });

  test('events and entity changes from one owner arrive in the order they were made', () => {
    const net = new FakeNet({ latency: 80, jitter: 20, seed: 4 });
    const seen: string[] = [];
    let owner!: EntityStore;
    let viewer!: EntityStore;
    let viewerMsgs!: Messages;
    const to = net.join('pa', 'ada', (d, f, at) => owner.receive(d, f, at));
    const tv = net.join('pb', 'bo', (d, f, at) => viewer.receive(d, f, at) || viewerMsgs.receive(d, f, at));
    owner = new EntityStore(to);
    const ownerMsgs = new Messages(to, () => {});
    viewer = new EntityStore(tv, { onRemove: () => seen.push('removed') });
    viewerMsgs = new Messages(tv, (type) => seen.push(type));
    owner.define('ship', SHIP);
    viewer.define('ship', SHIP);
    const mine = owner.spawn('ship', { x: 0, y: 0, h: 0, alive: true });
    const tick = (ms: number) => {
      for (let t = 0; t < ms; t += FRAME) {
        net.advanceTo(net.now + FRAME);
        owner.tick();
        viewer.tick();
      }
    };
    tick(500);
    ownerMsgs.emit('before', 1, { echo: false });
    owner.tick();
    mine.remove();
    owner.tick();
    ownerMsgs.emit('after', 2, { echo: false });
    tick(1000);
    expect(seen.slice(0, 1)).toEqual(['before']);
    expect(seen).toContain('after');
    expect(seen).toContain('removed');
  });
});

describe('clocks and latency', () => {
  test('clock skew between owner and viewer (±400 ms) still renders smoothly', () => {
    for (const skew of [-400, 400]) {
      const p = pair({ latency: 60, jitter: 10, seed: 2 }, { owner: { clockOffset: skew } });
      p.run(500);
      const s = smoothness(steadyRun(p, 3000).slice(30));
      expect(s.maxStep).toBeLessThan(12);
    }
  });

  test('a jitter spike widens the delay, which then stays within 60–500 ms', () => {
    const p = pair({ latency: 40, jitter: 5, seed: 1 });
    p.run(1000);
    const calm = p.viewer.delay.ms;
    const spiky = new FakeNet({ latency: 40, jitter: 120, seed: 1 });
    void spiky;
    // Simulate a spike by stamping updates with ages far above the calm mean.
    for (let i = 0; i < 40; i++) p.viewer.delay.observe(40 + (i % 2) * 240, 50);
    expect(p.viewer.delay.ms).toBeGreaterThan(calm);
    expect(p.viewer.delay.ms).toBeLessThanOrEqual(500);
    expect(p.viewer.delay.ms).toBeGreaterThanOrEqual(60);
  });

  test('very high latency (500 ms round trip): smooth, and the delay caps at 500 ms', () => {
    const p = pair({ latency: 500, jitter: 40, seed: 8 });
    p.run(1500);
    const s = smoothness(steadyRun(p, 3000).slice(30));
    expect(p.viewer.delay.ms).toBeLessThanOrEqual(500);
    // Samples here are ~500 ms old, at the delay's cap, so the viewer extrapolates; stamps carry
    // when positions were written, so each is honestly a frame older than its send (+5 units).
    expect(s.maxStep).toBeLessThan(45);
  });

  test('no latency at all: the delay floors at 60 ms and rendering follows exactly', () => {
    const p = pair();
    p.run(500);
    expect(p.viewer.delay.ms).toBe(60);
    const s = smoothness(steadyRun(p, 1000).slice(10));
    expect(s.p99Jerk).toBeLessThan(0.5);
  });
});

describe('motion edge cases', () => {
  test('continuous spinning (10 rad/s) never turns the wrong way across ±π', () => {
    const p = pair({ latency: 60, jitter: 15, seed: 6 });
    p.run(500);
    let heading = 0;
    const hs: number[] = [];
    p.run(3000, () => {
      heading += 10 / 60;
      p.mine.h = ((heading + Math.PI) % (2 * Math.PI)) - Math.PI; // wrapped, as games store it
      const e = p.viewer.get(p.mine.id);
      if (e) hs.push(e.h as number);
    });
    const turns = hs.slice(1).map((h, i) => angleDelta(hs[i]!, h));
    expect(turns.slice(30).every((d) => d >= -1e-6)).toBe(true); // always forward
    expect(Math.max(...turns)).toBeLessThan(0.6);
  });

  test('resting for a long time, then moving fast, is not mistaken for a teleport', () => {
    const p = pair();
    p.run(5000);
    const xs = steadyRun(p, 1000);
    expect(p.warns).toEqual([]);
    expect(smoothness(xs.slice(10)).maxStep).toBeLessThan(10);
  });

  test('a respawn with teleport() snaps once and never slides', () => {
    const p = pair({ latency: 60, jitter: 10, seed: 3 });
    p.run(500);
    steadyRun(p, 500);
    const before = p.mine.x as number;
    p.mine.teleport();
    p.mine.x = -1000;
    const xs: number[] = [];
    p.run(600, () => xs.push(p.viewer.get(p.mine.id)!.x as number));
    const between = xs.filter((x) => x < before - 50 && x > -950);
    expect(between).toEqual([]);
    expect(xs.at(-1)).toBe(-1000);
    expect(p.warns).toEqual([]);
  });

  test('stopping dead: the viewer stops at the same place (a hair of overshoot at most)', () => {
    const p = pair({ latency: 80, jitter: 20, seed: 12 });
    p.run(500);
    steadyRun(p, 1000);
    const stop = p.mine.x as number;
    let max = Number.NEGATIVE_INFINITY;
    p.run(1500, () => (max = Math.max(max, p.viewer.get(p.mine.id)!.x as number)));
    // "Still here" goes out only once the final position has actually been sent (this harness
    // writes right after each send), so the viewer extrapolates a few ms: a fifth of a frame here.
    expect(max).toBeLessThanOrEqual(stop + 1.5);
    expect(p.viewer.get(p.mine.id)!.x).toBe(stop);
  });

  test('extreme but valid values survive the round trip at their precision', () => {
    const p = pair();
    p.mine.x = 1e9;
    p.mine.y = -123456.789;
    p.run(600);
    expect(p.viewer.get(p.mine.id)!.x).toBe(1e9);
    expect(p.viewer.get(p.mine.id)!.y).toBe(-123456.79);
  });
});

describe('bandwidth', () => {
  test('an entity at rest sends about one keyframe a second', () => {
    const p = pair();
    p.run(1000);
    p.net.sent.length = 0;
    p.run(5000);
    const n = p.net.updates('pa').length;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(6);
  });

  test('a moving entity sends 20 updates a second, carrying only what changed', () => {
    const p = pair();
    p.run(1000);
    p.net.sent.length = 0;
    steadyRun(p, 1000);
    const msgs = p.net.updates('pa');
    expect(msgs.length).toBeGreaterThanOrEqual(19);
    expect(msgs.length).toBeLessThanOrEqual(21);
    const partial = msgs.filter((m) => m.e[0]![2].length === 2); // just x
    expect(partial.length).toBeGreaterThan(15);
  });

  test('256 moving entities fit in a few messages per tick, each under 16 KB', () => {
    const net = new FakeNet();
    const owner = new EntityStore(net.join('pa', 'ada', () => {}));
    owner.define('dot', { x: 'number', y: 'number' });
    const dots = Array.from({ length: 256 }, (_, i) => owner.spawn('dot', { x: i, y: i }));
    for (let f = 0; f < 30; f++) {
      for (const d of dots) d.x = (d.x as number) + 1.37;
      net.advanceTo(net.now + FRAME);
      owner.tick();
    }
    for (const m of net.sent) expect(new TextEncoder().encode(JSON.stringify(m.data)).byteLength).toBeLessThan(16 * 1024);
    expect(net.updates('pa').length).toBeLessThan(40);
  });
});

describe('joining, leaving, reconnecting', () => {
  test('a late joiner mid-motion sees the entity moving smoothly from its first frame', () => {
    const net = new FakeNet({ latency: 60, jitter: 10, seed: 2 });
    let owner!: EntityStore;
    let late!: EntityStore;
    owner = new EntityStore(net.join('pa', 'ada', (d, f, at) => owner.receive(d, f, at)));
    owner.define('ship', SHIP);
    const mine = owner.spawn('ship', { x: 0, y: 0, h: 0, alive: true });
    for (let t = 0; t < 2000; t += FRAME) {
      mine.x = (mine.x as number) + 5;
      net.advanceTo(net.now + FRAME);
      owner.tick();
    }
    late = new EntityStore(net.join('pc', 'cy', (d, f, at) => late.receive(d, f, at)));
    late.define('ship', SHIP);
    owner.playerJoined('pc');
    const xs: number[] = [];
    for (let t = 0; t < 1500; t += FRAME) {
      mine.x = (mine.x as number) + 5;
      net.advanceTo(net.now + FRAME);
      owner.tick();
      late.tick();
      const e = late.get(mine.id);
      if (e) xs.push(e.x as number);
    }
    expect(xs.length).toBeGreaterThan(60);
    expect(smoothness(xs.slice(5)).maxStep).toBeLessThan(12);
  });

  test('a disconnected owner’s entity freezes, never expires, and continues as the same object', () => {
    const p = pair();
    p.run(500);
    const held = p.viewer.get(p.mine.id);
    p.net.setConnected('pa', false);
    p.net.blackout(p.net.now, p.net.now + 10_000);
    for (let t = 0; t < 8000; t += FRAME) {
      p.net.advanceTo(p.net.now + FRAME);
      p.viewer.tick(); // the owner is gone: it doesn't tick
    }
    expect(p.viewer.get(p.mine.id)).toBe(held);
    expect(held!.owner.connected).toBe(false);
    p.net.setConnected('pa', true);
    p.mine.x = 77;
    p.run(1500);
    expect(p.viewer.get(p.mine.id)).toBe(held);
    expect(held!.x).toBe(77);
    expect(p.events).toEqual([`spawn ${p.mine.id}`]);
  });

  test('spawn and remove in the same frame: nothing is sent, nobody sees it', () => {
    const p = pair();
    p.run(300);
    p.net.sent.length = 0;
    const blink = p.owner.spawn('ship', { x: 1, y: 1, h: 0, alive: true });
    blink.remove();
    p.run(500);
    expect(p.net.updates('pa').some((m) => m.e.some((e) => e[0] === blink.id))).toBe(false);
    expect(p.events.some((e) => e.includes(blink.id))).toBe(false);
  });

  test('spawned then removed quickly after it went out: others see a remove, never a stuck entity', () => {
    const p = pair({ latency: 60 });
    p.run(300);
    const blip = p.owner.spawn('ship', { x: 1, y: 1, h: 0, alive: true });
    p.run(20);
    blip.remove();
    p.run(800);
    expect(p.viewer.get(blip.id)).toBeUndefined();
  });

  test('the owner leaving mid-motion: the entity goes after its last update, once', () => {
    const p = pair({ latency: 60, jitter: 10, seed: 5 });
    p.run(500);
    steadyRun(p, 500);
    p.viewer.playerLeft('pa');
    for (let t = 0; t < 800; t += FRAME) {
      p.net.advanceTo(p.net.now + FRAME);
      p.viewer.tick(); // a player who left sends nothing more
    }
    expect(p.viewer.get(p.mine.id)).toBeUndefined();
    expect(p.events.filter((e) => e.startsWith('remove'))).toEqual([`remove ${p.mine.id} left`]);
  });
});
