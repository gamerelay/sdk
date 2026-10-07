/**
 * The client side of SDK_PLAN.md §1–4: the SDK says what it is and what it handles, connects
 * where the token response says (only to GameRelay hosts), shows the server's notices once, and
 * follows a restart notice's `url`.
 */
import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import { GameRelay, type ConnectOptions } from '../src/index';
import { followable } from '../src/core/hosts';
import { SDK_VERSION } from '../src/version';
import { advance, FakeSocket, settle } from './fakeRelay';
import pkg from '../package.json';

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

/** Connect against a fake auth endpoint answering `tokenBody`, and welcome the socket with `welcome`. */
async function connect(options: Partial<ConnectOptions>, tokenBody: Record<string, unknown> = {}, welcome: Record<string, unknown> = {}) {
  jest.useFakeTimers();
  FakeSocket.all = [];
  g.WebSocket = FakeSocket;
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({ token: 'tok', expiresAt: Date.now() + 3_600_000, ...tokenBody }) });
  const connecting = GameRelay.connect({ publicKey: 'gr_pub_test', url: 'https://gamerelay.io', lan: false, ...options });
  await settle();
  const socket = FakeSocket.last;
  socket.welcome('pa', Date.now(), welcome);
  relay = await connecting;
  return { relay, socket };
}

test('the version in src/version.ts is the one in package.json', () => {
  expect(SDK_VERSION).toBe(pkg.version);
  expect(GameRelay.version).toBe(pkg.version);
});

test('the socket URL says which SDK this is and what it handles', async () => {
  const { socket } = await connect({});
  const url = new URL(socket.url);
  expect(url.searchParams.get('sdk')).toBe(`js/${SDK_VERSION}`);
  expect(url.searchParams.get('caps')?.split(',')).toEqual(['compact', 'moved', 'notices']);
  // The old flags too, for servers from before caps (until alpha.7).
  expect(url.searchParams.get('compact')).toBe('1');
});

test('it connects where the token response says', async () => {
  const { socket } = await connect({}, { wsUrl: 'wss://kc.gamerelay.io/ws' });
  expect(socket.url.startsWith('wss://kc.gamerelay.io/ws?token=tok&')).toBe(true);
});

test('getToken may return the whole token response, wsUrl included', async () => {
  const { socket } = await connect({ publicKey: undefined, getToken: async () => ({ token: 'from-backend', expiresAt: 0, wsUrl: 'wss://eu.gamerelay.io/ws' }) });
  expect(socket.url.startsWith('wss://eu.gamerelay.io/ws?token=from-backend&')).toBe(true);
});

test('a wsUrl on someone else’s host is ignored, with a warning', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const { socket } = await connect({}, { wsUrl: 'wss://evil.example/ws' });
  expect(socket.url.startsWith('wss://gamerelay.io/ws?')).toBe(true);
  expect(warn.mock.calls.some((c) => String(c[0]).includes('evil.example'))).toBe(true);
  warn.mockRestore();
});

test('server notices print once per code, from welcome or later; serverInfo has the server version', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const { relay, socket } = await connect({}, {}, { server: '1.2.3', notices: [{ code: 'sdk_deprecated', message: 'This SDK is old', until: '2026-12-01', url: 'https://gamerelay.io/docs#versions' }] });
  socket.deliver({ t: 'notice', notice: { code: 'sdk_deprecated', message: 'This SDK is old' } });
  socket.deliver({ t: 'notice', notice: { code: 'other', message: 'Something else' } });
  const printed = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('This SDK is old'));
  expect(printed).toHaveLength(1);
  expect(printed[0]).toContain('until 2026-12-01');
  expect(printed[0]).toContain('https://gamerelay.io/docs#versions');
  expect(warn.mock.calls.some((c) => String(c[0]).includes('Something else'))).toBe(true);
  expect(relay.serverInfo).toEqual({ version: '1.2.3' });
  warn.mockRestore();
});

