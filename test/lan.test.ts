import { describe, expect, test } from 'bun:test';
import { LIMITS } from '@gamerelay/protocol/limits';
import type { Json } from '@gamerelay/protocol/types';
import { Lan, MAX_LAN_COPY_BYTES, MAX_UNCONFIRMED, Merge, PROBE_EVERY, RACE_WINDOW, RETRY_MS, SPARSE_MS, STALE_MS, type LanDeps, type Wrapped } from '../src/sync/lan';

const w = (n: number, e = 'A', b?: number): Wrapped => ({ $gr: 'l', e, n, ...(b ? { b } : {}), d: n });

function setup() {
  const got: Json[] = [];
  const merge = new Merge((_from, d) => got.push(d));
  return { got, merge };
}

describe('LAN shortcut: merging the server and LAN copies', () => {
  test('server copies alone go straight through, gaps included (the server dropped those)', () => {
    const { got, merge } = setup();
    for (const n of [1, 2, 4, 5]) merge.accept('bo', w(n), 0, 'ws');
    expect(got).toEqual([1, 2, 4, 5]);
  });

  test('each message is delivered once, from whichever path wins', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('bo', w(2), 0, 'lan');
    merge.accept('bo', w(3), 0, 'lan');
    merge.accept('bo', w(2), 0, 'ws');
    merge.accept('bo', w(3), 0, 'ws');
    merge.accept('bo', w(4), 0, 'ws');
    merge.accept('bo', w(4), 0, 'lan');
    expect(got).toEqual([1, 2, 3, 4]);
    expect(merge.won).toEqual({ lan: 2, ws: 2 });
  });

  test('a LAN copy that runs ahead waits for the server to fill the gap, however slow it is (review 2)', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('bo', w(3), 0, 'lan');
    expect(got).toEqual([1]);
    merge.accept('bo', w(2), 0, 'ws');
    expect(got).toEqual([1, 2, 3]);
  });

  test('a gap the server has passed is skipped at once (the server dropped it)', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('bo', w(3), 0, 'lan');
    merge.accept('bo', w(3), 0, 'ws'); // no 2 before it: dropped
    expect(got).toEqual([1, 3]);
    merge.accept('bo', w(2), 0, 'lan'); // a late LAN copy of what the server dropped: not out of order
    expect(got).toEqual([1, 3]);
  });

  test('LAN copies held when the channel opens are delivered in order with the server copies still in flight (review 2)', () => {
    const { got, merge } = setup();
    for (const n of [44, 45]) merge.accept('bo', w(n), 0, 'ws');
    merge.accept('bo', w(50), 0, 'lan');
    for (const n of [46, 47, 48, 49, 50]) merge.accept('bo', w(n), 0, 'ws');
    expect(got).toEqual([44, 45, 46, 47, 48, 49, 50]);
  });

  test('before any server copy, LAN copies wait for the server to set the starting point', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(5), 0, 'lan');
    merge.accept('bo', w(6), 0, 'lan');
    expect(got).toEqual([]);
    merge.accept('bo', w(4), 0, 'ws');
    expect(got).toEqual([4, 5, 6]);
  });

  test('a new session’s LAN copies wait for its first server copy: only the server starts a session (security review)', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'lan');
    merge.accept('bo', w(2), 0, 'lan');
    expect(got).toEqual([]);
    merge.accept('bo', w(1), 0, 'ws');
    expect(got).toEqual([1, 2]);
  });

  test('sessions made up over the LAN deliver nothing and never push the real one out (security review)', () => {
    // Otherwise a peer could start a stream the server never sees, at its first message.
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    for (const e of ['X', 'Y', 'Z', 'Q', 'R']) for (let n = 1; n <= 3; n++) merge.accept('bo', { ...w(n, e), d: `${e}${n}` }, 0, 'lan');
    merge.accept('bo', w(2), 0, 'lan');
    merge.accept('bo', w(3), 0, 'ws');
    expect(got).toEqual([1, 2, 3]);
  });

  test(`LAN copies of an unconfirmed session: at most ${MAX_UNCONFIRMED} per sender, for STALE_MS at most (security review)`, () => {
    const { got, merge } = setup();
    for (let n = 1; n <= MAX_UNCONFIRMED + 10; n++) merge.accept('bo', w(n), 0, 'lan', 0);
    merge.accept('bo', w(MAX_UNCONFIRMED + 11), 0, 'ws', 0);
    expect(got).toEqual(Array.from({ length: MAX_UNCONFIRMED + 1 }, (_, i) => i + 11)); // the oldest 10 went
    const late = setup();
    late.merge.accept('bo', w(1), 0, 'lan', 0);
    late.merge.tick(STALE_MS);
    late.merge.accept('bo', w(2), 0, 'ws', STALE_MS);
    expect(late.got).toEqual([2]);
  });

  test('a sender who leaves, or our reconnect, discards its unconfirmed LAN copies too (security review)', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'lan');
    merge.forget('bo');
    merge.accept('bo', w(1, 'B'), 0, 'lan');
    merge.resync();
    merge.accept('bo', w(2), 0, 'ws');
    merge.accept('bo', w(2, 'B'), 0, 'ws');
    expect(got).toEqual([2, 2]);
  });

  test('held LAN copies are delivered, not dropped, when the first server copy is ahead of them', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(5), 0, 'lan');
    merge.accept('bo', w(6), 0, 'lan');
    merge.accept('bo', w(7), 0, 'ws');
    expect(got).toEqual([5, 6, 7]);
  });

  test('held copies are never forced out: they wait for the sender’s next server copy (review 3)', () => {
    // A stalled or restarting server: the LAN copies must not go ahead of what it still holds.
    // (After STALE_MS they're discarded instead: see below.)
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('bo', w(3), 0, 'lan');
    merge.accept('bo', w(4), 0, 'lan');
    expect(got).toEqual([1]);
    merge.accept('bo', w(4), 0, 'ws'); // the server dropped 2 (and 3); 4 frees what's held
    expect(got).toEqual([1, 3, 4]);
  });

  test('a reload (new session) starts the sequence over; what the old one had held is discarded (review 3)', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('bo', w(3), 0, 'lan'); // its server copy never came: the server didn't relay it
    merge.accept('bo', w(1, 'B'), 0, 'ws');
    expect(got).toEqual([1, 1]);
  });

  test('a player who leaves: what was held is discarded, never delivered after they are gone (review 3)', () => {
    // The server relays a player's messages before its player_left: a LAN copy still held then
    // has no server copy coming, so a server-only player wouldn't get it either.
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('bo', w(3), 0, 'lan');
    merge.forget('bo');
    expect(got).toEqual([1]);
  });

  test('a player who times out and rejoins is not delivered twice (review 3, reproduced)', () => {
    // Same room object, so the same session and numbers: its outbox resends 1–5 through the server.
    const { got, merge } = setup();
    for (let n = 1; n <= 5; n++) merge.accept('bo', w(n), 0, 'lan');
    merge.forget('bo');
    for (let n = 1; n <= 5; n++) merge.accept('bo', w(n), 0, 'ws');
    merge.accept('bo', w(6), 0, 'ws');
    expect(got).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('too much held: LAN copies are discarded, not forced past a barrier or a gap (review 3, reproduced)', () => {
    // A state patch (barrier 2), then 300 broadcasts while the server path is down.
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    for (let n = 3; n <= 300; n++) merge.accept('bo', w(n, 'A', 2), 0, 'lan');
    expect(got).toEqual([1]);
    for (let n = 2; n <= 300; n++) merge.accept('bo', w(n, 'A', 2), 0, 'ws');
    expect(got).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  test('a LAN copy held over a second is discarded, not delivered late; its server copy still counts (review 3)', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws', 0);
    merge.accept('bo', w(3, 'A', 2), 0, 'lan', 0);
    merge.tick(STALE_MS);
    merge.accept('bo', w(2, 'A', 2), 0, 'ws', STALE_MS + 1);
    expect(got).toEqual([1, 2]);
    merge.accept('bo', w(3, 'A', 2), 0, 'ws', STALE_MS + 2);
    expect(got).toEqual([1, 2, 3]);
  });

  test('after our own reconnect, held LAN copies are discarded (the server won’t replay what we missed) (review 3)', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('bo', w(3, 'A', 2), 0, 'lan');
    merge.resync();
    merge.accept('bo', w(4), 0, 'ws');
    expect(got).toEqual([1, 4]);
  });

  test('senders are merged separately', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('cy', w(1), 0, 'ws');
    merge.accept('cy', w(2), 0, 'lan');
    merge.accept('bo', w(2), 0, 'lan');
    expect(got).toEqual([1, 1, 2, 2]);
  });

  test('a LAN copy that races ahead of a server-only message waits for the server to deliver it', () => {
    // The sender queued something server-only (a state patch, say) just before broadcast 2: its
    // copies carry b = 2, so none may be used until the server's copy of 2 has arrived, which
    // (the server's stream being in order) means the state patch has too.
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('bo', w(2, 'A', 2), 0, 'lan');
    merge.accept('bo', w(3, 'A', 2), 0, 'lan');
    expect(got).toEqual([1]);
    merge.accept('bo', w(2, 'A', 2), 0, 'ws');
    expect(got).toEqual([1, 2, 3]);
    expect(merge.won).toEqual({ lan: 1, ws: 2 });
  });

  test('a barrier that is already behind the server lets LAN copies straight through', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1), 0, 'ws');
    merge.accept('bo', w(2, 'A', 1), 0, 'lan');
    expect(got).toEqual([1, 2]);
  });

  test('a host-only event the server dropped is never delivered from its LAN copy (review 2)', () => {
    // A timer effect from a host that was just replaced: b = n, so only its own server copy counts.
    const { got, merge } = setup();
    merge.accept('bo', w(9), 0, 'ws');
    merge.accept('bo', w(10, 'A', 10), 0, 'lan');
    merge.accept('bo', w(11, 'A', 10), 0, 'lan');
    merge.accept('bo', w(11, 'A', 10), 0, 'ws'); // the server dropped 10 and relayed 11
    expect(got).toEqual([9, 11]);
  });

  test('a LAN copy that claims to be a host-only event is ignored (the sender never sends one)', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(9), 0, 'ws');
    merge.accept('bo', w(10, 'A', 10), 0, 'lan');
    expect(got).toEqual([9]);
  });

  test('a host-only event whose server copy arrives is delivered from it', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(9), 0, 'ws');
    merge.accept('bo', w(10, 'A', 10), 0, 'lan');
    merge.accept('bo', w(10, 'A', 10), 0, 'ws');
    expect(got).toEqual([9, 10]);
  });
});

/** Default deps for a Lan in a two-player room; override what a test needs. */
function deps(over: Partial<LanDeps> = {}): LanDeps {
  return { me: 'a', enabled: false, signal: () => {}, now: () => 0, hostId: () => 'a', players: () => ['a', 'b'], deliver: () => {}, ...over };
}

describe('LAN shortcut: the sender marks barriers', () => {
  test('broadcasts after a server-only message carry its barrier until the next one', () => {
    const l = new Lan(deps());
    expect(l.wrap(1, false).b).toBeUndefined();
    l.barrier();
    expect(l.wrap(2, false).b).toBe(2);
    expect(l.wrap(3, false).b).toBe(2);
    l.barrier();
    l.barrier();
    expect(l.wrap(4, false).b).toBe(4);
  });

  test('a host-only event waits for its own server copy; host writes that the next one supersedes still race', () => {
    const l = new Lan(deps());
    expect(l.wrap({ any: 1 }, true, true).b).toBeUndefined();
    const ev = l.wrap({ any: 2 }, true);
    expect(ev.b).toBe(ev.n);
  });
});

