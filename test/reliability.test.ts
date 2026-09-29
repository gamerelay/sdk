import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { GameRelayError } from '../src/index';
import { FakeSocket, advance, answerRoom, connectFake, settle } from './fakeRelay';

/** The SDK's REPLY_TIMEOUT_MS. */
const REPLY_TIMEOUT_MS = 10_000;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});
async function setup(playerId?: string, options?: { page?: boolean }) {
  const f = await connectFake(playerId, options);
  cleanup = f.done;
  return f;
}

describe('requests to the server', () => {
  test('a request with no answer fails with timeout instead of hanging, and its late answer is ignored', async () => {
    const { relay, socket } = await setup();
    const errors: string[] = [];
    relay.on('error', (e) => errors.push(e.code));
    let outcome: unknown = 'pending';
    relay.storage.get('best').then(
      (v) => (outcome = v),
      (e: GameRelayError) => (outcome = e.code),
    );
    await settle();
    const [sent] = socket().sentOf('kv_get');
    await advance(REPLY_TIMEOUT_MS - 100);
    expect(outcome).toBe('pending');
    await advance(200);
    expect(outcome).toBe('timeout');
    // The answer turns up after all: nobody is waiting, and it isn't reported as a stray error.
    socket().deliver({ t: 'reply', rid: sent!.rid, data: 5 });
    socket().deliver({ t: 'error', rid: sent!.rid, code: 'rate_limited', message: 'slow down' });
    expect(outcome).toBe('timeout');
    expect(errors).toEqual([]);
  });

  test('an answer in time settles the request and cancels its timeout', async () => {
    const { relay, socket } = await setup();
    const got = relay.storage.get('best');
    await settle();
    socket().deliver({ t: 'reply', rid: socket().sentOf('kv_get')[0]!.rid, data: 7 });
    expect(await got).toBe(7);
  });

  test('a ping the server refused (rate_limited, by rid) rejects instead of waiting for a pong', async () => {
    const { relay, socket } = await setup();
    let outcome: unknown = 'pending';
    relay.ping().catch((e: GameRelayError) => (outcome = e.code));
    await settle();
    const ping = socket().sentOf('ping').at(-1)!;
    socket().deliver({ t: 'error', rid: ping.rid, code: 'rate_limited', message: 'slow down' });
    await settle();
    expect(outcome).toBe('rate_limited');
  });

  test('a rejoin that gets no answer keeps the room and tries again on a new socket', async () => {
    const { relay, socket, reopen } = await setup();
    const entering = relay.createRoom();
    await settle();
    answerRoom(socket(), 'create_room', 'pa');
    const room = await entering;
    let closed = '';
    room.on('closed', (reason) => (closed = reason));
    socket().drop();
    const quiet = await reopen(); // the server takes us back but never answers the rejoin
    await advance(REPLY_TIMEOUT_MS + 100);
    expect(quiet.sentOf('join_room').length).toBe(1);
    expect(closed).toBe('');
    expect(relay.room).toBe(room);
    const next = await reopen();
    await settle();
    answerRoom(next, 'join_room', 'pa');
    await settle();
    expect(relay.room).toBe(room);
    expect(closed).toBe('');
  });
});

