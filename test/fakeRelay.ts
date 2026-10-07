import { jest } from 'bun:test';
import { LIMITS, TokenBucket } from '@gamerelay/protocol/limits';
import { maskKey, openFrame } from '@gamerelay/protocol/sign';
import type { RoomInfo } from '@gamerelay/protocol/types';
import { GameRelay } from '../src/index';

type Msg = { t: string; [key: string]: unknown };

/**
 * A stand-in for the browser's WebSocket, driven by the test: `welcome()` opens it, `deliver()`
 * plays a server message, `drop()` is the connection going away. It charges frames the way the
 * server does (a batch costs one token per message, and a frame it can't pay for is dropped whole).
 */
export class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  /** Every frame that reached the server, as sent (a batch stays a batch). */
  readonly frames: Msg[] = [];
  /** Frames the server's rate limit would have dropped. */
  readonly dropped: Msg[] = [];
  closedByClient = false;
  /** A live server answers pings (with its clock at `Date.now()`); false: the network under it is gone, or the test answers. */
  autoPong = true;
  #bucket = new TokenBucket(LIMITS.ratePerSecond, LIMITS.rateBurst, performance.now());

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  static get last(): FakeSocket {
    return FakeSocket.all[FakeSocket.all.length - 1]!;
  }

  send(frame: string): void {
    const opened = openFrame(frame);
    if (!opened) throw new Error('unsigned frame');
    const msg = JSON.parse(opened.body) as Msg;
    const cost = msg.t === 'batch' ? Math.max(1, (msg.m as unknown[]).length) : 1;
    this.attempts.push(...(msg.t === 'batch' ? (msg.m as Msg[]) : [msg]));
    const paid = this.#bucket.take(performance.now(), cost);
    (paid ? this.frames : this.dropped).push(msg);
    if (paid && msg.t === 'ping') setTimeout(() => this.autoPong && this.deliver({ t: 'pong', ts: msg.ts, serverTime: Date.now() }), 0);
  }

  close(): void {
    // A dead socket's close never completes in time: the SDK must not wait for this event.
    this.closedByClient = true;
    this.readyState = 2;
  }

  /** Everything that reached the server, batches flattened. */
  get messages(): Msg[] {
    return this.frames.flatMap((f) => (f.t === 'batch' ? (f.m as Msg[]) : [f]));
  }

  /** Everything the SDK sent, whether or not the rate limit let it through, in order. */
  readonly attempts: Msg[] = [];

  sentOf(t: string): Msg[] {
    return this.messages.filter((m) => m.t === t);
  }

  deliver(msg: Msg): void {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...msg }) });
  }

  /** `extra`: more welcome fields (`server`, `notices`, …). */
  welcome(playerId = 'pa', serverTime = Date.now(), extra: Record<string, unknown> = {}): void {
    this.readyState = 1;
    this.deliver({ t: 'welcome', playerId, features: {}, resumeGraceMs: LIMITS.resumeGraceMs, serverTime, k: maskKey([1, 2, 3, 4], playerId), ...extra });
  }

  /** Answer every ping sent so far that hasn't had its pong, as a server at `serverTime` would. */
  pong(serverTime: number, from = 0): void {
    for (const m of this.sentOf('ping').slice(from)) this.deliver({ t: 'pong', ts: m.ts, serverTime });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

export function roomInfo(me: string): RoomInfo {
  return {
    id: 'r1', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId: me, stateSeq: 0, chat: [], seed: 1, claims: {}, state: {},
    players: [{ id: me, name: me, avatar: null, joinedAt: 0, connected: true, slot: 0 }],
  };
}

/** Answer the last `t` request the way the server does when you enter a room: the snapshot, then the reply. */
export function answerRoom(socket: FakeSocket, t: string, me: string): void {
  const req = socket.sentOf(t).at(-1);
  if (!req) throw new Error(`no ${t} sent`);
  const room = roomInfo(me);
  socket.deliver({ t: 'room', room, you: me });
  socket.deliver({ t: 'reply', rid: req.rid, data: { roomId: room.id } });
}

/** Let promise chains (fetch, then the socket) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Move fake time forward, letting promise chains run between timers. */
export async function advance(ms: number, step = 50): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    jest.advanceTimersByTime(Math.min(step, ms - t));
    await settle();
  }
}

/** Just enough of `document` and `window` for the SDK's page listeners; `fire` plays an event. */
function fakePage() {
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    addEventListener: (type: string, fn: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
  };
  const document = { ...target, hidden: false, visibilityState: 'visible' };
  const fire = (type: string) => listeners.get(type)?.forEach((fn) => fn());
  return { document, window: target, fire, listeners };
}

/**
 * A connected GameRelay on fake timers and a fake socket and auth endpoint. Call `done()` at the end
 * of the test to close it and put the real globals back. `page`: a fake `document` and `window` too
 * (no rooms then: a room's tick loop would try a Worker).
 */
export async function connectFake(playerId = 'pa', { page = false } = {}) {
  jest.useFakeTimers();
  FakeSocket.all = [];
  const g = globalThis as unknown as { WebSocket: unknown; fetch: unknown; document?: unknown; window?: unknown };
  const saved = { WebSocket: g.WebSocket, fetch: g.fetch };
  const fake = page ? fakePage() : null;
  if (fake) {
    g.document = fake.document;
    g.window = fake.window;
  }
  g.WebSocket = FakeSocket;
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({ token: 'tok', expiresAt: Date.now() + 3_600_000 }) });
  const connecting = GameRelay.connect({ publicKey: 'gr_pub_test', url: 'http://test.local', lan: false });
  await settle();
  FakeSocket.last.welcome(playerId);
  const relay = await connecting;
  /** Wait for the SDK's reconnect to open a new socket, then welcome it. */
  const reopen = async (withinMs = 20_000): Promise<FakeSocket> => {
    const before = FakeSocket.all.length;
    for (let t = 0; t < withinMs && FakeSocket.all.length === before; t += 50) await advance(50);
    if (FakeSocket.all.length === before) throw new Error('no reconnect');
    FakeSocket.last.welcome(playerId);
    await settle();
    return FakeSocket.last;
  };
  const done = () => {
    relay.close();
    if (fake) {
      delete g.document;
      delete g.window;
    }
    g.WebSocket = saved.WebSocket;
    g.fetch = saved.fetch;
    jest.useRealTimers();
  };
  return { relay, socket: () => FakeSocket.last, reopen, done, page: fake };
}