/** A stand-in RTCPeerConnection: records what happened; `createOffer` can be held open. */
class FakePeer {
  closed = false;
  localDescription: { sdp: string } | null = null;
  remoteDescription: { sdp: string } | null = null;
  onicecandidate: unknown = null;
  candidates: unknown[] = [];
  rejectCandidates = false;
  hold: { resolve(): void; reject(err: Error): void } | null = null;
  connectionState = 'new';
  onconnectionstatechange: unknown = null;
  options: unknown = null;
  config: unknown = null;
  holdOffers = false;
  /** The description `createOffer` and `createAnswer` give. */
  sdp: string | null = null;
  stats: Map<string, unknown> | null = null;
  /** `restartIce()` calls, and the options of the latest `createOffer`. */
  iceRestarts = 0;
  offerOptions: unknown = undefined;
  restartIce() {
    this.iceRestarts++;
  }
  getConfiguration() {
    return { ...(this.config as object), certificates: ['kept'] };
  }
  setConfiguration(c: unknown) {
    if (this.closed) throw new Error('closed');
    this.config = c;
  }
  async getStats() {
    return this.stats ?? new Map();
  }
  channel = { send: (_t: string) => {}, bufferedAmount: 0, onopen: null as null | (() => void), onclose: null as null | (() => void), onmessage: null };
  createDataChannel(_label: string, options: unknown) {
    this.options = options;
    return this.channel;
  }
  createOffer(options?: unknown) {
    this.offerOptions = options;
    const sdp = this.sdp ?? 'offer';
    if (!this.holdOffers) return Promise.resolve({ type: 'offer', sdp });
    return new Promise((resolve, reject) => {
      this.hold = { resolve: () => resolve({ type: 'offer', sdp }), reject };
    });
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: this.sdp ?? 'answer' });
  }
  async setLocalDescription(d: { sdp: string }) {
    if (this.closed) throw new Error('closed');
    this.localDescription = d;
  }
  async setRemoteDescription(d: { sdp: string }) {
    if (this.closed) throw new Error('closed');
    this.remoteDescription = d;
  }
  async addIceCandidate(c: unknown) {
    if (this.rejectCandidates) throw new Error('bad candidate');
    this.candidates.push(c);
  }
  close() {
    this.closed = true;
  }
}

type Sent = { to: string; k: string; g?: string };

/** A Lan with fake peer connections, recording the signals it sends. */
function signalling(me: string, players: string[], opts: { holdFirst?: boolean; relay?: LanDeps['relay']; timing?: LanDeps['timing'] } = {}) {
  const peers: FakePeer[] = [];
  const sent: Sent[] = [];
  const l = new Lan(
    deps({
      me,
      enabled: true,
      players: () => players,
      signal: (to, d) => sent.push({ to, k: (d as { k: string }).k, g: (d as { g?: string }).g }),
      relay: opts.relay,
      timing: opts.timing,
      createPeer: (config) => {
        const p = new FakePeer();
        p.config = config;
        p.holdOffers = opts.holdFirst === true && peers.length === 0;
        peers.push(p);
        return p as unknown as RTCPeerConnection;
      },
    }),
  );
  return { l, peers, sent };
}

const hi = { $gr: 'lan', k: 'hi' } as const;
const ask = { $gr: 'lan', k: 'ask' } as const;

describe('LAN shortcut: signalling', () => {
  test('a failed setup from before a restart does not close the connection that replaced it', async () => {
    const { l, peers } = signalling('a', ['a', 'b'], { holdFirst: true, timing: { restartMs: 0 } });
    const first = l.signal('b', hi);
    await Bun.sleep(0);
    expect(peers.length).toBe(1); // offering, createOffer held
    await l.signal('b', hi); // b started over: a new offer on a new connection
    expect(peers.length).toBe(2);
    peers[0]!.hold!.reject(new Error('closed'));
    await first;
    expect(peers[1]!.closed).toBe(false);
  });

  test('a hello always starts over, even with a connection already there (review 2)', async () => {
    // b dropped its side (it saw us leave and come back) and says hello again.
    const { l, peers, sent } = signalling('a', ['a', 'b'], { timing: { restartMs: 0 } });
    await l.signal('b', hi);
    peers[0]!.channel.onopen?.();
    expect(l.peers()).toEqual(['b']);
    await l.signal('b', hi);
    expect(peers[0]!.closed).toBe(true);
    expect(peers.length).toBe(2);
    expect(sent.filter((s) => s.k === 'offer').length).toBe(2);
  });

  describe('a peer makes us start over at most once per RESTART_MS (security review)', () => {
    const offerMsg = (g: string) => ({ $gr: 'lan', k: 'offer', g, sdp: 'o' }) as const;

    test('hellos, asks and offers that come too soon wait; only the latest runs, once the time is up', async () => {
      const a = signalling('a', ['a', 'b'], { timing: { restartMs: 40 } });
      await a.l.signal('b', hi);
      a.peers[0]!.channel.onopen?.();
      for (let i = 0; i < 20; i++) await a.l.signal('b', hi);
      expect(a.peers).toHaveLength(1);
      expect(a.l.peers()).toEqual(['b']); // the open channel stays meanwhile
      await Bun.sleep(60);
      expect(a.peers).toHaveLength(2);
      expect(a.sent.filter((s) => s.k === 'offer')).toHaveLength(2);

      const b = signalling('b', ['a', 'b'], { timing: { restartMs: 40 } });
      await b.l.signal('a', offerMsg('g1'));
      for (let i = 2; i <= 20; i++) await b.l.signal('a', offerMsg(`g${i}`));
      for (let i = 0; i < 20; i++) await b.l.signal('a', ask);
      expect(b.peers).toHaveLength(1);
      expect(b.sent.filter((s) => s.k === 'answer')).toHaveLength(1);
      await Bun.sleep(60);
      // The latest was an ask: the connection starts over once, with one hello.
      expect(b.peers[0]!.closed).toBe(true);
      expect(b.sent.filter((s) => s.k === 'hi')).toHaveLength(1);
    });

    test('the normal setup never waits: an ask, then its offer, goes straight through', async () => {
      const b = signalling('b', ['a', 'b']);
      await b.l.signal('a', ask);
      await b.l.signal('a', offerMsg('g1'));
      expect(b.peers).toHaveLength(1);
      expect(b.sent.map((s) => s.k)).toEqual(['hi', 'answer']);
    });

    test('a newer offer that comes too soon (the other side started over again) still gets its answer', async () => {
      const b = signalling('b', ['a', 'b'], { timing: { restartMs: 40 } });
      await b.l.signal('a', offerMsg('g1'));
      await b.l.signal('a', offerMsg('g2'));
      expect(b.sent.filter((s) => s.k === 'answer').map((s) => s.g)).toEqual(['g1']);
      await Bun.sleep(60);
      expect(b.sent.filter((s) => s.k === 'answer').map((s) => s.g)).toEqual(['g1', 'g2']);
    });

    test('a peer that leaves while its request waits: nothing runs', async () => {
      const players = ['a', 'b'];
      const a = signalling('a', players, { timing: { restartMs: 40 } });
      await a.l.signal('b', hi);
      await a.l.signal('b', hi);
      players.splice(1, 1);
      a.l.remove('b');
      await Bun.sleep(60);
      expect(a.peers).toHaveLength(1);
    });
  });

  test('the answerer answers an ask with a hello, starting over', async () => {
    const { l, peers, sent } = signalling('b', ['a', 'b'], { timing: { restartMs: 0 } });
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    expect(peers.length).toBe(1);
    await l.signal('a', ask);
    expect(peers[0]!.closed).toBe(true);
    expect(sent.at(-1)).toEqual({ to: 'a', k: 'hi', g: undefined });
  });

  test('a channel that closes is set up again, after a pause (the answerer says hello) (review 2, 3)', async () => {
    const { l, peers, sent } = signalling('b', ['a', 'b']);
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    peers[0]!.channel.onopen?.();
    sent.length = 0;
    peers[0]!.channel.onclose?.();
    expect(l.peers()).toEqual([]);
    expect(sent).toEqual([]); // not straight away: a peer that left closes its channel before the server says so
    await Bun.sleep(RETRY_MS + 20);
    expect(sent).toEqual([{ to: 'a', k: 'hi', g: undefined }]);
  });

  test('no retry to a peer that has left by then (review 3)', async () => {
    const players = ['a', 'b'];
    const { l, peers, sent } = signalling('b', players);
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    peers[0]!.channel.onopen?.();
    sent.length = 0;
    peers[0]!.channel.onclose?.();
    players.splice(0, 1); // a's player_left arrives
    l.remove('a');
    await Bun.sleep(RETRY_MS + 20);
    expect(sent).toEqual([]);
  });

  test('a failed connection is torn down and set up again like a closed channel (review 3)', async () => {
    const { l, peers, sent } = signalling('b', ['a', 'b']);
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    peers[0]!.channel.onopen?.();
    sent.length = 0;
    peers[0]!.connectionState = 'failed';
    (peers[0]!.onconnectionstatechange as () => void)();
    expect(peers[0]!.closed).toBe(true);
    await Bun.sleep(RETRY_MS + 20);
    expect(sent).toEqual([{ to: 'a', k: 'hi', g: undefined }]);
  });

  test('only candidates for this network are sent or used: mDNS names and private addresses (review 3)', async () => {
    const { l, peers, sent } = signalling('b', ['a', 'b']);
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    const cand = (addr: string, typ = 'host') => ({ candidate: `candidate:1 1 udp 2122260223 ${addr} 54321 typ ${typ} generation 0` });
    for (const addr of ['0f3e-x.local', '192.168.1.5', '10.0.0.7', '172.20.1.1', 'fe80::1', 'fd00::5', '203.0.113.9', '2001:db8::1', '172.40.1.1']) {
      await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand(addr) });
    }
    await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand('192.168.1.9', 'srflx') });
    expect(peers[0]!.candidates.map((c) => (c as { candidate: string }).candidate.split(' ')[4])).toEqual([
      '0f3e-x.local', '192.168.1.5', '10.0.0.7', '172.20.1.1', 'fe80::1', 'fd00::5',
    ]);
    sent.length = 0;
    const emit = (addr: string) => (peers[0]!.onicecandidate as (ev: unknown) => void)({ candidate: { toJSON: () => cand(addr) } });
    emit('203.0.113.9');
    emit('192.168.1.5');
    (peers[0]!.onicecandidate as (ev: unknown) => void)({ candidate: null }); // gathering done: the batch goes
    expect(sent.map((s) => s.k)).toEqual(['ice']);
  });

  test('ICE candidates that come before the offer are kept for it (review 2)', async () => {
    const { l, peers } = signalling('b', ['a', 'b']);
    const c1 = { candidate: 'candidate:1 1 udp 1 a1.local 5000 typ host' };
    const old = { candidate: 'candidate:1 1 udp 1 a0.local 5000 typ host' };
    await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: c1 });
    await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g0', c: old });
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    expect(peers[0]!.candidates).toEqual([c1]);
  });

  test('a candidate the browser rejects is skipped; the connection stays (review 2)', async () => {
    const { l, peers } = signalling('b', ['a', 'b']);
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    peers[0]!.channel.onopen?.();
    peers[0]!.rejectCandidates = true;
    await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: { candidate: 'candidate:1 1 udp 1 bad.local 5000 typ host' } });
    expect(peers[0]!.closed).toBe(false);
    expect(l.peers()).toEqual(['a']);
  });

  test('an answer for an older offer is ignored', async () => {
    const { l, peers, sent } = signalling('a', ['a', 'b']);
    await l.signal('b', hi);
    const g = sent.find((s) => s.k === 'offer')!.g!;
    await l.signal('b', { $gr: 'lan', k: 'answer', g: 'stale', sdp: 'x' });
    expect(peers[0]!.remoteDescription).toBeNull();
    await l.signal('b', { $gr: 'lan', k: 'answer', g, sdp: 'x' });
    expect(peers[0]!.remoteDescription).toEqual({ type: 'answer', sdp: 'x' } as never);
  });

  test('signals from someone not in the room are ignored', async () => {
    const { l, peers, sent } = signalling('a', ['a', 'b']);
    await l.signal('z', hi);
    expect(peers.length).toBe(0);
    expect(sent).toEqual([]);
  });

  test('a room over the mesh limit never sets up peers, however the hello arrives', async () => {
    const { l, peers, sent } = signalling('a', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    l.add('b');
    await l.signal('b', hi);
    expect(peers.length).toBe(0);
    expect(sent).toEqual([]);
  });

  test('without WebRTC (Bun, Node) a hello is ignored rather than failing', async () => {
    const sent: unknown[] = [];
    const l = new Lan(deps({ enabled: true, signal: (_to, d) => sent.push(d) }));
    await l.signal('b', hi);
    expect(sent).toEqual([]);
  });

  test('joining: the offerer asks, the answerer says hello', () => {
    const a = signalling('a', ['a', 'b']);
    a.l.add('b');
    expect(a.sent).toEqual([{ to: 'b', k: 'ask', g: undefined }]);
    const b = signalling('b', ['a', 'b']);
    b.l.add('a');
    expect(b.sent).toEqual([{ to: 'a', k: 'hi', g: undefined }]);
  });

  test('only the newcomer starts: players already there just note it, so each pair negotiates once (review 3)', () => {
    const a = signalling('a', ['a', 'b']);
    a.l.add('b', false);
    expect(a.sent).toEqual([]);
  });
});

