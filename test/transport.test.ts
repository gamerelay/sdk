/**
 * `connect({ transport })` (TRANSPORT.md, "The seam"): the socket and the SDK's own requests go
 * where the transport says, the network stays the default, and a transport that can't reach other
 * players turns P2P off.
 */
import { afterEach, expect, jest, test } from 'bun:test';
import { maskKey, openFrame } from '@gamerelay/protocol/sign';
import { LIMITS } from '@gamerelay/protocol/limits';
import { GameRelay, GameRelayError, type Transport, type TransportSocket } from '../src/index';
import { advance, answerRoom, FakeSocket, FakeTransport, settle, tokenAnswer } from './fakeRelay';

const g = globalThis as unknown as { WebSocket: unknown; fetch: unknown };
const saved = { WebSocket: g.WebSocket, fetch: g.fetch };
let relay: GameRelay | null = null;

afterEach(() => {
  relay?.close();
  relay = null;
  g.WebSocket = saved.WebSocket;
  g.fetch = saved.fetch;
  jest.useRealTimers();
});

/** Globals that fail the test if the SDK reaches for them. */
function forbidNetwork() {
  g.WebSocket = class {
    constructor() {
      throw new Error('the global WebSocket was used');
    }
  };
  g.fetch = () => {
    throw new Error('the global fetch was used');
  };
}

async function connectThrough(transport: Transport, options: Record<string, unknown> = {}) {
  jest.useFakeTimers();
  FakeSocket.all = [];
  const connecting = GameRelay.connect({ publicKey: 'gr_pub_test', url: 'https://gamerelay.io', transport, ...options });
  await settle();
  FakeSocket.last.welcome('pa');
  relay = await connecting;
  return relay;
}

test('without a transport the SDK uses the global WebSocket and fetch, as before', async () => {
  jest.useFakeTimers();
  FakeSocket.all = [];
  const fetched: string[] = [];
  g.WebSocket = FakeSocket;
  g.fetch = (url: string) => {
    fetched.push(url);
    return tokenAnswer()();
  };
  const connecting = GameRelay.connect({ publicKey: 'gr_pub_test', url: 'https://gamerelay.io', lan: false });
  await settle();
  FakeSocket.last.welcome('pa');
  relay = await connecting;
  expect(relay.connected).toBe(true);
  expect(fetched).toEqual(['https://gamerelay.io/v1/auth/anonymous']);
  expect(FakeSocket.last.url.startsWith('wss://gamerelay.io/ws?token=tok&')).toBe(true);
});

test("the socket and the token request go through the transport, and the network's globals are never touched", async () => {
  forbidNetwork();
  const transport = new FakeTransport();
  const opened: [string, string][] = [];
  const open = transport.open.bind(transport);
  transport.open = (url: string, protocol?: string) => (opened.push([url, protocol!]), open(url));
  await connectThrough(transport, { lan: false });
  expect(relay!.connected).toBe(true);
  expect(transport.fetched).toEqual(['https://gamerelay.io/v1/auth/anonymous']);
  expect(opened).toHaveLength(1);
  expect(opened[0]![0].startsWith('wss://gamerelay.io/ws?token=tok&')).toBe(true);
  expect(opened[0]![1]).toBe('gamerelay.v1.json');
});

test('a reconnect opens its new socket through the transport too', async () => {
  forbidNetwork();
  const transport = new FakeTransport();
  await connectThrough(transport, { lan: false });
  FakeSocket.last.drop();
  for (let t = 0; t < 20_000 && FakeSocket.all.length === 1; t += 50) await advance(50);
  expect(FakeSocket.all).toHaveLength(2);
  FakeSocket.last.welcome('pa');
  await settle();
  expect(relay!.connected).toBe(true);
});

test('p2p: false on the transport turns P2P off, whatever connect says', async () => {
  const caps = async (options: Record<string, unknown>) => {
    const transport = Object.assign(new FakeTransport(), { p2p: false as const });
    await connectThrough(transport, options);
    const c = new URL(FakeSocket.last.url).searchParams.get('caps')!.split(',');
    relay!.close();
    relay = null;
    return c;
  };
  expect(await caps({})).not.toContain('lan');
  expect(await caps({ p2p: true })).not.toContain('lan');
  expect(await caps({ p2p: { forceRelay: true } })).not.toContain('lan');
  // Without the flag, the default stays on.
  await connectThrough(new FakeTransport());
  expect(new URL(FakeSocket.last.url).searchParams.get('caps')!.split(',')).toContain('lan');
});

