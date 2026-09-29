/**
 * The LAN shortcut's hooks in Room, on a stand-in relay (no WebRTC here: the sender side, the
 * barriers and the merge of server copies are what's under test).
 */
import { describe, expect, test } from 'bun:test';
import type { Json, PlayerInfo, RoomInfo, ServerMessage } from '@gamerelay/protocol/types';
import { Room, type GameRelay } from '../src/index';
import type { Wrapped } from '../src/sync/lan';

const player = (id: string, slot: number): PlayerInfo => ({ id, name: id, avatar: null, joinedAt: slot, connected: true, slot });

function lanRoom(me: string, hostId = 'pa', stateSeq = 0, opts: { lan?: boolean; forceRelay?: boolean; direct?: boolean; party?: string[]; request?: (m: { t: string }) => Promise<unknown> } = {}) {
  const queued: { t: string; d?: Json; to?: string; h?: boolean }[] = [];
  const clock = { now: 1000 };
  const loops: (() => void)[] = [];
  const relay = {
    connected: true,
    serverReady: true,
    lanWithinRate: () => true,
    lanEnabled: opts.lan ?? true,
    room: null,
    queue: (m: { t: string; d?: Json }) => queued.push(m),
    now: () => clock.now,
    writeTime: () => clock.now,
    tick: (_rate: number, fn: () => void) => (loops.push(fn), () => {}),
    warn: () => {},
    newEntityId: (kind: string) => `${kind}:t:${queued.length + 1}`,
    request: opts.request ?? (async () => undefined),
    lanForceRelay: opts.forceRelay === true,
    lanDirect: opts.direct === true ? 'party' : null,
    party: opts.party ? { code: 'PRTY', leaderId: opts.party[0], members: opts.party.map((id) => ({ id, name: id, connected: true })) } : null,
  } as unknown as GameRelay;
  const info: RoomInfo = {
    id: 'r', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId, stateSeq, chat: [], seed: 1, claims: {}, state: {},
    players: [player('pa', 0), player('pb', 1)],
  };
  const room = new Room(relay, info, me);
  const broadcasts = () => queued.filter((m) => m.t === 'send' && m.to === undefined).map((m) => m.d as unknown as Wrapped);
  const last = () => broadcasts().at(-1)!;
  const step = () => loops.forEach((fn) => fn());
  return { room, queued, clock, broadcasts, last, step };
}

const msg = (m: Record<string, unknown>) => ({ v: 1, ...m }) as unknown as ServerMessage;

describe('LAN shortcut in Room: what sets a barrier', () => {
  test('with lan on, every broadcast is numbered', () => {
    const { room, broadcasts } = lanRoom('pa');
    room.send({ a: 1 });
    room.emit('ping', 1);
    expect(broadcasts().map((w) => w.n)).toEqual([1, 2]);
  });

  test('a state patch or a targeted send sets a barrier', () => {
    const { room, last } = lanRoom('pa');
    room.send(1);
    room.setState({ round: 1 });
    room.send(2);
    expect(last().b).toBe(last().n);
    room.send(3, { to: 'pb' });
    room.send(4);
    expect(last().b).toBe(last().n);
    const b = last().b;
    room.send(5); // no new barrier: 5 still waits on the one before 4
    expect(last().b).toBe(b);
  });

  test('the host’s heartbeats are not barriers (it sends one about 4 times a second)', async () => {
    const { room, last, queued, step } = lanRoom('pa');
    room.send(1);
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(120);
      step();
    }
    expect(queued.some((m) => m.t === 'heartbeat')).toBe(true);
    room.send(2);
    expect(last().b).toBeUndefined();
  });

  test('the debug overlay gets LAN stats when lan is on', () => {
    const { room } = lanRoom('pa');
    expect(room.debugInfo().lan).toEqual({ peers: 0, lanFirst: 0, serverFirst: 0, rttMs: {} });
    expect(room.lanPeers()).toEqual([]);
  });

  test('a server event we received sets a barrier: a reaction to it must not reach a LAN peer first (review 3)', () => {
    for (const event of [
      msg({ t: 'host_changed', hostId: 'pb', previousHostId: 'pa' }),
      msg({ t: 'player_joined', player: player('pc', 2) }),
      msg({ t: 'claimed', key: 'k', playerId: 'pa' }),
    ]) {
      const { room, last } = lanRoom('pb');
      room.send(1);
      room.handle(event);
      room.send(2);
      expect(last().b, event.t).toBe(last().n);
    }
  });

  test('a received state patch is not a barrier: the next broadcast carries its number instead (review 6)', () => {
    const { room, last } = lanRoom('pb');
    room.send(1);
    expect(last().s).toBeUndefined();
    room.handle(msg({ t: 'state', from: 'pa', patch: { round: 2 }, seq: 5 }));
    room.send(2);
    expect(last().b).toBeUndefined();
    expect(last().s).toBe(5);
  });

  test('the snapshot’s state number counts from the start, and again after a reconnect (review 6)', () => {
    const { room, last } = lanRoom('pb', 'pa', 3);
    room.send(1);
    expect(last().s).toBe(3);
    room.sync({ id: 'r', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId: 'pa', stateSeq: 8, chat: [], seed: 1, claims: {}, state: {}, players: [player('pa', 0), player('pb', 1)] });
    room.send(2);
    expect(last().s).toBe(8);
  });

  test('a relayed message from another player is not a barrier (a known limit: see PLAN.md)', () => {
    const { room, last } = lanRoom('pb');
    room.send(1);
    room.handle(msg({ t: 'message', from: 'pa', d: 'hi', at: 1000 }));
    room.send(2);
    expect(last().b).toBeUndefined();
  });
});