describe('the server clock (relay.now)', () => {
  /** Answer every ping as a server whose clock reads `Date.now() + skew`, after `delay` ms each way. */
  const serve = (socket: () => FakeSocket) => {
    const answered = new Map<FakeSocket, number>();
    return async (skew: number, delay = 0) => {
      const s = socket();
      s.autoPong = false; // this test's server answers
      jest.advanceTimersByTime(0); // pings due now go out
      const from = answered.get(s) ?? 0;
      answered.set(s, s.sentOf('ping').length);
      await advance(delay, delay || 50);
      const serverTime = Date.now() + skew;
      await advance(delay, delay || 50);
      s.pong(serverTime, from);
      await settle();
    };
  };

  test("a step in the wall clock (sleep and wake, an NTP fix) doesn't move now()", async () => {
    const { relay, socket } = await setup();
    await serve(socket)(5_000);
    const before = relay.now();
    const realNow = Date.now;
    Date.now = () => realNow() + 3_600_000;
    try {
      expect(Math.abs(relay.now() - before)).toBeLessThan(5);
    } finally {
      Date.now = realNow;
    }
  });

  test("after a reconnect the new connection's samples replace an old, better one", async () => {
    const { relay, socket, reopen } = await setup();
    const answer = serve(socket);
    await answer(0); // an instant round trip: the best sample there can be
    expect(Math.abs(relay.now() - Date.now())).toBeLessThan(5);
    socket().drop();
    await reopen();
    await answer(400, 30); // a slower route, and the server's clock is now 400 ms ahead
    expect(Math.abs(relay.now() - (Date.now() + 400))).toBeLessThan(40);
  });

  test('it is re-measured every 20 s, so it follows the server', async () => {
    const { relay, socket } = await setup();
    const answer = serve(socket);
    for (let i = 0; i < 4; i++) {
      await answer(0); // the pings on connecting
      await advance(1000);
    }
    for (let i = 0; i < 20; i++) {
      socket().deliver({ t: 'batch', m: [] }); // a busy room: no liveness pings, only the clock's
      await advance(1000);
      await answer(250); // the clocks have drifted apart since
    }
    // (Within the new sample's half round trip: this fake server answers up to 50 ms late.)
    expect(Math.abs(relay.now() - (Date.now() + 250))).toBeLessThan(30);
  });
});

describe('a socket that stays open after its network is gone', () => {
  test('is noticed within ~9 s of silence and replaced by a new one', async () => {
    const { relay, socket } = await setup();
    const events: string[] = [];
    relay.on('disconnected', () => events.push('disconnected'));
    const dead = socket();
    dead.autoPong = false;
    dead.pong(Date.now()); // the pings on connecting are answered, then the network goes
    await advance(4_900);
    expect(dead.closedByClient).toBe(false);
    const pings = dead.sentOf('ping').length;
    await advance(1_000); // 5 s of silence: a probe
    expect(dead.sentOf('ping').length).toBe(pings + 1);
    await advance(3_100); // and no answer to it
    expect(dead.closedByClient).toBe(true);
    expect(events).toEqual(['disconnected']);
    expect(relay.connected).toBe(false);
    await advance(10_000);
    expect(socket()).not.toBe(dead); // reconnecting on a new socket
  });

  test('an idle but healthy room keeps its socket, with at most one ping per 5 s', async () => {
    const { socket } = await setup();
    const s = socket(); // a live server answers every ping
    await advance(60_000);
    expect(s.closedByClient).toBe(false);
    expect(FakeSocket.all.length).toBe(1);
    expect(s.sentOf('ping').length).toBeLessThanOrEqual(3 + 60 / 5);
  });

  test('traffic counts as proof of life: a busy room sends no probes, only the clock re-measures', async () => {
    const { socket } = await setup();
    const s = socket();
    s.pong(Date.now());
    const pings = s.sentOf('ping').length;
    for (let i = 0; i < 60; i++) {
      await advance(1000);
      s.deliver({ t: 'batch', m: [] }); // others' updates
    }
    expect(s.closedByClient).toBe(false);
    expect(s.sentOf('ping').length - pings).toBeLessThanOrEqual(2 + 3); // the 1 s and 3 s pings, then one per 20 s
  });

  test('a page shown again, or back online, checks at once instead of after 5 s', async () => {
    const { socket, page } = await setup('pa', { page: true });
    const dead = socket();
    dead.autoPong = false;
    dead.pong(Date.now());
    await advance(3_500); // the connecting pings are done; quiet for less than 5 s
    const pings = dead.sentOf('ping').length;
    page!.fire('visibilitychange');
    await settle();
    expect(dead.sentOf('ping').length).toBe(pings + 1);
    await advance(4_000); // (the watchdog looks once a second)
    expect(dead.closedByClient).toBe(true);
  });

  test("a window 'online' event probes too", async () => {
    const { socket, page } = await setup('pa', { page: true });
    const s = socket();
    s.autoPong = false;
    s.pong(Date.now());
    await advance(3_500);
    const pings = s.sentOf('ping').length;
    page!.fire('online');
    await settle();
    expect(s.sentOf('ping').length).toBe(pings + 1);
    s.deliver({ t: 'batch', m: [] }); // it's alive
    await advance(4_000);
    expect(s.closedByClient).toBe(false);
  });
});