test('p2p: false on the transport means no TURN request in a room, where P2P would otherwise ask for one', async () => {
  const turnsAsked = async (transport: Transport) => {
    await connectThrough(transport, { p2p: true });
    const entering = relay!.createRoom();
    await settle();
    answerRoom(FakeSocket.last, 'create_room', 'pa');
    await entering;
    await advance(5_000);
    const asked = FakeSocket.last.sentOf('turn').length;
    relay!.close();
    relay = null;
    return asked;
  };
  expect(await turnsAsked(new FakeTransport())).toBeGreaterThan(0);
  expect(await turnsAsked(Object.assign(new FakeTransport(), { p2p: false }))).toBe(0);
});

test("the transport's fetch is called on the transport, so a method or the browser's own fetch works", async () => {
  forbidNetwork();
  const fake = new FakeTransport();
  const seen: unknown[] = [];
  const transport = {
    open: (url: string) => fake.open(url),
    fetch(this: unknown, url: string, init?: RequestInit) {
      seen.push(this);
      return fake.fetch(url, init);
    },
  };
  await connectThrough(transport, { lan: false });
  expect(seen).toEqual([transport]);
  // And over HTTP, while the socket is down.
  fake.auth = async (url) => (url.endsWith('/v1/moderate') ? { ok: true, status: 200, json: async () => ({ ok: true, value: 'Ada' }) } : new Promise(() => {}));
  FakeSocket.last.drop();
  await settle();
  await relay!.moderate('Ada');
  expect(seen.every((t) => t === transport)).toBe(true);
});

test('a transport whose open() throws: connect rejects with a GameRelayError, the cause kept', async () => {
  jest.useFakeTimers();
  const boom = new Error('no route');
  const transport = Object.assign(new FakeTransport(), {
    open: () => {
      throw boom;
    },
  });
  const err = await GameRelay.connect({ publicKey: 'gr_pub_test', url: 'https://gamerelay.io', transport, lan: false }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GameRelayError);
  expect((err as GameRelayError).code).toBe('disconnected');
  expect((err as Error & { cause?: unknown }).cause).toBe(boom);
});

test("moderate() while the socket is down asks over the transport's fetch", async () => {
  forbidNetwork();
  const transport = new FakeTransport();
  await connectThrough(transport, { lan: false });
  transport.auth = async (url) =>
    url.endsWith('/v1/moderate')
      ? { ok: true, status: 200, json: async () => ({ ok: true, value: 'Ada' }) }
      : new Promise(() => {}); // the reconnect's token request hangs: the socket stays down
  FakeSocket.last.drop();
  await settle();
  expect(relay!.connected).toBe(false);
  expect(await relay!.moderate(' Ada ')).toEqual({ ok: true, value: 'Ada' });
  expect(transport.fetched.at(-1)).toBe('https://gamerelay.io/v1/moderate');
});

test('any object with the socket shape works: a hand-written in-memory server', async () => {
  forbidNetwork();
  jest.useFakeTimers();
  const heard: string[] = [];
  let socket!: TransportSocket & { readyState: number };
  const transport: Transport = {
    open() {
      socket = {
        readyState: 0,
        onmessage: null,
        onclose: null,
        send(frame) {
          const opened = openFrame(frame);
          if (!opened) throw new Error('unsigned frame');
          const msg = JSON.parse(opened.body) as { t: string; ts?: number };
          heard.push(msg.t);
          if (msg.t === 'ping') queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ v: 1, t: 'pong', ts: msg.ts, serverTime: Date.now() }) }));
        },
        close() {
          this.readyState = 3;
        },
      };
      // Opened later, as a real socket is, with the server's welcome first.
      setTimeout(() => {
        socket.readyState = 1;
        const welcome = { v: 1, t: 'welcome', playerId: 'pa', features: {}, resumeGraceMs: LIMITS.resumeGraceMs, serverTime: Date.now(), k: maskKey([5, 6, 7, 8], 'pa') };
        socket.onmessage?.({ data: JSON.stringify(welcome) });
      }, 10);
      return socket;
    },
    fetch: tokenAnswer() as NonNullable<Transport['fetch']>,
  };
  const connecting = GameRelay.connect({ publicKey: 'gr_pub_test', url: 'https://gamerelay.io', transport, lan: false });
  await settle(); // the token, then the socket
  await advance(50); // its welcome
  relay = await connecting;
  expect(relay.connected).toBe(true);
  // The SDK's first clock ping goes out at once, signed with the welcome's key, and the pong comes back.
  await advance(50);
  expect(heard).toContain('ping');
  relay.close();
  expect(socket.readyState).toBe(3);
});