describe('LAN shortcut in Room: receiving', () => {
  const wrapped = (n: number, d: Json, e = 's1'): ServerMessage => msg({ t: 'message', from: 'pa', at: 1000, d: { $gr: 'l', e, n, d } });

  test('server copies are unwrapped and delivered to handlers once', () => {
    const { room } = lanRoom('pb');
    const got: Json[] = [];
    room.on('ping', (d: Json) => got.push(d));
    room.handle(wrapped(1, { $gr: 'e', n: 'ping', d: 'a' }));
    room.handle(wrapped(1, { $gr: 'e', n: 'ping', d: 'a' }));
    room.handle(wrapped(2, { $gr: 'e', n: 'ping', d: 'b' }));
    expect(got).toEqual(['a', 'b']);
  });

  test('a player who times out and rejoins is not delivered twice (review 3)', () => {
    const { room } = lanRoom('pb');
    const got: Json[] = [];
    room.on('ping', (d: Json) => got.push(d));
    for (let n = 1; n <= 3; n++) room.handle(wrapped(n, { $gr: 'e', n: 'ping', d: n }));
    room.handle(msg({ t: 'player_left', playerId: 'pa', reason: 'timeout' }));
    room.handle(msg({ t: 'player_joined', player: player('pa', 0) }));
    for (let n = 1; n <= 4; n++) room.handle(wrapped(n, { $gr: 'e', n: 'ping', d: n }));
    expect(got).toEqual([1, 2, 3, 4]);
  });

  test('LAN signals never reach the game’s message handler', () => {
    const { room } = lanRoom('pb');
    const got: unknown[] = [];
    room.on('message', (d: Json) => got.push(d));
    room.handle(msg({ t: 'message', from: 'pa', at: 1000, d: { $gr: 'lan', k: 'hi' } }));
    expect(got).toEqual([]);
  });
});

describe('LAN shortcut in Room: entities', () => {
  test('a host entity spawn or remove waits for its server copy; plain updates race (review 3)', () => {
    const { room, last, clock, step } = lanRoom('pa');
    const ball = room.define('ball', { x: { type: 'number', precision: 1 } });
    const b = ball.spawn({ x: 0 }, { owner: 'host' });
    step();
    const spawn = last();
    expect(spawn.b).toBe(spawn.n); // FULL/spawn: not superseded by the next write
    clock.now += 100;
    b.x = 50;
    step();
    const update = last();
    expect(update.n).toBeGreaterThan(spawn.n);
    expect(update.b).not.toBe(update.n);
    clock.now += 100;
    b.remove();
    step();
    expect(last().b).toBe(last().n);
  });
});

