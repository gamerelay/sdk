import { describe, expect, test } from 'bun:test';
import { delaysFrom, pickRelay, probeRelay, relayAddresses, relayKey, routeOf, rttOf, streamUrls, stunUrls } from '../src/sync/relays';

const sf = { urls: ['turn:192.241.216.26:3478', 'turn:192.241.216.26:3478?transport=tcp'], username: 'u', credential: 'c' };
const ny = { urls: ['turn:203.0.113.7:3478'], username: 'u', credential: 'c' };
const la = { urls: 'turn:198.51.100.4:3478', username: 'u', credential: 'c' };

describe('relays: choosing one for a pair of players', () => {
  test('a relay is known by its first URL', () => {
    expect(relayKey(sf)).toBe('turn:192.241.216.26:3478');
    expect(relayKey(la)).toBe('turn:198.51.100.4:3478');
  });

  test('the least delay for both players wins', () => {
    const mine = { [relayKey(sf)]: 10, [relayKey(ny)]: 80 };
    expect(pickRelay([sf, ny], mine, { [relayKey(sf)]: 90, [relayKey(ny)]: 12 })).toBe(relayKey(ny));
    expect(pickRelay([sf, ny], mine, { [relayKey(sf)]: 30, [relayKey(ny)]: 12 })).toBe(relayKey(sf));
  });

  test('without both players’ delays: ours, then theirs, then the first relay', () => {
    expect(pickRelay([sf, ny], { [relayKey(ny)]: 5 }, undefined)).toBe(relayKey(ny));
    expect(pickRelay([sf, ny], {}, { [relayKey(ny)]: 5 })).toBe(relayKey(ny));
    expect(pickRelay([sf, ny], {}, undefined)).toBe(relayKey(sf));
    expect(pickRelay([], {}, undefined)).toBeUndefined();
  });

  test('a tie goes to the relay listed first; relays we don’t have are ignored', () => {
    expect(pickRelay([sf, ny], { [relayKey(sf)]: 20, [relayKey(ny)]: 20 }, undefined)).toBe(relayKey(sf));
    expect(pickRelay([ny, sf], { [relayKey(sf)]: 20, [relayKey(ny)]: 20 }, undefined)).toBe(relayKey(ny));
    expect(pickRelay([sf], {}, { 'turn:evil.example:3478': 0 })).toBe(relayKey(sf));
  });

  test('a relay only one player timed loses to one both did (the other may not reach it)', () => {
    const mine = { [relayKey(sf)]: 5, [relayKey(ny)]: 80 };
    expect(pickRelay([sf, ny], mine, { [relayKey(ny)]: 10 })).toBe(relayKey(ny));
  });

  test('delays from another player are checked: numbers from 0 to 10 s, a few relays at most', () => {
    expect(delaysFrom({ a: 12, b: -1, c: 'x', d: 99_999, e: Number.NaN })).toEqual({ a: 12 });
    expect(delaysFrom({ a: 0, b: 10_000, c: 10_001 })).toEqual({ a: 0, b: 10_000 });
    expect(delaysFrom({ ['x'.repeat(513)]: 5 })).toEqual({});
    expect(delaysFrom([5, 6])).toBeUndefined();
    expect(delaysFrom('fast')).toBeUndefined();
    expect(delaysFrom(null)).toBeUndefined();
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`r${i}`, i]));
    expect(Object.keys(delaysFrom(many) ?? {}).length).toBeLessThanOrEqual(16);
  });
});

describe('relays: the addresses a peer’s relay candidate may have (security review)', () => {
  test('each TURN URL’s host, when it’s an IP literal; a hostname can’t be matched, so it gives none', () => {
    const v6 = { urls: ['turns:[2001:DB8::7]:5349?transport=tcp'], username: 'u', credential: 'c' };
    const named = { urls: ['turn:relay.example.com:3478'], username: 'u', credential: 'c' };
    expect([...relayAddresses([sf, la, v6, named])]).toEqual(['192.241.216.26', '198.51.100.4', '2001:db8::7']);
    expect(relayAddresses([])).toEqual(new Set());
  });
});

