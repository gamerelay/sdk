/**
 * The API freeze before alpha.6 (SDK_PLAN.md §5): one way everything stops, errors that always have
 * a `code`, internals out of reach, read-only fields, and the five decisions (p2p, one invite link,
 * joinOrCreate, holder, party_room).
 */
import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { GameRelay, GameRelayError, Room, seededRandom } from '../src/index';
import { RequestRejection, Requests } from '../src/sync/requests';
import { answerRoom, connectFake, FakeSocket, advance, settle } from './fakeRelay';
import { FakeNet } from './fakeNet';

const g = globalThis as unknown as { WebSocket: unknown; fetch: unknown; location?: unknown; history?: unknown };
const saved = { WebSocket: g.WebSocket, fetch: g.fetch };
let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  g.WebSocket = saved.WebSocket;
  g.fetch = saved.fetch;
  delete g.location;
  delete g.history;
  jest.useRealTimers();
});

async function inRoom(playerId = 'pa') {
  const f = await connectFake(playerId);
  cleanup = f.done;
  const entering = f.relay.createRoom();
  await settle();
  answerRoom(f.socket(), 'create_room', playerId);
  return { ...f, room: await entering };
}

/** Connect with `fetch` answering `answer`, catching what `connect` rejects with. */
async function failConnect(answer: () => Promise<unknown>, options: Record<string, unknown> = {}) {
  jest.useFakeTimers();
  FakeSocket.all = [];
  g.WebSocket = FakeSocket;
  let fetched = 0;
  g.fetch = () => {
    fetched++;
    return answer();
  };
  const err = await GameRelay.connect({ publicKey: 'gr_pub_test', url: 'http://test.local', lan: false, ...options }).then(
    () => null,
    (e: unknown) => e,
  );
  return { err: err as GameRelayError, fetched: () => fetched };
}