let lastChannel: FakePeer['channel'] | null = null;

describe('LAN shortcut: the server’s limits hold on the LAN too', () => {
  /** A Lan with one open channel to b, recording what it sends over it; `clock` is its steady clock. */
  async function openLan(clock: { t: number }, now = () => 0) {
    const sent: string[] = [];
    const l = new Lan(
      deps({
        enabled: true,
        now,
        clock: () => clock.t,
        createPeer: () => {
          const p = new FakePeer();
          p.channel.send = (t: string) => sent.push(t);
          lastChannel = p.channel;
          queueMicrotask(() => p.channel.onopen?.());
          return p as unknown as RTCPeerConnection;
        },
      }),
    );
    await l.signal('b', hi);
    await Bun.sleep(0);
    expect(l.peers()).toEqual(['b']);
    return { l, sent };
  }

  test('a host-only event is not sent over the LAN at all (only its server copy can deliver it)', async () => {
    const { l, sent } = await openLan({ t: 0 });
    l.wrap('goal', true);
    expect(sent.length).toBe(0);
    l.wrap('entity update', true, true);
    expect(sent.length).toBe(1);
    l.close();
  });

  test('no LAN copies while our own server connection is down or resuming (review 3)', async () => {
    let ready = false;
    const sent: string[] = [];
    const l = new Lan(
      deps({
        enabled: true,
        serverReady: () => ready,
        createPeer: () => {
          const p = new FakePeer();
          p.channel.send = (t: string) => sent.push(t);
          queueMicrotask(() => p.channel.onopen?.());
          return p as unknown as RTCPeerConnection;
        },
      }),
    );
    await l.signal('b', hi);
    await Bun.sleep(0);
    l.wrap('while down', false);
    expect(sent.length).toBe(0);
    ready = true;
    l.wrap('back', false);
    expect(sent.length).toBe(1);
    l.close();
  });

  test('the channel is unreliable and unordered: a lost copy never holds up the ones after it (review 3)', async () => {
    const { l, peers } = signalling('a', ['a', 'b']);
    await l.signal('b', hi);
    expect(peers[0]!.options).toEqual({ negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
  });

  test('a backed-up channel gets no more copies (review 3)', async () => {
    const { l, sent } = await openLan({ t: 0 });
    l.wrap(1, false);
    lastChannel!.bufferedAmount = 1 << 20;
    l.wrap(2, false);
    expect(sent.length).toBe(1);
    l.close();
  });

  test('a broadcast too big for the server is not sent over the LAN either', async () => {
    const { l, sent } = await openLan({ t: 0 });
    l.wrap('x'.repeat(16 * 1024), false);
    l.wrap('small', false);
    expect(sent.length).toBe(1);
    l.close();
  });

  test(`a copy over ${MAX_LAN_COPY_BYTES} bytes goes by the server only: a lossy channel mostly loses big ones (reliability review)`, async () => {
    const { l, sent } = await openLan({ t: 0 });
    l.wrap('x'.repeat(3000), false); // ~3 packets: well under the server's 16 KB, still server-only
    l.wrap('é'.repeat(1100), false); // over in UTF-8 bytes, not in characters
    l.wrap('x'.repeat(MAX_LAN_COPY_BYTES - 64), false);
    expect(sent.map((t) => (JSON.parse(t).d as string).length)).toEqual([MAX_LAN_COPY_BYTES - 64]);
    expect(sent.every((t) => t.length <= MAX_LAN_COPY_BYTES)).toBe(true);
    l.close();
  });

  test('the next small copy after a server-only big one waits for the big one’s server copy, not forever (reliability review)', () => {
    // The receiver's side of the size cap: n=2 never comes over the LAN, so n=3's LAN copy waits for
    // 2's server copy (in order), and is discarded after STALE_MS if that never comes.
    const got: Json[] = [];
    const merge = new Merge((_from, d) => got.push(d));
    merge.accept('a', w(1), 0, 'ws', 0);
    merge.accept('a', w(3), 0, 'lan', 0);
    expect(got).toEqual([1]);
    merge.accept('a', w(2), 0, 'ws', 5);
    expect(got).toEqual([1, 2, 3]);
    const late = setup();
    late.merge.accept('a', w(1), 0, 'ws', 0);
    late.merge.accept('a', w(3), 0, 'lan', 0);
    late.merge.tick(STALE_MS);
    late.merge.accept('a', w(2), 0, 'ws', STALE_MS);
    late.merge.accept('a', w(3), 0, 'ws', STALE_MS);
    expect(late.got).toEqual([1, 2, 3]);
  });

  test('after the server rate-limits us, LAN copies pause for a second, on a steady clock (review 2)', async () => {
    const clock = { t: 0 };
    let serverClock = 0;
    const { l, sent } = await openLan(clock, () => serverClock);
    l.pause();
    serverClock = 5000; // a clock correction: the pause must not end early
    l.wrap(1, false);
    clock.t = 999;
    l.wrap(2, false);
    clock.t = 1000;
    l.wrap(3, false);
    expect(sent.map((t) => JSON.parse(t).d)).toEqual([3]);
    l.close();
  });
});

describe('LAN shortcut: channel lifecycle', () => {
  /** An answerer ('b') with one connection to 'a', fast timers, and what it delivered. */
  async function answerer(opts: { hostId?: string; players?: string[]; clock?: () => number } = {}) {
    const peers: FakePeer[] = [];
    const sent: Sent[] = [];
    const got: Json[] = [];
    const players = opts.players ?? ['a', 'b'];
    const l = new Lan(
      deps({
        me: 'b',
        enabled: true,
        players: () => players,
        hostId: () => opts.hostId ?? 'a',
        clock: opts.clock,
        timing: { connectMs: 30, retryMs: 10, stableMs: 20 },
        signal: (to, d) => sent.push({ to, k: (d as { k: string }).k, g: (d as { g?: string }).g }),
        deliver: (_from, d) => got.push(d),
        createPeer: () => {
          const p = new FakePeer();
          peers.push(p);
          return p as unknown as RTCPeerConnection;
        },
      }),
    );
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    return { l, peers, sent, got, players };
  }
  const receive = (p: FakePeer, data: unknown) => (p.channel.onmessage as unknown as (ev: { data: unknown }) => void)({ data });

  test('a copy that arrives over the channel is delivered', async () => {
    const { l, peers, got } = await answerer();
    peers[0]!.channel.onopen?.();
    l.receiveServer('a', { $gr: 'l', e: 's', n: 1, d: 'first' }, 0); // (only the server starts a session)
    receive(peers[0]!, JSON.stringify({ $gr: 'l', e: 's', n: 2, d: 'hello' }));
    expect(got).toEqual(['first', 'hello']);
  });

  test('garbage or anything but a wrapped broadcast is ignored', async () => {
    const { peers, got } = await answerer();
    peers[0]!.channel.onopen?.();
    receive(peers[0]!, '{not json');
    receive(peers[0]!, JSON.stringify({ $gr: 'lan', k: 'hi' }));
    receive(peers[0]!, JSON.stringify({ hello: 1 }));
    expect(got).toEqual([]);
  });

  test('a copy over the server’s size limit is dropped, as the server would drop it (security review)', async () => {
    const { l, peers, got } = await answerer();
    peers[0]!.channel.onopen?.();
    l.receiveServer('a', { $gr: 'l', e: 's', n: 1, d: 'first' }, 0);
    receive(peers[0]!, JSON.stringify({ $gr: 'l', e: 's', n: 2, d: 'x'.repeat(LIMITS.maxMessageBytes) }));
    receive(peers[0]!, JSON.stringify({ $gr: 'l', e: 's', n: 2, d: 'é'.repeat(LIMITS.maxMessageBytes / 2) })); // over in UTF-8 bytes
    receive(peers[0]!, new ArrayBuffer(8));
    receive(peers[0]!, JSON.stringify({ $gr: 'l', e: 's', n: 2, d: 'x'.repeat(LIMITS.maxMessageBytes - 256) }));
    expect(got).toEqual(['first', 'x'.repeat(LIMITS.maxMessageBytes - 256)]);
  });

  test('a peer gets the server’s rate over the LAN: a burst of 240, then 120 a second (security review)', async () => {
    const clock = { t: 0 };
    const { l, peers, got } = await answerer({ clock: () => clock.t });
    peers[0]!.channel.onopen?.();
    l.receiveServer('a', { $gr: 'l', e: 's', n: 1, d: 1 }, 0); // the stream, as the server started it
    const copy = (n: number) => JSON.stringify({ $gr: 'l', e: 's', n, d: n });
    for (let n = 2; n < 2 + LIMITS.rateBurst + 50; n++) receive(peers[0]!, copy(n));
    expect(got).toHaveLength(1 + LIMITS.rateBurst);
    // Half a second later, half a second's worth (the dropped ones' numbers again: no gap to wait on).
    clock.t = 500;
    for (let n = 2 + LIMITS.rateBurst; n < 2 + LIMITS.rateBurst + 100; n++) receive(peers[0]!, copy(n));
    expect(got).toHaveLength(1 + LIMITS.rateBurst + LIMITS.ratePerSecond / 2);
  });

  test('a host-only copy from someone who isn’t the host (as far as we know) is dropped', async () => {
    const { l, peers, got } = await answerer({ hostId: 'z' });
    peers[0]!.channel.onopen?.();
    l.receiveServer('a', { $gr: 'l', e: 's', n: 1, d: 'first' }, 0);
    receive(peers[0]!, JSON.stringify({ $gr: 'l', e: 's', n: 2, d: 'plain' }));
    receive(peers[0]!, JSON.stringify({ $gr: 'l', e: 's', n: 3, h: 1, d: 'stale host' }));
    expect(got).toEqual(['first', 'plain']);
  });

  test('a connection that never opens is given up after the connect timeout, with no retry', async () => {
    const { peers, sent } = await answerer();
    sent.length = 0;
    await Bun.sleep(60);
    expect(peers[0]!.closed).toBe(true);
    expect(sent).toEqual([]);
  });

  test('a channel that closes before it ever opened is not retried', async () => {
    const { peers, sent } = await answerer();
    sent.length = 0;
    peers[0]!.channel.onclose?.();
    await Bun.sleep(30);
    expect(sent).toEqual([]);
  });

  describe('with relays, a connection that never opened is tried again, later each time (reliability review)', () => {
    const sf = { urls: ['turn:192.241.216.26:3478'], username: 'u', credential: 'x' };
    /** An answerer ('b') with a relay; its connections time out after 30 ms. */
    async function withRelay(me = 'b') {
      const peers: FakePeer[] = [];
      const sent: Sent[] = [];
      const l = new Lan(
        deps({
          me,
          enabled: true,
          relay: {},
          timing: { connectMs: 30, retryMs: 10, missMs: [20, 60] },
          signal: (to, d) => sent.push({ to, k: (d as { k: string }).k, g: (d as { g?: string }).g }),
          createPeer: () => {
            const p = new FakePeer();
            peers.push(p);
            return p as unknown as RTCPeerConnection;
          },
        }),
      );
      await l.setRelays([sf]);
      sent.length = 0;
      return { l, peers, sent };
    }
    const offerMsg = (g: string) => ({ $gr: 'lan', k: 'offer', g, sdp: 'o' }) as const;
    const his = (sent: Sent[]) => sent.filter((s) => s.k === 'hi').length;

    test('a timeout: hello again after each pause in turn, then no more', async () => {
      const { l, peers, sent } = await withRelay();
      await l.signal('a', offerMsg('g1'));
      await Bun.sleep(40); // timed out
      expect(peers[0]!.closed).toBe(true);
      expect(his(sent)).toBe(0);
      await Bun.sleep(25); // the first pause
      expect(his(sent)).toBe(1);
      await l.signal('a', offerMsg('g2'));
      await Bun.sleep(30 + 40); // timed out, and not yet the second pause
      expect(his(sent)).toBe(1);
      await Bun.sleep(40);
      expect(his(sent)).toBe(2);
      await l.signal('a', offerMsg('g3'));
      await Bun.sleep(30 + 100); // a third miss: given up
      expect(his(sent)).toBe(2);
    });

    test('failing or closing before it opened counts as a miss too; one that opens starts the count over', async () => {
      const { l, peers, sent } = await withRelay();
      await l.signal('a', offerMsg('g1'));
      peers[0]!.connectionState = 'failed';
      (peers[0]!.onconnectionstatechange as () => void)();
      await Bun.sleep(25);
      expect(his(sent)).toBe(1);
      await l.signal('a', offerMsg('g2'));
      peers[1]!.channel.onopen!(); // it worked this time
      peers[1]!.channel.onclose!(); // (a drop after opening: the usual retry, after retryMs)
      await Bun.sleep(15);
      expect(his(sent)).toBe(2);
      await l.signal('a', offerMsg('g3'));
      peers[2]!.channel.onclose!(); // never opened: the first pause again, not the second
      await Bun.sleep(25);
      expect(his(sent)).toBe(3);
    });

    test('the offerer waits for the answerer’s hello; no retry to a peer that left', async () => {
      const a = await withRelay('a');
      await a.l.signal('b', hi);
      await Bun.sleep(40 + 60);
      expect(a.sent.filter((s) => s.k !== 'offer')).toEqual([]);
      const b = await withRelay();
      await b.l.signal('a', offerMsg('g1'));
      await Bun.sleep(40);
      b.l.remove('a'); // its player_left, during the pause
      await Bun.sleep(30);
      expect(his(b.sent)).toBe(0);
    });
  });

  test('a connection that keeps dropping is retried 3 times, then left alone (found while testing)', async () => {
    const { l, peers, sent } = await answerer();
    sent.length = 0;
    for (let i = 0; i < 4; i++) {
      const p = peers.at(-1)!;
      p.channel.onopen?.();
      p.channel.onclose?.(); // drops straight away: not a stable connection
      await Bun.sleep(20);
      await l.signal('a', { $gr: 'lan', k: 'offer', g: `g${i + 2}`, sdp: 'o' });
    }
    expect(sent.filter((s) => s.k === 'hi').length).toBe(3);
  });

  test('a connection that stayed up a while starts the retry count over', async () => {
    const { l, peers, sent } = await answerer();
    sent.length = 0;
    for (let i = 0; i < 4; i++) {
      const p = peers.at(-1)!;
      p.channel.onopen?.();
      await Bun.sleep(25); // longer than stableMs
      p.channel.onclose?.();
      await Bun.sleep(20);
      await l.signal('a', { $gr: 'lan', k: 'offer', g: `g${i + 2}`, sdp: 'o' });
    }
    expect(sent.filter((s) => s.k === 'hi').length).toBe(4);
  });

  test('close tears every connection down and ignores signals after it', async () => {
    const { l, peers, sent } = await answerer();
    peers[0]!.channel.onopen?.();
    expect(l.stats().peers).toBe(1);
    l.close();
    expect(peers[0]!.closed).toBe(true);
    expect(l.stats().peers).toBe(0);
    sent.length = 0;
    await l.signal('a', { $gr: 'lan', k: 'ask' });
    expect(sent).toEqual([]);
  });
});

describe('LAN shortcut: after a reconnect', () => {
  test('our reconnect starts again with every player we have no open channel to (review 4)', async () => {
    const { l, peers, sent } = signalling('b', ['a', 'b', 'c']);
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' }); // a: we answer
    peers[0]!.channel.onopen?.();
    l.add('c', false); // c: noted, never connected
    sent.length = 0;
    l.reconnect();
    // a's channel is still open: left alone. For c we're the offerer ('b' < 'c'), so we ask.
    expect(sent).toEqual([{ to: 'c', k: 'ask', g: undefined }]);
  });

  test('as the offerer, a reconnect asks for a hello', () => {
    const { l, sent } = signalling('a', ['a', 'b']);
    l.add('b', false);
    l.reconnect();
    expect(sent).toEqual([{ to: 'b', k: 'ask', g: undefined }]);
  });
});

describe('LAN shortcut: the server’s rate limit, before it drops anything', () => {
  test('no LAN copy for a broadcast the relay’s send budget says the server would drop (review 5)', async () => {
    const sent: string[] = [];
    let within = true;
    const l = new Lan(
      deps({
        enabled: true,
        withinRate: () => within,
        createPeer: () => {
          const p = new FakePeer();
          p.channel.send = (t: string) => sent.push(t);
          queueMicrotask(() => p.channel.onopen?.());
          return p as unknown as RTCPeerConnection;
        },
      }),
    );
    await l.signal('b', hi);
    await Bun.sleep(0);
    l.wrap(1, false);
    within = false;
    const skipped = l.wrap(2, false);
    within = true;
    l.wrap(3, false);
    expect(sent.map((t) => (JSON.parse(t) as Wrapped).d)).toEqual([1, 3]);
    expect(skipped.n).toBe(2); // still numbered: its server copy (if the server takes it) keeps the stream whole
    l.close();
  });
});

describe('LAN shortcut: more edges (review 4)', () => {
  test('a late copy from a sender’s old session is not delivered twice after its new one started', () => {
    const { got, merge } = setup();
    merge.accept('bo', w(1, 'A'), 0, 'ws');
    merge.accept('bo', w(2, 'A'), 0, 'ws');
    merge.accept('bo', w(1, 'B'), 0, 'ws'); // bo reloaded
    merge.accept('bo', w(1, 'A'), 0, 'lan'); // a straggler from the old tab
    merge.accept('bo', w(2, 'B'), 0, 'ws');
    expect(got).toEqual([1, 2, 1, 2]);
  });

  test('address filter edges', async () => {
    const { onThisNetwork } = await import('../src/sync/lan');
    const c = (addr: string, typ = 'host') => ({ candidate: `candidate:1 1 udp 1 ${addr} 5000 typ ${typ}` });
    for (const ok of ['172.16.0.1', '172.31.255.1', 'abc.local']) expect(onThisNetwork(c(ok)), ok).toBe(true);
    for (const no of ['172.15.0.1', '172.32.0.1', '169.254.1.1', '100.64.0.1', '127.0.0.1', '8.8.8.8']) expect(onThisNetwork(c(no)), no).toBe(false);
    expect(onThisNetwork(c('abc.local', 'srflx'))).toBe(false);
    expect(onThisNetwork({ candidate: '' })).toBe(false); // end-of-candidates
    expect(onThisNetwork({})).toBe(false);
  });

  test('a setup step that fails on the current connection tears it down', async () => {
    const failing = new FakePeer();
    failing.setRemoteDescription = async () => {
      throw new Error('bad sdp');
    };
    const l = new Lan(deps({ me: 'b', enabled: true, createPeer: () => failing as unknown as RTCPeerConnection }));
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    expect(failing.closed).toBe(true);
  });

  test('candidates before their offer are capped', async () => {
    const { l, peers } = signalling('b', ['a', 'b']);
    for (let i = 0; i < 50; i++) await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: { candidate: `candidate:1 1 udp 1 n${i}.local 5000 typ host` } });
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    expect(peers[0]!.candidates.length).toBe(32);
  });

  test('events from a replaced connection are ignored; opening twice counts once', async () => {
    const got: Json[] = [];
    const peers: FakePeer[] = [];
    const l = new Lan(
      deps({
        me: 'b', enabled: true, deliver: (_f, d) => got.push(d),
        timing: { restartMs: 0 }, // (the restart cooldown is tested on its own)
        createPeer: () => {
          const p = new FakePeer();
          peers.push(p);
          return p as unknown as RTCPeerConnection;
        },
      }),
    );
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    const old = peers[0]!;
    old.channel.onopen?.();
    old.channel.onopen?.();
    expect(l.stats().peers).toBe(1);
    l.receiveServer('a', { $gr: 'l', e: 's', n: 1, d: 'first' }, 0);
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g2', sdp: 'o' }); // replaced
    (old.channel.onmessage as unknown as (ev: { data: string }) => void)({ data: JSON.stringify({ $gr: 'l', e: 's', n: 2, d: 'old' }) });
    old.channel.onopen?.();
    expect(got).toEqual(['first']);
    expect(l.stats().peers).toBe(0);
  });

  test('a failure reported after the channel closed doesn’t retry twice', async () => {
    const { l, peers, sent } = signalling('b', ['a', 'b']);
    await l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o' });
    peers[0]!.channel.onopen?.();
    sent.length = 0;
    peers[0]!.channel.onclose?.();
    peers[0]!.connectionState = 'failed';
    (peers[0]!.onconnectionstatechange as () => void)();
    await Bun.sleep(RETRY_MS + 20);
    expect(sent.filter((s) => s.k === 'hi').length).toBe(1);
  });

  test('a channel that throws on send doesn’t break the broadcast', async () => {
    const peers: FakePeer[] = [];
    const l = new Lan(
      deps({
        enabled: true,
        createPeer: () => {
          const p = new FakePeer();
          p.channel.send = () => {
            throw new Error('closing');
          };
          queueMicrotask(() => p.channel.onopen?.());
          peers.push(p);
          return p as unknown as RTCPeerConnection;
        },
      }),
    );
    await l.signal('b', hi);
    await Bun.sleep(0);
    expect(() => l.wrap('x', false)).not.toThrow();
    l.close();
  });
});