describe('a server restart', () => {
  test("players come back spread over 0.5–1.5× the server's hint, not all at once", async () => {
    const at: number[] = [];
    for (const r of [0, 0.999]) {
      const { socket } = await setup();
      socket().deliver({ t: 'server_restarting', reconnectInMs: 2000 });
      const random = spyOn(Math, 'random').mockReturnValue(r);
      try {
        const start = Date.now();
        socket().drop(1012);
        while (FakeSocket.all.length === 1 && Date.now() - start < 10_000) await advance(10, 10);
        at.push(Date.now() - start);
      } finally {
        random.mockRestore();
        cleanup?.();
        cleanup = null;
      }
    }
    expect(at[0]).toBeGreaterThanOrEqual(990);
    expect(at[0]).toBeLessThanOrEqual(1030);
    expect(at[1]).toBeGreaterThanOrEqual(2980);
    expect(at[1]).toBeLessThanOrEqual(3030);
  });
});

describe('the outbox while offline', () => {
  test('when it overflows, what a later message replaces goes first, not the oldest reliable sends', async () => {
    const { relay, socket, reopen } = await setup();
    socket().drop();
    await settle();
    for (let i = 0; i < 250; i++) relay.queue({ t: 'send', d: i });
    for (let i = 0; i < 20; i++) relay.queue({ t: 'heartbeat' }); // a host's, while its rejoin waits
    await advance(100);
    const back = await reopen();
    await advance(3000); // (more than the rate limit's burst: some of it waits for the budget)
    expect(back.attempts.filter((m) => m.t === 'send').map((m) => m.d)).toEqual([...Array(250).keys()]);
    expect(back.attempts.filter((m) => m.t === 'heartbeat').length).toBeLessThanOrEqual(6);
  });

  test('past the cap with nothing replaceable, the oldest go', async () => {
    const { relay, socket, reopen } = await setup();
    socket().drop();
    await settle();
    for (let i = 0; i < 300; i++) relay.queue({ t: 'send', d: i });
    await advance(100);
    const back = await reopen();
    await advance(3000);
    expect(back.attempts.filter((m) => m.t === 'send').map((m) => m.d)).toEqual([...Array(256).keys()].map((i) => i + 44));
  });
});

describe("the server's rate limit", () => {
  test("a burst over the budget isn't sent as frames the server drops: reliable sends wait, in order", async () => {
    const { relay, socket } = await setup();
    const s = socket();
    for (let i = 0; i < 300; i++) {
      relay.queue({ t: 'send', d: i });
      if (i % 15 === 0) relay.queue({ t: 'send', d: `pos${i}`, r: false }); // plain entity updates
    }
    await advance(20);
    expect(s.dropped).toEqual([]);
    await advance(1000);
    expect(s.dropped).toEqual([]);
    const sent = s.sentOf('send');
    expect(sent.filter((m) => typeof m.d === 'number').map((m) => m.d)).toEqual([...Array(300).keys()]);
    expect(sent.some((m) => typeof m.d === 'string')).toBe(false); // what the next update replaces went first
  });

  test('within the budget, everything goes out at once, unreliable sends included', async () => {
    const { relay, socket } = await setup();
    for (let i = 0; i < 100; i++) relay.queue({ t: 'send', d: i, r: i % 2 === 0 ? false : undefined });
    await advance(20);
    expect(socket().sentOf('send').length).toBe(100);
  });
});

describe('sends from a relay.tick step', () => {
  test("go out when the wake's steps are done, not on the next animation frame, and share one frame", async () => {
    const { relay, socket } = await setup();
    await advance(100);
    const frames = socket().frames.length;
    let step = 0;
    relay.tick(60, (_dt, n) => {
      step = n;
      relay.queue({ t: 'send', d: `a${n}` });
    });
    relay.tick(60, (_dt, n) => relay.queue({ t: 'send', d: `b${n}` }));
    // Timer by timer up to the first step, so the frame flush's timer hasn't run yet.
    for (let i = 0; i < 100 && step === 0; i++) jest.advanceTimersToNextTimer();
    await settle();
    expect(step).toBe(1);
    expect(socket().frames.length).toBe(frames + 1);
    expect(socket().sentOf('send').map((m) => m.d)).toEqual(['a1', 'b1']);
  });
});
