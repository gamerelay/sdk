/**
 * The LAN shortcut's merge under random networks: one sender, one receiver, two paths.
 *
 * The server path is in order with jitter, drops some unreliable sends, drops a replaced host's
 * host-only events, and sometimes stalls for seconds. The LAN path is faster, unordered and a
 * little lossy, and sometimes goes down. The receiver's own connection sometimes drops too. Sends are a mix of broadcasts, server-only messages (state
 * patches: barriers) and host-only events, built with the real `Lan.wrap`, merged with the real
 * `Merge`. Every run checks what the merge promises.
 */
import { describe, expect, test } from 'bun:test';
import type { Json } from '@gamerelay/protocol/types';
import { Lan, Merge, type Wrapped } from '../src/sync/lan';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Sent =
  | { kind: 'broadcast'; w: Wrapped; reliable: boolean; hostEvent: boolean; at: number }
  | { kind: 'server-only'; i: number; at: number };

type Logged = { kind: 'broadcast'; n: number } | { kind: 'server-only'; i: number };

interface Run {
  sent: Sent[];
  log: Logged[];
  /** Broadcasts whose server copy the receiver got. */
  serverGot: Set<number>;
  /** Host-only events the server dropped. */
  hostDropped: Set<number>;
}

function simulate(seed: number): Run {
  const r = rng(seed);
  const sender = new Lan({ me: 'a', enabled: false, signal: () => {}, now: () => 0, hostId: () => 'a', players: () => ['a', 'b'], deliver: () => {} });
  const log: Logged[] = [];
  const merge = new Merge((_from, d) => log.push({ kind: 'broadcast', n: (d as { n: number }).n }));
  const events: { t: number; order: number; run: () => void }[] = [];
  let order = 0;
  const at = (t: number, run: () => void) => events.push({ t, order: order++, run });

  const serverBase = 20 + r() * 200; // one-way server latency, ms
  const lanBase = r() * 5;
  const lanJitter = r() * 20; // the LAN channel is unordered: copies can arrive out of order
  const count = r() < 0.3 ? 600 : 150;
  const sent: Sent[] = [];
  const serverGot = new Set<number>();
  const hostDropped = new Set<number>();
  // The server path delivers in order.
  let serverLast = 0;
  // Outages: server stalls (everything waits, long enough to overflow what's held), the LAN down
  // (copies lost), and the receiver's own connection down (the server's copies to it are lost; on
  // reconnect it gets a room snapshot, which stands in for the state patches it missed).
  const stalls: [number, number][] = [];
  const lanDown: [number, number][] = [];
  const recvDown: [number, number][] = [];
  const span = count * 20;
  for (let i = 0; i < 3; i++) {
    if (r() < 0.3) {
      const s = r() * span;
      stalls.push([s, s + 200 + r() * 5000]);
    }
    if (r() < 0.4) {
      const s = r() * span;
      lanDown.push([s, s + 50 + r() * 800]);
    }
  }
  if (r() < 0.3) {
    const s = r() * span;
    recvDown.push([s, s + 300 + r() * 2000]);
  }
  const inside = (spans: [number, number][], t: number) => spans.find(([a, b]) => t >= a && t < b);
  for (const [, end] of recvDown) at(end, () => merge.resync());
  let replaced = false; // the sender stops being host partway: the server drops its host-only events

  /** When a server copy sent at `t` reaches the receiver, or null if its connection is down then. */
  const serverArrival = (t: number): number | null => {
    let arrive = t + serverBase + r() * 30;
    const stall = inside(stalls, arrive);
    if (stall) arrive = stall[1] + r() * 5;
    serverLast = arrive = Math.max(arrive, serverLast);
    return inside(recvDown, arrive) ? null : arrive;
  };

  // Some runs send a burst (hundreds in well under a second) into a stall, to overflow what's held.
  const burst = count === 600 && r() < 0.5 ? 100 : -1;
  if (burst > 0) stalls.push([burst * 20, burst * 20 + 3000]);
  let t = 0;
  for (let i = 0; i < count; i++) {
    t += i >= burst && i < burst + 450 ? r() * 1.5 : r() * 40;
    if (!replaced && r() < 0.01) replaced = true;
    const roll = r();
    if (roll < 0.12) {
      // A state patch: server-only, reliable.
      const i2 = sent.length;
      sender.barrier();
      sent.push({ kind: 'server-only', i: i2, at: t });
      const arrive = serverArrival(t);
      // Missed while the receiver was down: its reconnect snapshot has it.
      const when = arrive ?? inside(recvDown, t + serverBase)?.[1] ?? recvDown.find(([a, b]) => b > t)?.[1] ?? t;
      at(when, () => log.push({ kind: 'server-only', i: i2 }));
      continue;
    }
    const hostEvent = roll < 0.18;
    const reliable = hostEvent || r() < 0.5;
    const w = sender.wrap({ n: 0 } as Json, hostEvent);
    w.d = { n: w.n };
    sent.push({ kind: 'broadcast', w, reliable, hostEvent, at: t });
    // Server copy.
    const dropped = (hostEvent && replaced) || (!reliable && r() < 0.15);
    if (hostEvent && replaced) hostDropped.add(w.n);
    if (!dropped) {
      const arrive = serverArrival(t);
      if (arrive !== null) {
        serverGot.add(w.n);
        const copy = structuredClone(w);
        at(arrive, () => merge.accept('a', copy, arrive, 'ws', arrive));
      }
    }
    // LAN copy: not for a `b === n` message (Lan.wrap never sends one), nor while the LAN is down;
    // unordered, and 5% lost.
    if (w.b !== w.n && !inside(lanDown, t) && r() > 0.05) {
      const arrive = t + lanBase + r() * lanJitter;
      const copy = structuredClone(w);
      at(arrive, () => merge.accept('a', copy, arrive, 'lan', arrive));
    }
  }
  for (let tick = 0; tick < t + 10_000; tick += 16) at(tick, () => merge.tick(tick));
  events.sort((a, b) => a.t - b.t || a.order - b.order);
  for (const ev of events) ev.run();
  return { sent, log, serverGot, hostDropped };
}