describe('LAN shortcut: state numbers instead of a barrier (review 6)', () => {
  const ws = (n: number, s?: number): Wrapped => ({ $gr: 'l', e: 'A', n, ...(s ? { s } : {}), d: n });

  test('a received state patch is not a barrier: the next broadcast races, carrying the state number', () => {
    const l = new Lan(deps());
    l.wrap(1, false);
    l.stateAt(7);
    const w = l.wrap(2, false);
    expect(w.b).toBeUndefined();
    expect(w.s).toBe(7);
    expect(l.wrap(3, false).s).toBe(7);
  });

  test('a LAN copy waits until this player has that state; the server copy never waits', () => {
    let seq = 3;
    const got: Json[] = [];
    const merge = new Merge((_f, d) => got.push(d), (s) => s <= seq);
    merge.accept('bo', ws(1), 0, 'ws');
    merge.accept('bo', ws(2, 4), 0, 'lan'); // bo saw state 4; we're at 3
    expect(got).toEqual([1]);
    seq = 4;
    merge.pump();
    expect(got).toEqual([1, 2]);
    merge.accept('bo', ws(3, 9), 0, 'ws'); // the server's copy: in order behind state 9 anyway
    expect(got).toEqual([1, 2, 3]);
  });

  test('a LAN copy waiting on state is discarded after STALE_MS, and its server copy delivers it', () => {
    const got: Json[] = [];
    const merge = new Merge((_f, d) => got.push(d), () => false);
    merge.accept('bo', ws(1), 0, 'ws');
    merge.accept('bo', ws(2, 5), 0, 'lan', 0);
    merge.tick(STALE_MS);
    expect(got).toEqual([1]);
    merge.accept('bo', ws(2, 5), 0, 'ws');
    expect(got).toEqual([1, 2]);
  });

  test('the host has every state there is: its check always passes', () => {
    const l = new Lan(deps({ me: 'a', hostId: () => 'a' }));
    const got: Json[] = [];
    const m = new Lan(deps({ me: 'a', hostId: () => 'b', deliver: (_f, d) => got.push(d) }));
    expect(l.stateSeen(99)).toBe(true);
    m.stateAt(3);
    expect(m.stateSeen(3)).toBe(true);
    expect(m.stateSeen(4)).toBe(false);
  });
});