describe('every rejection is a GameRelayError with a code', () => {
  test('offline: connect rejects `disconnected`, not a TypeError', async () => {
    const { err } = await failConnect(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(err).toBeInstanceOf(GameRelayError);
    expect(err.code).toBe('disconnected');
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError);
  });

  test("a proxy's 502 is `disconnected` (try again); a refused key is `unauthorized`", async () => {
    const bad = (status: number, body: unknown) => () => Promise.resolve({ ok: false, status, json: async () => body });
    expect((await failConnect(bad(502, null))).err.code).toBe('disconnected');
    expect((await failConnect(bad(401, { error: 'unauthorized', message: 'Unknown public key' }))).err.code).toBe('unauthorized');
    expect((await failConnect(bad(403, { error: 'origin_not_allowed' }))).err.code).toBe('unauthorized');
    expect((await failConnect(bad(429, { error: 'at_capacity' }))).err.code).toBe('at_capacity');
  });

  test('getToken throwing: `disconnected`, its error kept as the cause', async () => {
    const boom = new Error('backend down');
    const { err } = await failConnect(() => Promise.reject(new Error('unused')), { publicKey: undefined, getToken: () => Promise.reject(boom) });
    expect(err.code).toBe('disconnected');
    expect(err.message).toContain('backend down');
  });

  test('a socket that never says welcome: `timeout` after 15 s', async () => {
    jest.useFakeTimers();
    FakeSocket.all = [];
    g.WebSocket = FakeSocket;
    g.fetch = async () => ({ ok: true, status: 200, json: async () => ({ token: 'tok', expiresAt: Date.now() + 3_600_000 }) });
    let err: GameRelayError | null = null;
    void GameRelay.connect({ publicKey: 'gr_pub_test', url: 'http://test.local', lan: false }).catch((e) => (err = e));
    await advance(14_000, 500);
    expect(err).toBeNull();
    await advance(1_500, 500);
    expect(err!.code).toBe('timeout');
    expect(FakeSocket.last.closedByClient).toBe(true);
  });

  test('a secret key in publicKey is refused before anything is sent', async () => {
    const { err, fetched } = await failConnect(() => Promise.reject(new Error('unused')), { publicKey: 'gr_sk_live_123' });
    expect(err.code).toBe('unauthorized');
    expect(err.message).toContain('SECRET');
    expect(fetched()).toBe(0);
  });

  test('a secret key from getToken is refused too', async () => {
    const { err } = await failConnect(() => Promise.reject(new Error('unused')), { publicKey: undefined, getToken: async () => 'gr_sk_live_123' });
    expect(err.code).toBe('unauthorized');
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe('one way everything stops', () => {
  test('relay.close(): the room closes as left, waiting calls settle, and the relay forgets it', async () => {
    const { relay, room } = await inRoom();
    const closed: string[] = [];
    room.on('closed', (reason) => closed.push(reason));
    const asked = relay.ping().catch((e: GameRelayError) => e.code);
    relay.close();
    expect(closed).toEqual(['left']);
    expect(relay.room).toBeNull();
    expect(await asked).toBe('disconnected');
    expect(() => relay.tick(60, () => {})).toThrow(/closed/);
  });

  test("a `closed` handler that calls the relay hears it's closed, and nothing is sent", async () => {
    const { relay, room, socket } = await inRoom();
    const s = socket();
    const sent = s.attempts.length;
    let code: string | null = null;
    room.on('closed', () => {
      expect(relay.connected).toBe(false);
      void relay.quickMatch().catch((e: GameRelayError) => (code = e.message));
    });
    relay.close();
    await settle();
    expect(code).toContain('closed');
    expect(s.attempts.slice(sent).some((m) => m.t === 'quick_match')).toBe(false);
  });

  test('close() while a reconnect waits for its welcome settles it, and nothing is left waiting', async () => {
    const { relay, socket } = await inRoom();
    socket().drop(1006);
    const before = FakeSocket.all.length;
    for (let t = 0; t < 20_000 && FakeSocket.all.length === before; t += 50) await advance(50);
    expect(FakeSocket.all.length).toBe(before + 1); // a new socket, not welcomed
    relay.close();
    await advance(20_000, 1000);
    expect(FakeSocket.all.length).toBe(before + 1);
  });

  test('relay.close() settles a pending room.request and room.claim', async () => {
    const { relay, room, socket } = await inRoom();
    // Hand the host role away, so the request goes to another player and waits.
    socket().deliver({ t: 'player_joined', player: { id: 'pb', name: 'pb', avatar: null, joinedAt: 1, connected: true, slot: 1 } });
    socket().deliver({ t: 'host_changed', hostId: 'pb', previousHostId: 'pa' });
    const asked = room.request('buy', { item: 1 }).catch((e: GameRelayError) => e.code);
    const claimed = room.claim('coin');
    relay.close();
    expect(await asked).toBe('disconnected');
    expect(await claimed).toBe(false);
  });

  test('replaced: `replaced` fires, then the room closes as lost, and nothing reconnects', async () => {
    const { relay, room, socket } = await inRoom();
    const seen: string[] = [];
    relay.on('replaced', () => seen.push('replaced'));
    room.on('closed', (reason) => seen.push(`closed:${reason}`));
    socket().drop(4001);
    expect(seen).toEqual(['replaced', 'closed:lost']);
    expect(relay.room).toBeNull();
    const sockets = FakeSocket.all.length;
    await advance(30_000, 1000);
    expect(FakeSocket.all.length).toBe(sockets);
  });

  test('a reconnect the server refuses (rotated key): `error` says why, and it stops', async () => {
    const { relay, room, socket } = await inRoom();
    const errors: string[] = [];
    const closed: string[] = [];
    relay.on('error', (e) => errors.push(e.code));
    room.on('closed', (reason) => closed.push(reason));
    let asked = 0;
    g.fetch = async () => {
      asked++;
      return { ok: false, status: 401, json: async () => ({ error: 'unauthorized', message: 'Unknown public key' }) };
    };
    socket().drop(1006);
    await advance(60_000, 500);
    expect(errors).toEqual(['unauthorized']);
    expect(closed).toEqual(['lost']);
    expect(asked).toBe(1);
  });

  test('a reconnect that fails for a moment (a 502 mid-deploy) keeps trying, quietly', async () => {
    const { relay, socket } = await inRoom();
    const errors: string[] = [];
    relay.on('error', (e) => errors.push(e.code));
    let asked = 0;
    g.fetch = async () => {
      asked++;
      return { ok: false, status: 502, json: async () => ({}) };
    };
    socket().drop(1006);
    await advance(30_000, 500);
    expect(errors).toEqual([]);
    expect(asked).toBeGreaterThan(2);
  });

  test('at capacity on reconnect: `error` once, and it keeps trying', async () => {
    const { relay, socket } = await inRoom();
    const errors: string[] = [];
    relay.on('error', (e) => errors.push(e.code));
    let asked = 0;
    g.fetch = async () => {
      asked++;
      return { ok: false, status: 429, json: async () => ({ error: 'at_capacity', message: 'full' }) };
    };
    socket().drop(1006);
    await advance(30_000, 500);
    expect(errors).toEqual(['at_capacity']);
    expect(asked).toBeGreaterThan(2);
  });
});

describe('internals out of reach', () => {
  test('new GameRelay() and new Room() say how to get one', () => {
    const G = GameRelay as unknown as new (o: unknown) => unknown;
    const R = Room as unknown as new () => unknown;
    expect(() => new G({ publicKey: 'gr_pub_x' })).toThrow(/GameRelay\.connect/);
    expect(() => new R()).toThrow(/createRoom/);
  });

  test("the wire-level methods aren't on the relay or the room", async () => {
    const { relay, room } = await inRoom();
    for (const name of ['queue', 'request', 'warn', 'writeTime', 'lanWithinRate', 'lanEnabled', 'newEntityId', 'serverReady']) {
      expect({ name, there: name in relay }).toEqual({ name, there: false });
    }
    for (const name of ['handle', 'sync', 'closeLocal', 'dispose', 'closeLan', 'lanPause', 'lanPartyChanged', 'debugInfo']) {
      expect({ name, there: name in room }).toEqual({ name, there: false });
    }
  });

  test('statics on the class itself, for both builds', () => {
    expect(GameRelay.seededRandom).toBe(seededRandom);
    expect(GameRelay.seededRandom(7)()).toBe(seededRandom(7)());
    expect(typeof GameRelay.version).toBe('string');
  });
});

describe('read-only fields', () => {
  test('relay and room fields are getters: assigning throws (modules are strict)', async () => {
    const { relay, room } = await inRoom();
    expect(() => ((relay as unknown as { playerId: string }).playerId = 'x')).toThrow(TypeError);
    expect(() => ((relay as unknown as { room: null }).room = null)).toThrow(TypeError);
    expect(() => ((room as unknown as { hostId: string }).hostId = 'x')).toThrow(TypeError);
    expect(() => ((room as unknown as { state: object }).state = {})).toThrow(TypeError);
    expect(relay.room).toBe(room);
    expect(room.hostId).toBe('pa');
    // The lists can't be changed in place either.
    expect(() => (room.players as unknown[]).push({})).toThrow(TypeError);
    expect(() => (room.chatHistory as unknown[]).push({})).toThrow(TypeError);
  });

  test('room.state.x = … warns once (by the next frame), naming setState; the state stays a plain, cloneable object', async () => {
    const { room } = await inRoom();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    room.setState({ round: 1 });
    expect(room.state.round).toBe(1);
    await advance(100);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('room.state.x'))).toBe(false);
    room.state.round = 2;
    room.state.score = 3;
    await advance(100);
    expect(structuredClone(room.state)).toEqual({ round: 2, score: 3 });
    const printed = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('room.state.x'));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('room.setState');
    expect(JSON.stringify(room.state)).toBe('{"round":2,"score":3}'); // applied locally, as before
    warn.mockRestore();
  });
});

describe('event names', () => {
  test("relay.on('player_joined') warns that it's a room event", async () => {
    const { relay } = await inRoom();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    relay.on('player_joined' as never, () => {});
    relay.on('disconnected', () => {});
    const printed = warn.mock.calls.map((c) => String(c[0]));
    expect(printed.filter((m) => m.includes("relay.on('player_joined')"))).toHaveLength(1);
    expect(printed[0]).toContain("room.on('player_joined'");
    warn.mockRestore();
  });

  test("'access' and 'listing' are built-in: room.emit refuses them", async () => {
    const { room } = await inRoom();
    expect(() => room.emit('access', 1)).toThrow(/reserved/);
    expect(() => room.emit('listing', 1)).toThrow(/reserved/);
  });

  test('a party leader moving you fires party_room, and the old name room too', async () => {
    const { relay, socket } = await inRoom();
    const seen: string[] = [];
    relay.on('party_room', () => seen.push('party_room'));
    relay.on('room', () => seen.push('room'));
    socket().deliver({ t: 'room', room: { ...(await import('./fakeRelay')).roomInfo('pa'), id: 'r2', code: 'WXYZ' }, you: 'pa' });
    socket().deliver({ t: 'party_room', roomId: 'r2' });
    expect(seen).toEqual(['party_room', 'room']);
    expect(relay.room?.code).toBe('WXYZ');
  });
});

describe('room helpers', () => {
  test('a returned room.reject() refuses, like a thrown one', async () => {
    const net = new FakeNet({ latency: 10 });
    net.host = 'pa';
    const reqs: Record<string, Requests> = {};
    for (const id of ['pa', 'pb']) {
      const t = net.join(id, id, (d, from) => void reqs[id]!.receive(d, from));
      reqs[id] = new Requests(t, () => {});
    }
    reqs.pa!.onRequest('buy', () => new RequestRejection('Not enough gold') as never);
    const p = reqs.pb!.request('buy', null).catch((e: GameRelayError) => `${e.code}: ${e.message}`);
    for (let i = 0; i < 20; i++) {
      net.advanceTo(net.now + 10);
      for (let j = 0; j < 5; j++) await Promise.resolve();
    }
    expect(await p).toBe('rejected: Not enough gold');
  });

  test("a non-host's room.timer and clearTimer throw not_host, like setState", async () => {
    const { room, socket } = await inRoom();
    socket().deliver({ t: 'player_joined', player: { id: 'pb', name: 'pb', avatar: null, joinedAt: 1, connected: true, slot: 1 } });
    socket().deliver({ t: 'host_changed', hostId: 'pb', previousHostId: 'pa' });
    expect(() => room.timer('round', 1000)).toThrow(expect.objectContaining({ code: 'not_host' }));
    expect(() => room.clearTimer('round')).toThrow(expect.objectContaining({ code: 'not_host' }));
  });

  test('holder(key) is who holds a claim; claimed(key) still answers', async () => {
    const { room, socket } = await inRoom();
    socket().deliver({ t: 'claimed', key: 'coin', playerId: 'pa' });
    expect(room.holder('coin')).toBe('pa');
    expect(room.claimed('coin')).toBe('pa');
    expect(room.holder('gem')).toBeNull();
  });

  test('listRooms({ tag, includeFull }) and the positional form send the same', async () => {
    const { relay, socket } = await inRoom();
    void relay.listRooms({ tag: 'ctf', includeFull: true }).catch(() => {});
    void relay.listRooms('ctf', { includeFull: true }).catch(() => {});
    await settle();
    const [a, b] = socket().sentOf('list_rooms');
    expect({ tag: a!.tag, includeFull: a!.includeFull }).toEqual({ tag: 'ctf', includeFull: true });
    expect({ tag: b!.tag, includeFull: b!.includeFull }).toEqual({ tag: 'ctf', includeFull: true });
  });
});

describe('one invite link', () => {
  test("an open room's invite is ?room=CODE; a link-only room's is its short link, known before the room is handed over", async () => {
    g.location = { href: 'https://mygame.com/play?room=OLD' };
    const f = await connectFake('pa');
    cleanup = f.done;
    const open = f.relay.createRoom();
    await settle();
    answerRoom(f.socket(), 'create_room', 'pa');
    const room = await open;
    expect(room.inviteUrl()).toBe('https://mygame.com/play?room=ABCD');

    const entering = f.relay.createRoom({ linkOnly: true });
    await settle();
    const req = f.socket().sentOf('create_room').at(-1)!;
    const info = { ...(await import('./fakeRelay')).roomInfo('pa'), id: 'r2', code: 'WXYZ', linkOnly: true };
    f.socket().deliver({ t: 'room', room: info, you: 'pa' });
    f.socket().deliver({ t: 'reply', rid: req.rid, data: { roomId: 'r2' } });
    // Handed over at once (no events missed while the link is fetched), its link asked for already.
    const linkOnly = await entering;
    await settle();
    const ask = f.socket().sentOf('share_link').at(-1)!;
    f.socket().deliver({ t: 'reply', rid: ask.rid, data: { link: 'ZumXpZzDsgo', url: 'https://play.gamerelay.io/x/ZumXpZzDsgo' } });
    await settle();
    // Same origin as the page (history.replaceState refuses another), with the link's id.
    expect(linkOnly.inviteUrl()).toBe('https://mygame.com/play?join=ZumXpZzDsgo');
  });
});

test('joinLink(id): the invite is known without asking the server again', async () => {
  g.location = { href: 'https://mygame.com/play' };
  const f = await connectFake('pa');
  cleanup = f.done;
  const entering = f.relay.joinLink('ZumXpZzDsgo');
  await settle();
  const req = f.socket().sentOf('join_link').at(-1)!;
  f.socket().deliver({ t: 'room', room: { ...(await import('./fakeRelay')).roomInfo('pa'), linkOnly: true }, you: 'pa' });
  f.socket().deliver({ t: 'reply', rid: req.rid, data: { roomId: 'r1' } });
  const room = await entering;
  // Right away, before any share_link answer.
  expect(room.inviteUrl()).toBe('https://mygame.com/play?join=ZumXpZzDsgo');
});

describe('joinOrCreate (experimental)', () => {
  async function relayAt(href: string | null) {
    if (href) g.location = { href };
    const f = await connectFake('pa');
    cleanup = f.done;
    return f;
  }

  test('no invite in the URL: quick match', async () => {
    const f = await relayAt(null);
    const p = f.relay.joinOrCreate({ maxPlayers: 4, tag: 'duel' });
    await settle();
    expect(f.socket().sentOf('quick_match').at(-1)).toMatchObject({ maxPlayers: 4, tag: 'duel' });
    answerRoom(f.socket(), 'quick_match', 'pa');
    expect((await p).code).toBe('ABCD');
  });

  test("an invite to a room that's gone: quick match instead; `private` creates one", async () => {
    const f = await relayAt('https://mygame.com/?room=GONE');
    const p = f.relay.joinOrCreate({ private: true, updateUrl: true });
    const replaced: string[] = [];
    g.history = { state: null, replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url) };
    await settle();
    const join = f.socket().sentOf('join_room').at(-1)!;
    f.socket().deliver({ t: 'error', rid: join.rid, code: 'room_not_found', message: 'No room GONE' });
    await settle();
    answerRoom(f.socket(), 'create_room', 'pa');
    await settle();
    // (the short link the SDK fetches on entering, in a page)
    const ask = f.socket().sentOf('share_link').at(-1);
    if (ask) f.socket().deliver({ t: 'error', rid: ask.rid, code: 'bad_request', message: 'no links' });
    const room = await p;
    expect(room.code).toBe('ABCD');
    expect(f.socket().sentOf('quick_match')).toHaveLength(0);
    expect(replaced).toEqual(['https://mygame.com/?room=ABCD']);
  });

  test('a full, locked or banning room still rejects: the player should hear why', async () => {
    const f = await relayAt('https://mygame.com/?room=FULL');
    const p = f.relay.joinOrCreate().catch((e: GameRelayError) => e.code);
    await settle();
    const join = f.socket().sentOf('join_room').at(-1)!;
    f.socket().deliver({ t: 'error', rid: join.rid, code: 'room_full', message: 'Room is full' });
    expect(await p).toBe('room_full');
  });
});

describe('p2p (the new name of lan)', () => {
  async function capsWith(options: Record<string, unknown>) {
    jest.useFakeTimers();
    FakeSocket.all = [];
    g.WebSocket = FakeSocket;
    g.fetch = async () => ({ ok: true, status: 200, json: async () => ({ token: 'tok', expiresAt: Date.now() + 3_600_000 }) });
    const connecting = GameRelay.connect({ publicKey: 'gr_pub_test', url: 'http://test.local', ...options });
    await settle();
    const caps = new URL(FakeSocket.last.url).searchParams.get('caps')!.split(',');
    FakeSocket.last.welcome('pa');
    const relay = await connecting;
    cleanup = () => relay.close();
    return caps;
  }

  test('on by default; p2p: false and the old lan: false both turn it off', async () => {
    expect(await capsWith({})).toContain('lan');
    expect(await capsWith({ p2p: false })).not.toContain('lan');
    expect(await capsWith({ lan: false })).not.toContain('lan');
  });
});