test('a restart notice’s url wins over the token’s wsUrl, even when getToken runs again', async () => {
  const { socket } = await connect({ publicKey: undefined, getToken: async () => ({ token: 't', wsUrl: 'wss://gamerelay.io/ws' }) });
  socket.deliver({ t: 'server_restarting', reconnectInMs: 100, url: 'wss://sf.gamerelay.io/ws' });
  socket.drop(1012);
  for (let t = 0; t < 5_000 && FakeSocket.all.length === 1; t += 50) await advance(50);
  expect(FakeSocket.last.url.startsWith('wss://sf.gamerelay.io/ws?')).toBe(true);
});

test('a moved-to host that doesn’t answer: the next try is the base URL', async () => {
  const { socket } = await connect({});
  socket.deliver({ t: 'server_restarting', reconnectInMs: 100, url: 'wss://sf.gamerelay.io/ws' });
  socket.drop(1012);
  for (let t = 0; t < 5_000 && FakeSocket.all.length === 1; t += 50) await advance(50);
  const dead = FakeSocket.last;
  expect(dead.url.startsWith('wss://sf.gamerelay.io/ws?')).toBe(true);
  dead.drop(1006); // never welcomed
  for (let t = 0; t < 20_000 && FakeSocket.all.length === 2; t += 50) await advance(50);
  expect(FakeSocket.last.url.startsWith('wss://gamerelay.io/ws?')).toBe(true);
});

test('notices: no doubled full stop, and ones without a code still each show', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const { socket } = await connect({});
  socket.deliver({ t: 'notice', notice: { message: 'First thing.' } });
  socket.deliver({ t: 'notice', notice: { message: 'Second thing!' } });
  const printed = warn.mock.calls.map((c) => String(c[0]));
  expect(printed.some((m) => m.includes('First thing.') && !m.includes('First thing..'))).toBe(true);
  expect(printed.some((m) => m.includes('Second thing.'))).toBe(true);
  warn.mockRestore();
});

test('a restart notice with a url moves the next connection there, same token', async () => {
  const { socket } = await connect({});
  socket.deliver({ t: 'server_restarting', reconnectInMs: 100, url: 'wss://sf.gamerelay.io/ws' });
  socket.drop(1012);
  for (let t = 0; t < 5_000 && FakeSocket.all.length === 1; t += 50) await advance(50);
  expect(FakeSocket.last.url.startsWith('wss://sf.gamerelay.io/ws?token=tok&')).toBe(true);
});

test('followable: GameRelay hosts and the same site only, wss under https, the /ws path', () => {
  const base = 'https://gamerelay.io';
  expect(followable('wss://gamerelay.io/ws', base)).toBe(true);
  expect(followable('wss://eu-1.gamerelay.io/ws', base)).toBe(true);
  expect(followable('ws://gamerelay.io/ws', base)).toBe(false); // downgrade
  expect(followable('wss://gamerelay.io.evil.example/ws', base)).toBe(false);
  expect(followable('wss://evilgamerelay.io/ws', base)).toBe(false);
  expect(followable('wss://gamerelay.io/other', base)).toBe(false);
  expect(followable('wss://user:pw@gamerelay.io/ws', base)).toBe(false);
  expect(followable('https://gamerelay.io/ws', base)).toBe(false);
  expect(followable('not a url', base)).toBe(false);
  // A self-hosted or dev server: exactly its own host and port, never "the same site".
  expect(followable('ws://127.0.0.1:8787/ws', 'http://127.0.0.1:8787')).toBe(true);
  expect(followable('ws://localhost:8787/ws', 'http://localhost:5173')).toBe(false); // around a dev proxy
  expect(followable('ws://192.168.1.4:8787/ws', 'http://127.0.0.1:8787')).toBe(false);
  expect(followable('wss://mygame.dev/ws', 'https://mygame.dev')).toBe(true);
  expect(followable('wss://ws.mygame.dev/ws', 'https://api.mygame.dev')).toBe(false);
  expect(followable('wss://evil.fly.dev/ws', 'https://myrelay.fly.dev')).toBe(false);
  expect(followable('wss://attacker.co.uk/ws', 'https://api.mygame.co.uk')).toBe(false);
});