describe('LAN shortcut: the LAN first, a relay otherwise, in one connection', () => {
  const sf = { urls: ['turn:192.241.216.26:3478'], username: '1790000000:i:g:p_b', credential: 'x' };
  const ny = { urls: ['turn:203.0.113.7:3478'], username: '1790000000:i:g:p_b', credential: 'x' };
  const cand = (addr: string, typ: string) => ({ candidate: `candidate:1 1 udp 2122260223 ${addr} 54321 typ ${typ} generation 0` });
  const offer = (relay?: string) => ({ $gr: 'lan', k: 'offer', g: 'g1', sdp: 'o', ...(relay ? { relay } : {}) }) as const;
  type Signal = { to: string; d: { k: string; r?: Record<string, number>; relay?: string; c?: { candidate: string }; cs?: { candidate: string }[]; sdp?: string } };
  /** One of `p`'s candidates, then the end of gathering (so the batch goes). */
  const emitOn = (p: FakePeer, addr: string) => {
    (p.onicecandidate as (ev: unknown) => void)({ candidate: { toJSON: () => cand(addr, 'host') } });
    (p.onicecandidate as (ev: unknown) => void)({ candidate: null });
  };
  /** The candidates we sent, batches unpacked. */
  const out = (sent: Signal[]) => sent.filter((x) => x.d.k === 'ice').flatMap((x) => [x.d.c!, ...(x.d.cs ?? [])]);
  const outAddrs = (sent: Signal[]) => out(sent).map((c) => c.candidate.split(' ')[4]);

  function withRelays(me: string, relay: NonNullable<LanDeps['relay']> = {}, direct?: LanDeps['direct'], sdp?: string, timing?: LanDeps['timing']) {
    const peers: FakePeer[] = [];
    const sent: Signal[] = [];
    const l = new Lan(
      deps({
        me,
        enabled: true,
        players: () => ['a', 'b'],
        signal: (to, d) => sent.push({ to, d: d as Signal['d'] }),
        relay,
        direct,
        timing,
        createPeer: (config) => {
          const p = new FakePeer();
          p.config = config;
          p.sdp = sdp ?? null;
          peers.push(p);
          return p as unknown as RTCPeerConnection;
        },
      }),
    );
    const emit = (addr: string, typ: string) => (peers.at(-1)!.onicecandidate as (ev: unknown) => void)({ candidate: { toJSON: () => cand(addr, typ) } });
    /** The end of gathering: what's batched goes out. */
    const end = () => (peers.at(-1)!.onicecandidate as (ev: unknown) => void)({ candidate: null });
    return { l, peers, sent, emit, end };
  }

  test('one connection gets the LAN and the relay: ICE takes the direct route when there is one', async () => {
    const { l, peers } = withRelays('b');
    await l.setRelays([sf]);
    await l.signal('a', offer());
    expect(peers[0]!.config).toEqual({ iceServers: [sf], iceTransportPolicy: 'all' });
  });

  test('local and relay candidates are sent and used; a public address never is', async () => {
    const { l, peers, sent, emit, end } = withRelays('b');
    await l.setRelays([sf]);
    await l.signal('a', offer());
    for (const [addr, typ] of [['192.168.1.5', 'host'], ['0f3e-x.local', 'host'], ['203.0.113.9', 'srflx'], ['73.71.58.49', 'host'], ['192.241.216.26', 'relay']]) {
      await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand(addr!, typ!) });
    }
    expect(peers[0]!.candidates.map((c) => (c as { candidate: string }).candidate.split(' ')[4])).toEqual(['192.168.1.5', '0f3e-x.local', '192.241.216.26']);
    sent.length = 0;
    emit('192.168.1.5', 'host');
    emit('203.0.113.9', 'srflx');
    emit('73.71.58.49', 'host');
    emit('192.241.216.26', 'relay');
    end();
    expect(outAddrs(sent)).toEqual(['192.168.1.5', '192.241.216.26']);
  });

  test('a peer’s relay candidate is used only with one of our relays’ addresses (security review)', async () => {
    // A player's own address typed `relay` would have us send checks to it from ours.
    const { l, peers } = withRelays('b');
    await l.setRelays([sf]);
    await l.signal('a', offer());
    for (const addr of ['73.71.58.49', '203.0.113.7', '192.241.216.26']) await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand(addr, 'relay') });
    expect(peers[0]!.candidates.map((c) => (c as { candidate: string }).candidate.split(' ')[4])).toEqual(['192.241.216.26']);
  });

  test('with no relays, or a relay named by a hostname, no peer relay candidate is used (security review)', async () => {
    const none = withRelays('b');
    await none.l.setRelays(null);
    await none.l.signal('a', offer());
    await none.l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand('192.241.216.26', 'relay') });
    expect(none.peers[0]!.candidates).toEqual([]);
    const named = withRelays('b');
    await named.l.setRelays([{ urls: ['turn:relay.example.com:3478'], username: 'u', credential: 'x' }]);
    await named.l.signal('a', offer());
    await named.l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand('192.241.216.26', 'relay') });
    expect(named.peers[0]!.candidates).toEqual([]);
  });

  describe('candidates in a description get the same filter (security review)', () => {
    // A description can carry candidates too, which would skip the `ice` check. (A relay candidate
    // with a player's address only comes from a peer: our own browser's are the relay's.)
    const desc = (kind: string) =>
      [
        'v=0',
        'o=- 1 2 IN IP4 127.0.0.1',
        'c=IN IP4 73.71.58.49',
        `a=${cand('192.168.1.5', 'host').candidate}`,
        `a=${cand('73.71.58.49', 'host').candidate}`,
        `a=${cand('203.0.113.9', 'srflx').candidate} raddr 192.168.1.5 rport 51234`,
        ...(kind === 'offer' || kind === 'answer' ? [`a=${cand('73.71.58.49', 'relay').candidate}`] : []),
        'a=candidate:9 1 udp 41885439 192.241.216.26 49170 typ relay raddr 73.71.58.49 rport 51234 generation 0',
        'a=rtcp:9 IN IP4 73.71.58.49',
        'a=end-of-candidates',
        `a=${kind}`,
        '',
      ].join('\r\n');
    const addrs = (sdp: string) => sdp.split('\r\n').filter((x) => x.startsWith('a=candidate:')).map((x) => x.split(' ')[4]);

    test('a peer’s offer or answer: only local candidates and our relays’ are kept', async () => {
      const b = withRelays('b');
      await b.l.setRelays([sf]);
      await b.l.signal('a', { $gr: 'lan', k: 'offer', g: 'g1', sdp: desc('offer') });
      const got = (b.peers[0]!.remoteDescription as unknown as { sdp: string }).sdp;
      expect(addrs(got)).toEqual(['192.168.1.5', '192.241.216.26']);
      expect(got).toContain('a=end-of-candidates\r\na=offer\r\n');

      const a = withRelays('a');
      await a.l.setRelays([sf]);
      await a.l.signal('b', { $gr: 'lan', k: 'hi' });
      const g = a.sent.find((x) => x.d.k === 'offer')!.d as unknown as { g: string };
      await a.l.signal('b', { $gr: 'lan', k: 'answer', g: g.g, sdp: desc('answer') });
      expect(addrs((a.peers[0]!.remoteDescription as unknown as { sdp: string }).sdp)).toEqual(['192.168.1.5', '192.241.216.26']);
    });

    test('ours: only the candidates we’d send, without our own addresses in raddr, c= or a=rtcp', async () => {
      const a = withRelays('a', {}, undefined, desc('ours'));
      await a.l.setRelays([sf]);
      await a.l.signal('b', { $gr: 'lan', k: 'hi' });
      const offerSdp = a.sent.find((x) => x.d.k === 'offer')!.d.sdp!;
      expect(offerSdp).not.toContain('73.71.58.49');
      expect(addrs(offerSdp)).toEqual(['192.168.1.5', '192.241.216.26']);
      expect(offerSdp).toContain('c=IN IP4 0.0.0.0');
      expect(offerSdp).toContain('a=rtcp:9 IN IP4 0.0.0.0');
      expect(offerSdp).toContain('typ relay raddr 0.0.0.0 rport 0');

      const b = withRelays('b', {}, undefined, desc('ours'));
      await b.l.setRelays([sf]);
      await b.l.signal('a', offer());
      const answerSdp = b.sent.find((x) => x.d.k === 'answer')!.d.sdp!;
      expect(answerSdp).not.toContain('73.71.58.49');
      expect(answerSdp).not.toContain('203.0.113.9');
    });

    test('with a party member (direct), public candidates stay, their local addresses blanked', async () => {
      const a = withRelays('a', {}, () => true, desc('ours'));
      await a.l.setRelays([sf]);
      await a.l.signal('b', { $gr: 'lan', k: 'hi' });
      const offerSdp = a.sent.find((x) => x.d.k === 'offer')!.d.sdp!;
      expect(addrs(offerSdp)).toContain('203.0.113.9');
      expect(offerSdp).toContain('typ srflx generation 0 raddr 0.0.0.0 rport 0');
    });
  });

  test('nothing is tried until the server says which relays there are; with none, the LAN only', async () => {
    const { l, peers, sent } = withRelays('b');
    l.add('a');
    await l.signal('a', offer());
    expect(peers).toHaveLength(0);
    expect(sent).toEqual([]);
    await l.setRelays(null);
    expect(sent.map((x) => x.d.k)).toEqual(['hi']);
    await l.signal('a', offer());
    expect(peers[0]!.config).toEqual({ iceServers: [] });
  });

  test('forceRelay (for testing): relay-only, relay candidates only, and nothing at all without relays', async () => {
    const { l, peers, sent, emit, end } = withRelays('b', { only: true });
    await l.setRelays(null);
    await l.signal('a', offer());
    expect(peers).toHaveLength(0);
    await l.setRelays([sf]);
    await l.signal('a', offer());
    expect(peers[0]!.config).toEqual({ iceServers: [sf], iceTransportPolicy: 'relay' });
    await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand('192.168.1.5', 'host') });
    await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand('192.241.216.26', 'relay') });
    expect(peers[0]!.candidates).toHaveLength(1);
    sent.length = 0;
    emit('192.168.1.5', 'host');
    emit('192.241.216.26', 'relay');
    end();
    expect(sent.map((x) => x.d.k)).toEqual(['ice']);
    expect(outAddrs(sent)).toEqual(['192.241.216.26']);
  });

  test('a relay candidate goes out without the player’s own public address (raddr/rport) (review 7)', async () => {
    const { l, peers, sent } = withRelays('b');
    await l.setRelays([sf]);
    await l.signal('a', offer());
    const relayCand = 'candidate:9 1 udp 41885439 192.241.216.26 49170 typ relay raddr 73.71.58.49 rport 51234 generation 0 ufrag x';
    (peers[0]!.onicecandidate as (ev: unknown) => void)({ candidate: { toJSON: () => ({ candidate: relayCand, sdpMid: '0' }) } });
    (peers[0]!.onicecandidate as (ev: unknown) => void)({ candidate: null });
    const c = sent.find((x) => x.d.k === 'ice')!.d.c!;
    expect(c.candidate).not.toContain('73.71.58.49');
    expect(c.candidate).toContain('192.241.216.26 49170 typ relay raddr 0.0.0.0 rport 0');
  });

  describe('candidates go out in batches (reliability review)', () => {
    test('candidates found within ICE_BATCH_MS go out as one signal: the first in `c`, the rest in `cs`', async () => {
      const { l, sent, emit } = withRelays('b');
      await l.setRelays([sf]);
      await l.signal('a', offer());
      sent.length = 0;
      emit('192.168.1.5', 'host');
      emit('0f3e-x.local', 'host');
      emit('203.0.113.9', 'srflx'); // still filtered: never sent
      emit('192.241.216.26', 'relay');
      expect(sent).toEqual([]);
      await Bun.sleep(80);
      expect(sent.map((x) => x.d.k)).toEqual(['ice']);
      expect(sent[0]!.d.c!.candidate).toContain('192.168.1.5');
      expect(outAddrs(sent)).toEqual(['192.168.1.5', '0f3e-x.local', '192.241.216.26']);
      emit('10.0.0.7', 'host'); // a late one starts a batch of its own
      await Bun.sleep(80);
      expect(sent.map((x) => x.d.k)).toEqual(['ice', 'ice']);
      expect(sent[1]!.d.cs).toBeUndefined();
    });

    test('the end of gathering sends what is batched at once; a closed connection’s batch is dropped', async () => {
      const { l, peers, sent, emit, end } = withRelays('b');
      await l.setRelays([sf]);
      await l.signal('a', offer());
      sent.length = 0;
      emit('192.168.1.5', 'host');
      end();
      expect(outAddrs(sent)).toEqual(['192.168.1.5']);
      end(); // nothing batched: nothing sent
      expect(sent).toHaveLength(1);
      emit('10.0.0.7', 'host');
      peers[0]!.channel.onopen!();
      peers[0]!.channel.onclose!(); // torn down before the batch was due
      await Bun.sleep(80);
      expect(outAddrs(sent)).toEqual(['192.168.1.5']);
    });

    test('a batch from a peer: each candidate is checked as a single one would be, early ones kept for their offer', async () => {
      const { l, peers } = withRelays('b');
      await l.setRelays([sf]);
      const batch = { $gr: 'lan', k: 'ice', g: 'g1', c: cand('192.168.1.5', 'host'), cs: [cand('73.71.58.49', 'host'), cand('203.0.113.7', 'relay'), 'junk', null, cand('192.241.216.26', 'relay')] };
      await l.signal('a', batch as never); // before the offer: kept
      await l.signal('a', offer());
      expect(peers[0]!.candidates.map((c) => (c as { candidate: string }).candidate.split(' ')[4])).toEqual(['192.168.1.5', '192.241.216.26']);
      await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', cs: [cand('10.0.0.7', 'host')] });
      await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand('10.0.0.8', 'host') }); // an older SDK's single one
      expect(peers[0]!.candidates.map((c) => (c as { candidate: string }).candidate.split(' ')[4])).toEqual(['192.168.1.5', '192.241.216.26', '10.0.0.7', '10.0.0.8']);
      expect(peers[0]!.closed).toBe(false);
    });
  });

  test('with several relays, the hello carries our delay to each (a STUN ping, before connecting)', async () => {
    const ms: Record<string, number> = { [sf.urls[0]!]: 31, [ny.urls[0]!]: 74 };
    const { l, sent } = withRelays('b', { probe: async (s) => ms[(s.urls as string[])[0]!] ?? null });
    await l.setRelays([sf, ny]);
    expect(sent).toEqual([{ to: 'a', d: { $gr: 'lan', k: 'hi', r: ms } as Signal['d'] }]);
  });

  test('one relay: nothing to choose, so no pings', async () => {
    let pings = 0;
    const { l } = withRelays('b', { probe: async () => (pings++, 10) });
    await l.setRelays([sf]);
    expect(pings).toBe(0);
  });

  test('the offerer picks the relay with the least delay for the two of them, and the answerer uses it', async () => {
    const a = withRelays('a', { probe: async (s) => ({ [sf.urls[0]!]: 10, [ny.urls[0]!]: 80 })[(s.urls as string[])[0]!] ?? null });
    await a.l.setRelays([sf, ny]);
    // b is near New York: SF costs 10 + 90, New York 80 + 12.
    await a.l.signal('b', { $gr: 'lan', k: 'hi', r: { [sf.urls[0]!]: 90, [ny.urls[0]!]: 12 } });
    expect(a.peers[0]!.config).toEqual({ iceServers: [ny], iceTransportPolicy: 'all' });
    const sentOffer = a.sent.find((x) => x.d.k === 'offer')!;
    expect(sentOffer.d.relay).toBe(ny.urls[0]);

    const b = withRelays('b', { probe: async () => null });
    await b.l.setRelays([sf, ny]);
    await b.l.signal('a', offer(ny.urls[0]));
    expect(b.peers[0]!.config).toEqual({ iceServers: [ny], iceTransportPolicy: 'all' });
  });

  test('a peer’s bad delays and an unknown relay are ignored', async () => {
    const a = withRelays('a', { probe: async (s) => ({ [sf.urls[0]!]: 40, [ny.urls[0]!]: 20 })[(s.urls as string[])[0]!] ?? null });
    await a.l.setRelays([sf, ny]);
    await a.l.signal('b', { $gr: 'lan', k: 'hi', r: { [sf.urls[0]!]: -500, junk: 'fast' } as unknown as Record<string, number> });
    expect(a.peers[0]!.config).toEqual({ iceServers: [ny], iceTransportPolicy: 'all' }); // our own delays decide

    const b = withRelays('b', { probe: async () => null });
    await b.l.setRelays([sf, ny]);
    await b.l.signal('a', offer('turn:evil.example:3478'));
    expect(b.peers[0]!.config).toEqual({ iceServers: [sf], iceTransportPolicy: 'all' }); // the first relay
  });

  test('says whether an open channel goes direct or through a relay', async () => {
    const { l, peers } = withRelays('b');
    await l.setRelays([sf]);
    await l.signal('a', offer());
    peers[0]!.stats = new Map<string, unknown>([
      ['t', { type: 'transport', selectedCandidatePairId: 'p1' }],
      ['p1', { type: 'candidate-pair', localCandidateId: 'l1', remoteCandidateId: 'r1' }],
      ['l1', { type: 'local-candidate', candidateType: 'host' }],
      ['r1', { type: 'remote-candidate', candidateType: 'relay' }],
    ]);
    expect(l.route('a')).toBeNull();
    peers[0]!.channel.onopen!();
    l.tick();
    await Bun.sleep(0);
    expect(l.route('a')).toBe('relay');
  });

  describe('edge cases', () => {
    const delays = (ms: Record<string, number>) => async (s: RTCIceServer) => ms[(s.urls as string[])[0]!] ?? null;

    test('fresh credentials for the same relays: swapped in, no new pings, no connection started over', async () => {
      let pings = 0;
      const { l, peers, sent } = withRelays('b', { probe: async () => (pings++, 20) });
      await l.setRelays([sf, ny]);
      expect(pings).toBe(2);
      sent.length = 0;
      const fresh = [{ ...sf, credential: 'y' }, { ...ny, credential: 'y' }];
      await l.setRelays(fresh);
      expect(pings).toBe(2);
      expect(sent).toEqual([]);
      await l.signal('a', offer(sf.urls[0]));
      expect((peers[0]!.config as RTCConfiguration).iceServers).toEqual([fresh[0]!]);
    });

    test('a new relay list (a region added) is timed again, and later hellos carry the new delays', async () => {
      const ms: Record<string, number> = { [sf.urls[0]!]: 30, [ny.urls[0]!]: 70 };
      const { l, sent } = withRelays('b', { probe: delays(ms) });
      const la = { urls: ['turn:198.51.100.4:3478'], username: 'u', credential: 'x' };
      await l.setRelays([sf, ny]);
      ms[la.urls[0]!] = 9;
      await l.setRelays([sf, ny, la]);
      sent.length = 0;
      await l.signal('a', ask);
      expect(sent[0]!.d.r).toEqual({ [sf.urls[0]!]: 30, [ny.urls[0]!]: 70, [la.urls[0]!]: 9 });
    });

    test('a relay list replaced while it is being timed: the old timing is thrown away', async () => {
      let release: () => void = () => {};
      const slow = new Promise<void>((res) => (release = res));
      const { l, sent } = withRelays('b', {
        probe: async (s) => {
          if ((s.urls as string[])[0] === sf.urls[0]) await slow;
          return (s.urls as string[])[0] === ny.urls[0] ? 50 : 10;
        },
      });
      const la = { urls: ['turn:198.51.100.4:3478'], username: 'u', credential: 'x' };
      const first = l.setRelays([sf, ny]);
      await l.setRelays([ny, la]);
      release();
      await first;
      sent.length = 0;
      await l.signal('a', ask);
      expect(sent[0]!.d.r).toEqual({ [ny.urls[0]!]: 50, [la.urls[0]!]: 10 });
    });

    test('closed while timing the relays: no hellos go out afterwards', async () => {
      let release: () => void = () => {};
      const slow = new Promise<void>((res) => (release = res));
      const { l, sent } = withRelays('b', { probe: async () => (await slow, 10) });
      const pending = l.setRelays([sf, ny]);
      l.close();
      release();
      await pending;
      expect(sent).toEqual([]);
    });

    test('a relay that fails to answer is left out of our delays; none answering sends a plain hello', async () => {
      const { l, sent } = withRelays('b', { probe: async (s) => ((s.urls as string[])[0] === ny.urls[0] ? Promise.reject(new Error('x')) : null) });
      await l.setRelays([sf, ny]);
      expect(sent).toEqual([{ to: 'a', d: { $gr: 'lan', k: 'hi' } as Signal['d'] }]);
    });

    test('an older SDK’s offer names no relay: the first relay; an offer naming one when we have none: the LAN only', async () => {
      const b = withRelays('b', { probe: async () => null });
      await b.l.setRelays([sf, ny]);
      await b.l.signal('a', offer());
      expect((b.peers[0]!.config as RTCConfiguration).iceServers).toEqual([sf]);

      const c = withRelays('b');
      await c.l.setRelays(null);
      await c.l.signal('a', offer(sf.urls[0]));
      expect(c.peers[0]!.config).toEqual({ iceServers: [] });
    });

    test('the answerer’s hello after an `ask` and after a dropped channel carries its delays too', async () => {
      const ms = { [sf.urls[0]!]: 30, [ny.urls[0]!]: 70 };
      const peers: FakePeer[] = [];
      const sent: Signal[] = [];
      const l = new Lan(
        deps({
          me: 'b',
          enabled: true,
          players: () => ['a', 'b'],
          signal: (to, d) => sent.push({ to, d: d as Signal['d'] }),
          relay: { probe: delays(ms) },
          timing: { retryMs: 1 },
          createPeer: () => {
            const p = new FakePeer();
            peers.push(p);
            return p as unknown as RTCPeerConnection;
          },
        }),
      );
      await l.setRelays([sf, ny]);
      sent.length = 0;
      await l.signal('a', ask);
      await l.signal('a', offer(sf.urls[0]));
      peers[0]!.channel.onopen!();
      peers[0]!.channel.onclose!();
      await Bun.sleep(10);
      expect(sent.filter((x) => x.d.k === 'hi').map((x) => x.d.r)).toEqual([ms, ms]);
    });

    test('an offerer ignores delays in a hello it doesn’t expect, and a `hi` to the answerer does nothing', async () => {
      const { l, peers, sent } = withRelays('b', { probe: async () => null });
      await l.setRelays([sf]);
      sent.length = 0;
      await l.signal('a', { $gr: 'lan', k: 'hi', r: { [sf.urls[0]!]: 1 } });
      expect(peers).toHaveLength(0);
      expect(sent).toEqual([]);
    });

    test('each open channel’s round trip is read with its route and shown in the stats, not kept past a drop (reliability review)', async () => {
      const { l, peers } = withRelays('b');
      await l.setRelays([sf]);
      await l.signal('a', offer());
      peers[0]!.stats = new Map<string, unknown>([
        ['t', { type: 'transport', selectedCandidatePairId: 'p1' }],
        ['p1', { type: 'candidate-pair', localCandidateId: 'l1', remoteCandidateId: 'r1', currentRoundTripTime: 0.024 }],
        ['l1', { type: 'local-candidate', candidateType: 'relay' }],
        ['r1', { type: 'remote-candidate', candidateType: 'host' }],
      ]);
      peers[0]!.channel.onopen!();
      expect(l.stats().rttMs).toEqual({});
      l.tick();
      await Bun.sleep(0);
      expect(l.stats().rttMs).toEqual({ a: 24 });
      expect(l.route('a')).toBe('relay');
      peers[0]!.channel.onclose!();
      expect(l.stats().rttMs).toEqual({});
    });

    test('the route is forgotten when the channel drops, read again when it reopens, and a failed read changes nothing', async () => {
      const { l, peers } = withRelays('b');
      await l.setRelays([sf]);
      await l.signal('a', offer());
      const pc = peers[0]!;
      const stats = (type: string) =>
        new Map<string, unknown>([
          ['t', { type: 'transport', selectedCandidatePairId: 'p' }],
          ['p', { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' }],
          ['l', { type: 'local-candidate', candidateType: type }],
          ['r', { type: 'remote-candidate', candidateType: 'host' }],
        ]);
      pc.stats = stats('host');
      pc.channel.onopen!();
      l.tick();
      await Bun.sleep(0);
      expect(l.route('a')).toBe('direct');
      pc.getStats = () => Promise.reject(new Error('closing'));
      l.tick();
      await Bun.sleep(0);
      expect(l.route('a')).toBe('direct');
      pc.channel.onclose!();
      expect(l.route('a')).toBeNull();
    });
  });

  describe('fresh relay credentials reach live connections (reliability review)', () => {
    const fresh = { ...sf, username: '1790003600:i:g:p_b', credential: 'y' };
    type Re = { k: string; g: string; of: string; sdp: string };

    /** The offerer ('a') with an open connection to b through `sf`, and that offer's id. */
    async function offerer() {
      const t = withRelays('a');
      await t.l.setRelays([sf]);
      await t.l.signal('b', { $gr: 'lan', k: 'hi' });
      const g1 = (t.sent.find((x) => x.d.k === 'offer')!.d as unknown as { g: string }).g;
      await t.l.signal('b', { $gr: 'lan', k: 'answer', g: g1, sdp: 'a1' });
      t.peers[0]!.channel.onopen!();
      t.sent.length = 0;
      return { ...t, g1 };
    }

    test('the offerer swaps them into the connection and restarts ICE on it: same connection, channel still open', async () => {
      const { l, peers, sent, g1 } = await offerer();
      await l.setRelays([fresh]);
      await Bun.sleep(0);
      expect(peers).toHaveLength(1);
      expect(peers[0]!.closed).toBe(false);
      expect(peers[0]!.config).toEqual({ iceServers: [fresh], iceTransportPolicy: 'all', certificates: ['kept'] });
      expect(peers[0]!.iceRestarts).toBe(1);
      expect(peers[0]!.offerOptions).toEqual({ iceRestart: true });
      const re = sent.map((x) => x.d as unknown as Re);
      expect(re.map((x) => x.k)).toEqual(['reoffer']);
      expect(re[0]!.of).toBe(g1);
      expect(re[0]!.g).not.toBe(g1);
      expect(l.peers()).toEqual(['b']);
      // The answer to the restart is applied; a late one for the first offer isn't.
      await l.signal('b', { $gr: 'lan', k: 'answer', g: g1, sdp: 'late' });
      expect(peers[0]!.remoteDescription).toEqual({ type: 'answer', sdp: 'a1' } as never);
      await l.signal('b', { $gr: 'lan', k: 'answer', g: re[0]!.g, sdp: 'a2' });
      expect(peers[0]!.remoteDescription).toEqual({ type: 'answer', sdp: 'a2' } as never);
      // Candidates found after it go with the restart's id.
      emitOn(peers[0]!, '192.168.1.5');
      expect(sent.filter((x) => x.d.k === 'ice').map((x) => (x.d as unknown as Re).g)).toEqual([re[0]!.g]);
    });

    test('the same credentials, a connection without a relay, or one not open yet: no restart', async () => {
      const same = await offerer();
      await same.l.setRelays([{ ...sf }]);
      await Bun.sleep(0);
      expect(same.peers[0]!.iceRestarts).toBe(0);
      expect(same.sent).toEqual([]);

      const lanOnly = withRelays('a');
      await lanOnly.l.setRelays(null);
      await lanOnly.l.signal('b', { $gr: 'lan', k: 'hi' });
      lanOnly.peers[0]!.channel.onopen!();
      await lanOnly.l.setRelays([fresh]);
      expect(lanOnly.peers[0]!.config).toEqual({ iceServers: [] });
      expect(lanOnly.peers[0]!.iceRestarts).toBe(0);

      const opening = withRelays('a');
      await opening.l.setRelays([sf]);
      await opening.l.signal('b', { $gr: 'lan', k: 'hi' });
      opening.sent.length = 0;
      await opening.l.setRelays([fresh]);
      expect((opening.peers[0]!.config as RTCConfiguration).iceServers).toEqual([fresh]); // for when it gathers
      expect(opening.peers[0]!.iceRestarts).toBe(0);
      expect(opening.sent).toEqual([]);
    });

    test('the answerer takes them too, and answers a restart on the connection it has, keeping it open', async () => {
      const { l, peers, sent } = withRelays('b', {}, undefined, undefined, { restartMs: 0 }); // (the restart comes minutes later)
      await l.setRelays([sf]);
      await l.signal('a', offer());
      peers[0]!.channel.onopen!();
      sent.length = 0;
      await l.setRelays([fresh]);
      expect((peers[0]!.config as RTCConfiguration).iceServers).toEqual([fresh]);
      expect(sent).toEqual([]); // the answerer waits for the offerer's restart
      // A candidate for the restart can overtake it: kept, then used.
      await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g2', c: cand('192.168.1.9', 'host') });
      await l.signal('a', { $gr: 'lan', k: 'reoffer', g: 'g2', of: 'g1', sdp: 'o2' } as never);
      expect(peers).toHaveLength(1);
      expect(peers[0]!.closed).toBe(false);
      expect(peers[0]!.remoteDescription).toEqual({ type: 'offer', sdp: 'o2' } as never);
      expect(sent.map((x) => [x.d.k, (x.d as unknown as Re).g])).toEqual([['answer', 'g2']]);
      expect(peers[0]!.candidates.map((c) => (c as { candidate: string }).candidate.split(' ')[4])).toEqual(['192.168.1.9']);
      expect(l.peers()).toEqual(['a']);
      await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand('192.168.1.10', 'host') }); // the old negotiation's: not used
      expect(peers[0]!.candidates).toHaveLength(1);
    });

    test('a restart for a connection the answerer no longer has: it starts over with a hello', async () => {
      const { l, peers, sent } = withRelays('b', {}, undefined, undefined, { restartMs: 0 });
      await l.setRelays([sf]);
      await l.signal('a', offer());
      sent.length = 0;
      await l.signal('a', { $gr: 'lan', k: 'reoffer', g: 'g9', of: 'g0', sdp: 'o' } as never);
      expect(peers[0]!.closed).toBe(true);
      expect(sent.map((x) => x.d.k)).toEqual(['hi']);
    });
    test('a restart counts toward the answerer’s restart cooldown: one too soon waits (security review)', async () => {
      const { l, peers, sent } = withRelays('b', {}, undefined, undefined, { restartMs: 40 });
      await l.setRelays([sf]);
      await l.signal('a', offer());
      sent.length = 0;
      await l.signal('a', { $gr: 'lan', k: 'reoffer', g: 'g2', of: 'g1', sdp: 'o2' } as never);
      expect(sent).toEqual([]);
      await Bun.sleep(60);
      expect(peers).toHaveLength(1);
      expect(sent.map((x) => x.d.k)).toEqual(['answer']);
    });
  });

  describe('a lost route is restarted, not left to time out (reliability review)', () => {
    const timing = { stallMs: 20, connectMs: 40, retryMs: 5 };
    const setState = (p: FakePeer, state: string) => {
      p.connectionState = state;
      (p.onconnectionstatechange as () => void)();
    };

    test('the offerer: no copies while disconnected; after STALL_MS it restarts ICE; back to connected, copies again', async () => {
      const { l, peers, sent } = withRelays('a', {}, undefined, undefined, timing);
      await l.setRelays([sf]);
      await l.signal('b', { $gr: 'lan', k: 'hi' });
      const copies: string[] = [];
      peers[0]!.channel.send = (t: string) => copies.push(t);
      peers[0]!.channel.onopen!();
      sent.length = 0;
      l.wrap(1, false);
      setState(peers[0]!, 'disconnected');
      l.wrap(2, false);
      expect(copies.map((t) => JSON.parse(t).d)).toEqual([1]);
      await Bun.sleep(10);
      expect(peers[0]!.iceRestarts).toBe(0); // a short blip: nothing yet
      await Bun.sleep(20);
      expect(peers[0]!.iceRestarts).toBe(1);
      expect(sent.map((x) => x.d.k)).toEqual(['reoffer']);
      setState(peers[0]!, 'connected');
      l.wrap(3, false);
      expect(copies.map((t) => JSON.parse(t).d)).toEqual([1, 3]);
      await Bun.sleep(60);
      expect(peers[0]!.closed).toBe(false); // recovered: not treated as lost
      expect(l.peers()).toEqual(['b']);
    });

    test('back before STALL_MS: no restart', async () => {
      const { l, peers, sent } = withRelays('a', {}, undefined, undefined, timing);
      await l.setRelays([sf]);
      await l.signal('b', { $gr: 'lan', k: 'hi' });
      peers[0]!.channel.onopen!();
      sent.length = 0;
      setState(peers[0]!, 'disconnected');
      await Bun.sleep(5);
      setState(peers[0]!, 'connected');
      await Bun.sleep(40);
      expect(peers[0]!.iceRestarts).toBe(0);
      expect(sent).toEqual([]);
    });

    test('the answerer waits for the restart; still disconnected after the connect timeout, it’s lost and set up again', async () => {
      const { l, peers, sent } = withRelays('b', {}, undefined, undefined, timing);
      await l.setRelays([sf]);
      await l.signal('a', offer());
      peers[0]!.channel.onopen!();
      sent.length = 0;
      setState(peers[0]!, 'disconnected');
      await Bun.sleep(30);
      expect(sent).toEqual([]); // no restart of its own
      expect(peers[0]!.closed).toBe(false);
      await Bun.sleep(45); // STALL_MS + the connect timeout, and the retry pause
      expect(peers[0]!.closed).toBe(true);
      expect(sent.map((x) => x.d.k)).toEqual(['hi']);
    });
  });

    describe('direct with party members (`lan: { direct: \'party\' }`)', () => {
    const stun = { urls: ['stun:192.241.216.26:3478'] };
    const incoming = async (l: Lan, list: [string, string][]) => {
      for (const [addr, typ] of list) await l.signal('a', { $gr: 'lan', k: 'ice', g: 'g1', c: cand(addr, typ) });
    };
    const used = (p: FakePeer) => p.candidates.map((c) => (c as { candidate: string }).candidate.split(' ')[4]);
    const publicOnes: [string, string][] = [['203.0.113.9', 'srflx'], ['73.71.58.49', 'host'], ['2001:db8::5', 'host']];

    test('with a party member: public candidates go both ways, and the relay’s STUN finds ours', async () => {
      const { l, peers, sent, emit, end } = withRelays('b', {}, (id) => id === 'a');
      await l.setRelays([sf]);
      await l.signal('a', offer());
      expect(peers[0]!.config).toEqual({ iceServers: [sf, stun], iceTransportPolicy: 'all' });
      await incoming(l, publicOnes);
      expect(used(peers[0]!)).toEqual(['203.0.113.9', '73.71.58.49', '2001:db8::5']);
      sent.length = 0;
      emit('203.0.113.9', 'srflx');
      emit('73.71.58.49', 'host');
      end();
      expect(outAddrs(sent)).toEqual(['203.0.113.9', '73.71.58.49']);
    });

    test('with anyone else in the room: no public address goes out or is probed', async () => {
      const { l, peers, sent, emit, end } = withRelays('b', {}, (id) => id === 'c');
      await l.setRelays([sf]);
      await l.signal('a', offer());
      expect(peers[0]!.config).toEqual({ iceServers: [sf], iceTransportPolicy: 'all' });
      await incoming(l, publicOnes);
      expect(used(peers[0]!)).toEqual([]);
      sent.length = 0;
      emit('203.0.113.9', 'srflx');
      emit('73.71.58.49', 'host');
      end();
      expect(sent).toEqual([]);
    });

    test('forceRelay wins: relay candidates only, even with a party member', async () => {
      const { l, peers } = withRelays('b', { only: true }, () => true);
      await l.setRelays([sf]);
      await l.signal('a', offer());
      expect(peers[0]!.config).toEqual({ iceServers: [sf], iceTransportPolicy: 'relay' });
      await incoming(l, publicOnes);
      expect(used(peers[0]!)).toEqual([]);
    });

    test('no relays: no STUN server either (never someone else’s), so only addresses the device has', async () => {
      const { l, peers } = withRelays('b', {}, () => true);
      await l.setRelays(null);
      await l.signal('a', offer());
      expect(peers[0]!.config).toEqual({ iceServers: [] });
      await incoming(l, [['73.71.58.49', 'host']]);
      expect(used(peers[0]!)).toEqual(['73.71.58.49']);
    });

    test('a public candidate goes out without its local address (raddr/rport)', async () => {
      const { l, peers, sent } = withRelays('b', {}, () => true);
      await l.setRelays([sf]);
      await l.signal('a', offer());
      const srflx = 'candidate:5 1 udp 1686052607 203.0.113.9 51234 typ srflx raddr 192.168.1.5 rport 51234 generation 0';
      (peers[0]!.onicecandidate as (ev: unknown) => void)({ candidate: { toJSON: () => ({ candidate: srflx, sdpMid: '0' }) } });
      (peers[0]!.onicecandidate as (ev: unknown) => void)({ candidate: null });
      expect(sent.find((x) => x.d.k === 'ice')!.d.c!.candidate).toContain('typ srflx raddr 0.0.0.0 rport 0');
    });

    test('joining or leaving the party starts the connection over, the other way; no change, no restart', async () => {
      let member = false;
      const { l, peers, sent } = withRelays('b', { probe: async () => null }, () => member);
      await l.setRelays([sf]);
      await l.signal('a', offer());
      peers[0]!.channel.onopen!();
      sent.length = 0;
      l.directChanged();
      expect(sent).toEqual([]);
      member = true;
      l.directChanged();
      expect(peers[0]!.closed).toBe(true);
      expect(sent.map((x) => x.d.k)).toEqual(['hi']);
      await l.signal('a', offer());
      expect((peers[1]!.config as RTCConfiguration).iceServers).toEqual([sf, stun]);
      member = false;
      sent.length = 0;
      l.directChanged();
      expect(peers[1]!.closed).toBe(true);
      expect(sent.map((x) => x.d.k)).toEqual(['hi']);
    });
  });
});