describe('LAN shortcut in Room: renegotiating', () => {
  test('after our own reconnect, the room starts again with players it has no channel to (review 4)', async () => {
    // Stand in for WebRTC so the room tries at all.
    const saved = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = class {};
    try {
      const { room, queued } = lanRoom('pb');
      await Bun.sleep(0); // the server's answer about relays (none here)
      queued.length = 0;
      room.sync({
        id: 'r', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId: 'pa', stateSeq: 0, chat: [], seed: 1, claims: {}, state: {},
        players: [player('pa', 0), player('pb', 1)],
      });
      const signals = queued.filter((m) => m.t === 'send' && (m.d as { $gr?: string })?.$gr === 'lan');
      expect(signals.map((m) => [m.to, (m.d as { k: string }).k])).toEqual([['pa', 'hi']]);
    } finally {
      (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = saved;
    }
  });
});

describe('LAN shortcut in Room: the host’s render time', () => {
  test('a guest who becomes host draws at the slowest sender’s time, not the old host timeline (review 4)', () => {
    const { room, clock } = lanRoom('pb', 'pa');
    room.define('dot', { x: { type: 'number', precision: 1 } });
    // As a guest: host entity samples ~40 ms old, a player's ~250 ms old.
    for (let i = 0; i < 60; i++) {
      clock.now += 50;
      room.handle(msg({ t: 'message', from: 'pa', at: clock.now, d: { $gr: 'u', t: clock.now - 40, e: [['dot:x:1', 16, []]] } }));
      room.handle(msg({ t: 'message', from: 'pc', at: clock.now, d: { $gr: 'u', t: clock.now - 250, e: [] } }));
    }
    const asGuest = clock.now - room.renderTime;
    room.handle(msg({ t: 'host_changed', hostId: 'pb', previousHostId: 'pa' }));
    const asHost = clock.now - room.renderTime;
    expect(asGuest).toBeLessThan(200);
    expect(asHost).toBeGreaterThan(250);
  });

  test('a new host’s old host timeline is not counted at all, even when it was the slowest (review 5)', () => {
    const { room, clock } = lanRoom('pb', 'pa');
    room.define('dot', { x: { type: 'number', precision: 1 } });
    // As a guest: host entity samples ~300 ms old, a player's ~40 ms old.
    for (let i = 0; i < 60; i++) {
      clock.now += 50;
      room.handle(msg({ t: 'message', from: 'pa', at: clock.now, d: { $gr: 'u', t: clock.now - 300, e: [['dot:x:1', 16, []]] } }));
      room.handle(msg({ t: 'message', from: 'pc', at: clock.now, d: { $gr: 'u', t: clock.now - 40, e: [] } }));
    }
    expect(clock.now - room.renderTime).toBeGreaterThan(300);
    room.handle(msg({ t: 'host_changed', hostId: 'pb', previousHostId: 'pa' }));
    expect(clock.now - room.renderTime).toBeLessThan(200);
  });
});

describe('LAN shortcut in Room: relays', () => {
  const withWebRTC = async (fn: () => Promise<void>) => {
    const saved = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = class {};
    try {
      await fn();
    } finally {
      (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = saved;
    }
  };
  const lanSignals = (queued: { t: string; d?: Json; to?: string }[]) =>
    queued.filter((m) => m.t === 'send' && (m.d as { $gr?: string })?.$gr === 'lan').map((m) => [m.to, (m.d as { k: string }).k]);

  test('the room asks for this room’s relay credentials, then starts connecting with them (review 7)', () =>
    withWebRTC(async () => {
      const asked: string[] = [];
      let answer: (v: unknown) => void = () => {};
      const { queued } = lanRoom('pb', 'pa', 0, { request: (m) => (asked.push(m.t), new Promise((res) => (answer = res))) });
      expect(asked).toEqual(['turn']);
      expect(lanSignals(queued)).toEqual([]); // not until the server says which relays there are
      answer({ ice: [{ urls: ['turn:relay.example:3478'], username: 'u', credential: 'c' }] });
      await Bun.sleep(0);
      expect(lanSignals(queued)).toEqual([['pa', 'hi']]);
    }));

  test('a server without relays: the LAN connections start anyway', () =>
    withWebRTC(async () => {
      const { queued } = lanRoom('pb', 'pa', 0, { request: () => Promise.reject(Object.assign(new Error('This server has no relays'), { code: 'unsupported' })) });
      await Bun.sleep(0);
      await Bun.sleep(0);
      expect(lanSignals(queued)).toEqual([['pa', 'hi']]);
    }));

  test('forceRelay and no relays: nothing is tried', () =>
    withWebRTC(async () => {
      const { queued } = lanRoom('pb', 'pa', 0, { forceRelay: true, request: async () => ({ ice: [] }) });
      await Bun.sleep(0);
      await Bun.sleep(0);
      expect(lanSignals(queued)).toEqual([]);
    }));

  /** A stand-in RTCPeerConnection that remembers each connection's config (and its channel, `live`). */
  type Live = { config: RTCConfiguration; channel: { onopen?: () => void } };
  const recordingPeers = async (fn: (configs: RTCConfiguration[], live: Live[]) => Promise<void>) => {
    const saved = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    const configs: RTCConfiguration[] = [];
    const live: Live[] = [];
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = class {
      localDescription = { sdp: 'a' };
      remoteDescription: unknown = null;
      config: RTCConfiguration;
      channel = {};
      constructor(c: RTCConfiguration) {
        configs.push(c);
        this.config = c;
        live.push(this);
      }
      getConfiguration() {
        return this.config;
      }
      setConfiguration(c: RTCConfiguration) {
        this.config = c;
      }
      createDataChannel() {
        return this.channel;
      }
      async setRemoteDescription(d: unknown) {
        this.remoteDescription = d;
      }
      async createAnswer() {
        return { type: 'answer', sdp: 'a' };
      }
      async setLocalDescription() {}
      close() {}
    };
    try {
      await fn(configs, live);
    } finally {
      (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = saved;
    }
  };
  const offerFrom = (from: string, g: string) => msg({ t: 'message', from, d: { $gr: 'lan', k: 'offer', g, sdp: 'o' }, at: 1000 });

  test('credentials are asked for again after 20 minutes; a failed refresh keeps the ones we have', () =>
    recordingPeers(async (configs) => {
      const answers: (() => Promise<unknown>)[] = [
        async () => ({ ice: [{ urls: ['turn:relay.example:3478'], username: 'first', credential: 'c' }] }),
        async () => Promise.reject(new Error('the server is restarting')),
      ];
      let asked = 0;
      const { room, clock, step } = lanRoom('pb', 'pa', 0, { request: () => answers[asked++]!() });
      await Bun.sleep(0);
      step();
      expect(asked).toBe(1);
      clock.now += 21 * 60 * 1000;
      step();
      expect(asked).toBe(2);
      await Bun.sleep(0);
      room.handle(offerFrom('pa', 'g1'));
      await Bun.sleep(0);
      expect(configs.at(-1)!.iceServers).toEqual([{ urls: ['turn:relay.example:3478'], username: 'first', credential: 'c' }]);
    }));

  test('fresh credentials from the 20-minute refresh reach a connection that is already open (reliability review)', () =>
    recordingPeers(async (_configs, live) => {
      const relay = (username: string) => ({ urls: ['turn:192.0.2.1:3478'], username, credential: 'c' });
      const answers = [relay('first'), relay('second')];
      let asked = 0;
      const { room, clock, step } = lanRoom('pb', 'pa', 0, { request: async () => ({ ice: [answers[asked++]!] }) });
      await Bun.sleep(0);
      room.handle(offerFrom('pa', 'g1'));
      await Bun.sleep(0);
      live[0]!.channel.onopen?.();
      clock.now += 21 * 60 * 1000;
      step();
      await Bun.sleep(0);
      expect(asked).toBe(2);
      expect(live).toHaveLength(1);
      expect(live[0]!.config.iceServers).toEqual([relay('second')]);
    }));

  test('a server without relays is not asked again every 20 minutes', () =>
    recordingPeers(async (configs) => {
      let asked = 0;
      const { room, clock, step } = lanRoom('pb', 'pa', 0, { request: async () => (asked++, { ice: [] }) });
      await Bun.sleep(0);
      clock.now += 21 * 60 * 1000;
      step();
      expect(asked).toBe(1);
      room.handle(offerFrom('pa', 'g1'));
      await Bun.sleep(0);
      expect(configs.at(-1)).toEqual({ iceServers: [] });
    }));

  test('direct: party: public addresses only with party members, when the game asks and the owner allows it', () =>
    recordingPeers(async (configs) => {
      const relays = [{ urls: ['turn:192.0.2.1:3478'], username: 'u', credential: 'c' }];
      const withStun = [...relays, { urls: ['stun:192.0.2.1:3478'] }];
      const cases: [Parameters<typeof lanRoom>[3], boolean | undefined, number][] = [
        [{ direct: true, party: ['pa', 'pb'] }, true, 2],
        [{ direct: true, party: ['pb', 'pc'] }, true, 1], // pa isn't in our party
        [{ direct: false, party: ['pa', 'pb'] }, true, 1], // the game didn't ask for it
        [{ direct: true, party: ['pa', 'pb'] }, false, 1], // the owner switched it off
        [{ direct: true, party: ['pa', 'pb'] }, undefined, 1], // an older server doesn't say
      ];
      for (const [opts, allowed, servers] of cases) {
        const { room } = lanRoom('pb', 'pa', 0, { ...opts, request: async () => ({ ice: relays, ...(allowed === undefined ? {} : { direct: allowed }) }) });
        await Bun.sleep(0);
        room.handle(offerFrom('pa', 'g1'));
        await Bun.sleep(0);
        expect(configs.at(-1)!.iceServers).toEqual(withStun.slice(0, servers));
      }
    }));

  test('the owner switching direct connections off reaches a room at the next refresh, and restarts them', () =>
    recordingPeers(async (configs) => {
      const relays = [{ urls: ['turn:192.0.2.1:3478'], username: 'u', credential: 'c' }];
      let allowed = true;
      const { room, queued, clock, step } = lanRoom('pb', 'pa', 0, { direct: true, party: ['pa', 'pb'], request: async () => ({ ice: relays, direct: allowed }) });
      await Bun.sleep(0);
      room.handle(offerFrom('pa', 'g1'));
      await Bun.sleep(0);
      expect(configs.at(-1)!.iceServers).toHaveLength(2);
      queued.length = 0;
      allowed = false;
      clock.now += 21 * 60 * 1000;
      step();
      await Bun.sleep(0);
      expect(lanSignals(queued)).toEqual([['pa', 'hi']]); // started over, without public addresses
      room.handle(offerFrom('pa', 'g2'));
      await Bun.sleep(0);
      expect(configs.at(-1)!.iceServers).toEqual(relays);
    }));

  test('no relays on the server: the owner switching direct connections off still reaches the room at the refresh (PR #21 review)', () =>
    recordingPeers(async (configs) => {
      let allowed = true;
      let asked = 0;
      const { room, queued, clock, step } = lanRoom('pb', 'pa', 0, { direct: true, party: ['pa', 'pb'], request: async () => (asked++, { ice: [], direct: allowed }) });
      await Bun.sleep(0);
      room.handle(offerFrom('pa', 'g1'));
      await Bun.sleep(0);
      expect(configs.at(-1)).toEqual({ iceServers: [] });
      queued.length = 0;
      allowed = false;
      clock.now += 21 * 60 * 1000;
      step();
      await Bun.sleep(0);
      expect(asked).toBe(2);
      expect(lanSignals(queued)).toEqual([['pa', 'hi']]); // started over, without public addresses
    }));

  test('no relays and no direct connections asked for: the server is not asked again', () =>
    recordingPeers(async () => {
      let asked = 0;
      const { clock, step } = lanRoom('pb', 'pa', 0, { request: async () => (asked++, { ice: [], direct: true }) });
      await Bun.sleep(0);
      clock.now += 21 * 60 * 1000;
      step();
      expect(asked).toBe(1);
    }));

  test('with the shortcut off, no credentials are asked for', () => {
    const asked: string[] = [];
    lanRoom('pb', 'pa', 0, { lan: false, request: async (m) => void asked.push(m.t) });
    expect(asked).toEqual([]);
  });
});