describe('LAN shortcut: the merge under random networks', () => {
  const SEEDS = 400;

  test(`${SEEDS} random runs: nothing the server delivered is lost, nothing twice, in order`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { log, serverGot } = simulate(seed);
      const got = log.filter((l) => l.kind === 'broadcast').map((l) => (l as { n: number }).n);
      const ctx = `seed ${seed}`;
      expect(new Set(got).size, ctx).toBe(got.length);
      expect(got, ctx).toEqual([...got].sort((a, b) => a - b));
      for (const n of serverGot) expect(got.includes(n), `${ctx}: broadcast ${n} lost`).toBe(true);
    }
  });

  test(`${SEEDS} random runs: a broadcast never overtakes a server-only message sent before it`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { sent, log } = simulate(seed);
      const seen = new Set<number>();
      for (const l of log) {
        if (l.kind === 'server-only') {
          seen.add(l.i);
          continue;
        }
        const idx = sent.findIndex((s) => s.kind === 'broadcast' && s.w.n === l.n);
        for (let i = 0; i < idx; i++) {
          const s = sent[i]!;
          if (s.kind === 'server-only') expect(seen.has(s.i), `seed ${seed}: broadcast ${l.n} before state patch ${s.i}`).toBe(true);
        }
      }
    }
  });

  test(`${SEEDS} random runs: a host-only event the server dropped is never delivered`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { log, hostDropped } = simulate(seed);
      for (const l of log) if (l.kind === 'broadcast') expect(hostDropped.has(l.n), `seed ${seed}: dropped host event ${l.n} delivered`).toBe(false);
    }
  });
});

/**
 * Three players: host H writes state patches, A broadcasts (reacting to what it has seen), B
 * receives A's copies. Patches reach A and B through the server with different, random latencies,
 * and A's LAN copies reach B fast and out of order. Built with the real `Lan` (A's `stateAt`, B's
 * `stateSeen`) and `Merge`.
 */
function simulateState(seed: number) {
  const r = rng(seed);
  let bSeq = 0;
  const log: { n: number; bSeqAtDelivery: number }[] = [];
  const a = new Lan({ me: 'a', enabled: false, signal: () => {}, now: () => 0, hostId: () => 'h', players: () => ['h', 'a', 'b'], deliver: () => {} });
  const b = new Lan({ me: 'b', enabled: false, signal: () => {}, now: () => 0, hostId: () => 'h', players: () => ['h', 'a', 'b'], deliver: (_f, d) => log.push({ n: (d as { n: number }).n, bSeqAtDelivery: bSeq }) });
  const events: { t: number; order: number; run: () => void }[] = [];
  let order = 0;
  const at = (t: number, run: () => void) => events.push({ t, order: order++, run });
  const toA = 20 + r() * 200;
  const toB = 20 + r() * 200;
  const aToServer = 10 + r() * 100;
  const sent: { n: number; s: number }[] = [];
  let aLast = 0; // A's server path is in order
  let bLastFromA = 0;
  let t = 0;
  let seq = 0;
  for (let i = 0; i < 300; i++) {
    t += r() * 30;
    if (r() < 0.1) {
      // The host writes a patch; it reaches A and B through the server.
      const s = ++seq;
      at(t + toA + r() * 20, () => a.stateAt(Math.max(s, 0)));
      at(t + toB + r() * 20, () => {
        bSeq = Math.max(bSeq, s);
        b.stateAt(bSeq);
      });
      continue;
    }
    at(t, () => {
      // A reacts: a broadcast carrying the state it has.
      const w = a.wrap({ n: 0 } as Json, false);
      w.d = { n: w.n };
      sent.push({ n: w.n, s: w.s ?? 0 });
      const lan = structuredClone(w);
      at(t + r() * 5, () => b.merge.accept('a', lan, 0, 'lan', 0));
      const server = structuredClone(w);
      aLast = Math.max(aLast, t + aToServer);
      // The server relays it to B after every patch it already sent B (one ordered stream per player).
      bLastFromA = Math.max(bLastFromA, aLast + toB + r() * 20);
      at(bLastFromA, () => b.merge.accept('a', server, 0, 'ws', 0));
    });
  }
  // Run in time order; events scheduled while running are inserted as they come.
  const queue = events.splice(0);
  while (queue.length) {
    queue.sort((x, y) => x.t - y.t || x.order - y.order);
    const ev = queue.shift()!;
    ev.run();
    queue.push(...events.splice(0));
  }
  return { log, sent };
}

describe('LAN shortcut: state numbers under random networks (review 6)', () => {
  test(`${400} random runs: never a broadcast before the state it reacted to; nothing lost, twice or out of order`, () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { log, sent } = simulateState(seed);
      const ctx = `seed ${seed}`;
      const ns = log.map((l) => l.n);
      expect(ns, ctx).toEqual(sent.map((x) => x.n)); // all of them (nothing is dropped here), in order
      for (const l of log) {
        const s = sent.find((x) => x.n === l.n)!.s;
        expect(l.bSeqAtDelivery >= s, `${ctx}: broadcast ${l.n} (state ${s}) delivered at state ${l.bSeqAtDelivery}`).toBe(true);
      }
    }
  });
});