describe('LAN shortcut: copies that lose to the server stop (performance)', () => {
  test('the merge reports each race: won, arrived after the server’s copy, or held until it came', () => {
    const races: [string, boolean][] = [];
    const merge = new Merge(() => {}, () => true, (from, won) => races.push([from, won]));
    merge.accept('bo', w(1), 0, 'ws'); // no LAN copy: no race
    merge.accept('bo', w(2), 0, 'lan'); // first: won
    merge.accept('bo', w(2), 0, 'ws');
    merge.accept('bo', w(3), 0, 'ws');
    merge.accept('bo', w(3), 0, 'lan'); // after the server's: lost
    merge.accept('bo', w(5, 'A', 4), 0, 'lan'); // waits for 4's server copy
    merge.accept('bo', w(4), 0, 'ws');
    merge.accept('bo', w(5), 0, 'ws'); // (delivered as the LAN copy, once 4 came: won)
    merge.accept('bo', w(7, 'A', 7), 0, 'ws');
    expect(races).toEqual([
      ['bo', true],
      ['bo', false],
      ['bo', true],
    ]);
  });

  /** We are `a`, with an open channel to `b`; `clock` is the steady clock. */
  async function pair(clock: { t: number }) {
    const sent: string[] = [];
    let channel: FakePeer['channel'] | null = null;
    const l = new Lan(
      deps({
        enabled: true,
        clock: () => clock.t,
        createPeer: () => {
          const p = new FakePeer();
          p.channel.send = (t: string) => sent.push(t);
          channel = p.channel;
          queueMicrotask(() => p.channel.onopen?.());
          return p as unknown as RTCPeerConnection;
        },
      }),
    );
    await l.signal('b', hi);
    await Bun.sleep(0);
    const receive = (data: unknown) => (channel!.onmessage as unknown as (ev: { data: string }) => void)({ data: JSON.stringify(data) });
    return { l, sent, receive };
  }

  /** `count` of b's broadcasts from `from` on, each with its LAN copy first (`lanFirst`) or last. */
  function race(l: Lan, receive: (d: unknown) => void, from: number, count: number, lanFirst: (i: number) => boolean) {
    for (let i = 0; i < count; i++) {
      const n = from + i;
      const copy = { $gr: 'l', e: 's', n, d: n };
      if (lanFirst(i)) {
        receive(copy);
        l.receiveServer('b', copy as Wrapped, 0);
      } else {
        l.receiveServer('b', copy as Wrapped, 0);
        receive(copy);
      }
    }
  }

  test('a player whose copies nearly always lose hears so, once per window; one whose copies win doesn’t', async () => {
    const { l, sent, receive } = await pair({ t: 0 });
    l.receiveServer('b', { $gr: 'l', e: 's', n: 1, d: 1 }, 0); // the server starts the session
    race(l, receive, 2, RACE_WINDOW, (i) => i === 0); // 1 of 32 first
    expect(sent.filter((t) => t === '{"$gr":"slow"}')).toHaveLength(1);
    race(l, receive, 2 + RACE_WINDOW, RACE_WINDOW, (i) => i % 4 === 0); // a quarter first: worth it
    expect(sent.filter((t) => t === '{"$gr":"slow"}')).toHaveLength(1);
    l.close();
  });

  test('told so, we send that player only every PROBE_EVERYth copy, for SPARSE_MS; then all again', async () => {
    const clock = { t: 0 };
    const { l, sent, receive } = await pair(clock);
    const copies = () => sent.filter((t) => t.startsWith('{"$gr":"l"')).length;
    for (let i = 0; i < 20; i++) l.wrap(i, false);
    expect(copies()).toBe(20);
    receive({ $gr: 'slow' });
    for (let i = 0; i < 10 * PROBE_EVERY; i++) l.wrap(i, false);
    expect(copies()).toBe(20 + 10); // the probes keep the races going
    clock.t = SPARSE_MS;
    for (let i = 0; i < 20; i++) l.wrap(i, false);
    expect(copies()).toBe(50);
    l.close();
  });
});
