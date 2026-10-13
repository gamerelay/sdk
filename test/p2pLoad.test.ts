import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '@gamerelay/protocol/types';
import { Lan, type LanDeps } from '../src/sync/lan';
import { Peers } from '../src/sync/peers';

/**
 * The WebRTC peer code is a second file, fetched when a room starts P2P (`load.ts`, built by
 * scripts/build.ts). Until it's there nothing changes for the room: with relays, no peer is tried
 * before the server's `turn` reply, which waits for it; if it never comes, the room is server-only.
 */
const sf = { urls: ['turn:192.241.216.26:3478'], username: 'u', credential: 'x' };

function room(load: () => Promise<{ Peers: typeof Peers }>, over: Partial<LanDeps> = {}) {
  const sent: { to: string; d: Json }[] = [];
  const logs: [string, boolean | undefined][] = [];
  let loads = 0;
  const l = new Lan({
    me: 'b',
    enabled: true,
    players: () => ['a', 'b'],
    hostId: () => 'a',
    now: () => 0,
    deliver: () => {},
    signal: (to, d) => sent.push({ to, d }),
    log: (m, failure) => logs.push([m, failure]),
    relay: {},
    createPeer: () => {
      throw new Error('no peer is made in these tests');
    },
    load: () => (loads++, load()),
    ...over,
  });
  return { l, sent, logs, loads: () => loads };
}

function later<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('the P2P code, loaded on demand', () => {
  test('it loads with the room; the relays wait for it, and what came before is dropped as before', async () => {
    const code = later<{ Peers: typeof Peers }>();
    const { l, sent, loads } = room(() => code.promise);
    expect(loads()).toBe(1);
    // A peer's hello before the relays are known: dropped (its retries cover it), loaded or not.
    await l.signal('a', { $gr: 'lan', k: 'ask' });
    l.add('a');
    const relays = l.setRelays([sf]);
    await Bun.sleep(0);
    expect(sent).toEqual([]);
    code.resolve({ Peers });
    await relays;
    // The first relays start everyone, as before: we answer, so we say hello.
    expect(sent).toEqual([{ to: 'a', d: { $gr: 'lan', k: 'hi' } }]);
    expect(l.peers()).toEqual([]);
  });

  test('a load that fails leaves the room server-only, and says why', async () => {
    const { l, sent, logs } = room(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    await l.setRelays([sf]);
    await l.signal('a', { $gr: 'lan', k: 'ask' });
    l.add('a');
    l.reconnect();
    l.playerLeft('a');
    l.tick();
    const w = l.wrap({ x: 1 }, false);
    expect(w).toMatchObject({ $gr: 'l', n: 1, d: { x: 1 } }); // broadcasts still go, numbered, by the server
    expect(sent).toEqual([]);
    expect(l.stats()).toEqual({ peers: 0, lanFirst: 0, serverFirst: 0, rttMs: {} });
    expect(l.route('a')).toBeNull();
    expect(logs).toEqual([["P2P is off: its code didn't load (Failed to fetch dynamically imported module)", true]]);
  });

  test('a room closed before the code arrives makes no peers', async () => {
    const code = later<{ Peers: typeof Peers }>();
    const { l, sent } = room(() => code.promise);
    const relays = l.setRelays([sf]);
    l.close();
    code.resolve({ Peers });
    await relays;
    expect(sent).toEqual([]);
  });

  test('the latest relays win, however their calls fall around the load', async () => {
    // Two relays each, so each list is timed (a probe per relay) before it's used: the last list
    // timed is the one the connections use.
    const A = [{ ...sf, urls: ['turn:192.0.2.1:3478'] }, { ...sf, urls: ['turn:192.0.2.2:3478'] }];
    const B = [{ ...sf, urls: ['turn:198.51.100.1:3478'] }, { ...sf, urls: ['turn:198.51.100.2:3478'] }];
    for (let depth = 0; depth < 8; depth++) {
      const code = later<{ Peers: typeof Peers }>();
      const probed: string[] = [];
      const { l } = room(() => code.promise, { relay: { probe: async (s) => (probed.push((s.urls as string[])[0]!), 10) } });
      const first = l.setRelays(A); // the first answer, while the code loads
      code.resolve({ Peers });
      let wait = Promise.resolve();
      for (let i = 0; i < depth; i++) wait = wait.then(() => {});
      const second = wait.then(() => l.setRelays(B)); // a refresh, somewhere around the load
      await Promise.all([first, second]);
      await Bun.sleep(0);
      expect({ depth, last: probed.slice(-2) }).toEqual({ depth, last: B.map((s) => s.urls[0]) });
    }
  });

  test('not fetched with P2P off, or without WebRTC', () => {
    expect(room(async () => ({ Peers }), { enabled: false }).loads()).toBe(0);
    expect(typeof RTCPeerConnection).toBe('undefined'); // Bun has none
    expect(room(async () => ({ Peers }), { createPeer: undefined }).loads()).toBe(0);
  });

  test('the builds: the peer code only in the chunk, which is named by its contents and stands alone', async () => {
    // A separate process: Bun.build inside the whole suite's run trips over other tests' module state.
    const dir = mkdtempSync(join(tmpdir(), 'gamerelay-sdk-'));
    try {
      const out = Bun.spawnSync(['bun', 'scripts/build.ts', '--out', dir], { cwd: new URL('..', import.meta.url).pathname });
      expect(out.exitCode).toBe(0);
      const chunks = readdirSync(dir).filter((f) => f.startsWith('gamerelay-p2p.'));
      expect(chunks).toHaveLength(1);
      const name = chunks[0]!;
      const chunk = await Bun.file(join(dir, name)).text();
      expect(name).toBe(`gamerelay-p2p.${new Bun.CryptoHasher('sha256').update(chunk).digest('hex').slice(0, 12)}.mjs`);
      expect(chunk).toContain('createDataChannel');
      expect(chunk).not.toMatch(/\bimport\s*[({'"]|\bfrom\s*['"]/);
      const esm = await Bun.file(join(dir, 'gamerelay.mjs')).text();
      const iife = await Bun.file(join(dir, 'gamerelay.js')).text();
      for (const main of [esm, iife]) expect(main).not.toContain('createDataChannel');
      // ESM: a literal path, for bundlers. Script tag: next to its script, else jsDelivr at this version.
      expect(esm).toContain(`import("./${name}")`);
      const { version } = await Bun.file(new URL('../package.json', import.meta.url)).json();
      expect(iife).toContain(`"${name}"`);
      expect(iife).toContain(`"${version}"`); // jsDelivr at this version, when not beside our file (chunkBase.test.ts)
      expect(iife).toContain('cdn.jsdelivr.net/npm/@gamerelay/sdk@');
      expect(iife).toContain('currentScript');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