describe('relays: timing a STUN ping', () => {
  test('a relay’s UDP TURN URLs, as STUN URLs (the relay answers STUN on the same port)', () => {
    expect(stunUrls(sf)).toEqual(['stun:192.241.216.26:3478']);
    expect(stunUrls({ urls: ['turns:relay.example:443?transport=tcp'] })).toEqual([]);
    expect(stunUrls({ urls: 'turn:[2001:db8::1]:3478?transport=udp' })).toEqual(['stun:[2001:db8::1]:3478']);
    expect(stunUrls({ urls: ['turn:relay.example'] })).toEqual(['stun:relay.example']);
    expect(stunUrls({ urls: ['stun:relay.example:3478'] })).toEqual([]); // not a relay of ours
  });

  class Peer {
    config: unknown;
    closed = false;
    onicecandidate: ((ev: { candidate: { candidate: string } | null }) => void) | null = null;
    constructor(readonly answer: (p: Peer) => void) {}
    createDataChannel() {
      return {};
    }
    async createOffer() {
      return { type: 'offer', sdp: 'o' };
    }
    async setLocalDescription() {
      setTimeout(() => this.answer(this), 0);
    }
    close() {
      this.closed = true;
    }
  }

  test('the time to our public-address candidate, which needs one round trip to the relay', async () => {
    const clock = { t: 100 };
    const peers: Peer[] = [];
    const ms = await probeRelay(sf, {
      clock: () => clock.t,
      createPeer: (config) => {
        const p = new Peer((p) => {
          p.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.5 5000 typ host' } });
          clock.t += 23;
          p.onicecandidate?.({ candidate: { candidate: 'candidate:2 1 udp 1 73.71.58.49 5000 typ srflx raddr 0.0.0.0 rport 0' } });
        });
        p.config = config;
        peers.push(p);
        return p as unknown as RTCPeerConnection;
      },
    });
    expect(ms).toBe(23);
    expect(peers[0]!.config).toEqual({ iceServers: [{ urls: ['stun:192.241.216.26:3478'] }] });
    expect(peers[0]!.closed).toBe(true);
  });

  test('gathering ends without our public address (UDP blocked): no delay, without waiting out the timeout', async () => {
    const started = performance.now();
    const ms = await probeRelay(sf, {
      timeoutMs: 5000,
      createPeer: () =>
        new Peer((p) => {
          p.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.5 5000 typ host' } });
          p.onicecandidate?.({ candidate: null });
        }) as unknown as RTCPeerConnection,
    });
    expect(ms).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('WebRTC failing (no constructor, a refused description): no delay, and the connection is closed', async () => {
    expect(await probeRelay(sf, { createPeer: () => { throw new Error('no WebRTC'); } })).toBeNull();
    const p = new Peer(() => {});
    p.setLocalDescription = () => Promise.reject(new Error('refused'));
    expect(await probeRelay(sf, { createPeer: () => p as unknown as RTCPeerConnection })).toBeNull();
    expect(p.closed).toBe(true);
  });

  test('no answer in time, or nothing to ping: no delay', async () => {
    const make = () => new Peer(() => {}) as unknown as RTCPeerConnection;
    expect(await probeRelay(sf, { createPeer: make, timeoutMs: 5 })).toBeNull();
    let made = 0;
    expect(await probeRelay({ urls: ['stun:relay.example:3478'] }, { createPeer: () => (made++, make()) })).toBeNull();
    expect(made).toBe(0);
  });

  const nyc = {
    urls: ['turn:167.172.234.10:3478', 'turn:167.172.234.10:3478?transport=tcp', 'turns:turn-nyc.gamerelay.io:443?transport=tcp'],
    username: 'u',
    credential: 'c',
  };

  test('a relay’s stream URLs, TLS first', () => {
    expect(streamUrls(nyc)).toEqual(['turns:turn-nyc.gamerelay.io:443?transport=tcp', 'turn:167.172.234.10:3478?transport=tcp']);
    expect(streamUrls(ny)).toEqual([]);
  });

  test('where UDP is blocked, a relay is timed over TLS: its relay candidate, in round trips', async () => {
    const clock = { t: 0 };
    const peers: Peer[] = [];
    const ms = await probeRelay(nyc, {
      clock: () => clock.t,
      createPeer: (config) => {
        const udp = peers.length === 0;
        const p = new Peer((p) => {
          if (udp) return p.onicecandidate?.({ candidate: null }); // no srflx: UDP doesn't get out
          clock.t += 120; // TCP, TLS 1.3, a 401 and the Allocate: 4 round trips of 30 ms
          p.onicecandidate?.({ candidate: { candidate: 'candidate:3 1 udp 1 167.172.234.10 50000 typ relay raddr 0.0.0.0 rport 0' } });
        });
        p.config = config;
        peers.push(p);
        return p as unknown as RTCPeerConnection;
      },
    });
    expect(ms).toBe(30);
    expect(peers[1]!.config).toEqual({
      iceServers: [{ urls: ['turns:turn-nyc.gamerelay.io:443?transport=tcp'], username: 'u', credential: 'c' }],
      iceTransportPolicy: 'relay',
    });
    expect(peers.every((p) => p.closed)).toBe(true);
    // Over plain TCP, 3 round trips.
    clock.t = 0;
    peers.length = 0;
    const tcpOnly = { ...sf };
    const viaTcp = await probeRelay(tcpOnly, {
      clock: () => clock.t,
      createPeer: (config) => {
        const udp = peers.length === 0;
        const p = new Peer((p) => {
          if (udp) return p.onicecandidate?.({ candidate: null });
          clock.t += 90;
          p.onicecandidate?.({ candidate: { candidate: 'candidate:3 1 udp 1 192.241.216.26 50000 typ relay raddr 0.0.0.0 rport 0' } });
        });
        p.config = config;
        peers.push(p);
        return p as unknown as RTCPeerConnection;
      },
    });
    expect(viaTcp).toBe(30);
  });
});

describe('relays: which route a connection took', () => {
  const report = (entries: Record<string, Record<string, unknown>>) => new Map(Object.entries(entries));

  test('the selected pair (Chrome, Safari: from the transport); relay if either side is one', () => {
    const r = (local: string, remote: string) =>
      routeOf(report({
        t: { type: 'transport', selectedCandidatePairId: 'p' },
        p: { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' },
        other: { type: 'candidate-pair', localCandidateId: 'l2', remoteCandidateId: 'r' },
        l: { type: 'local-candidate', candidateType: local },
        l2: { type: 'local-candidate', candidateType: 'relay' },
        r: { type: 'remote-candidate', candidateType: remote },
      }));
    expect(r('host', 'host')).toBe('direct');
    expect(r('prflx', 'host')).toBe('direct');
    expect(r('relay', 'relay')).toBe('relay');
    expect(r('host', 'relay')).toBe('relay');
  });

  test('Firefox: no transport stats, the selected pair is marked', () => {
    expect(
      routeOf(report({
        p1: { type: 'candidate-pair', selected: false, localCandidateId: 'l', remoteCandidateId: 'r' },
        p2: { type: 'candidate-pair', selected: true, localCandidateId: 'l', remoteCandidateId: 'r2' },
        l: { type: 'local-candidate', candidateType: 'host' },
        r: { type: 'remote-candidate', candidateType: 'host' },
        r2: { type: 'remote-candidate', candidateType: 'relay' },
      })),
    ).toBe('relay');
  });

  test('nothing selected yet, or candidates missing from the report: not known', () => {
    expect(routeOf(report({}))).toBeNull();
    expect(routeOf(report({ t: { type: 'transport' } }))).toBeNull();
    expect(routeOf(report({ t: { type: 'transport', selectedCandidatePairId: 'p' }, p: { type: 'candidate-pair', localCandidateId: 'x', remoteCandidateId: 'y' } }))).toBeNull();
  });

  test('the selected pair’s round trip, in ms; none measured yet, or a nonsense value: not known (reliability review)', () => {
    const pairs = (rtt: unknown) => ({
      t: { type: 'transport', selectedCandidatePairId: 'p' },
      p: { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: rtt },
      other: { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: 0.5 },
    });
    expect(rttOf(report(pairs(0.0123)))).toBe(12);
    expect(rttOf(report(pairs(undefined)))).toBeNull();
    expect(rttOf(report(pairs(-1)))).toBeNull();
    expect(rttOf(report({ p: { type: 'candidate-pair', selected: true, currentRoundTripTime: 0.031 } }))).toBe(31); // Firefox
    expect(rttOf(report({}))).toBeNull();
  });
});
