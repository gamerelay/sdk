import type { Json, PlayerId } from '@gamerelay/protocol/types';
import type { Warn } from '../debug/warnings';
import { GameRelayError } from '../errors';
import { EVENT_NAME, RESERVED_EVENTS, checkJson } from './messages';
import type { SyncTransport } from './transport';

export const REQUEST_TIMEOUT_MS = 5000;

/** Thrown from an `onRequest` handler (`throw room.reject('why')`) to refuse with a reason. */
export class RequestRejection {
  constructor(readonly reason: string) {}
}

export type RequestHandler = (data: Json, from: PlayerId) => Json | undefined | Promise<Json | undefined>;

type Answer = { d: Json } | { e: string };

interface Pending {
  type: string;
  key: string;
  /** The host we asked: only its answer counts. */
  host: PlayerId;
  at: number;
  resolve: (value: Json) => void;
  reject: (err: GameRelayError) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkName(where: string, type: unknown): asserts type is string {
  if (typeof type !== 'string' || !EVENT_NAME.test(type)) {
    throw new GameRelayError('bad_request', `${where}: '${String(type)}' isn't a valid request name (a letter, then letters, digits, _ : . -, max 64)`);
  }
  if (RESERVED_EVENTS.has(type)) throw new GameRelayError('bad_request', `${where}: '${type}' is reserved for built-in events; pick another name`);
}

/**
 * Requests to the host: `room.request(type, data)` sends `{ $gr: 'q' }` to the host, whose
 * `onRequest` handler answers `{ $gr: 'a' }` host-only (so a replaced host's answers are dropped by
 * the server). The caller rejects if the host changes first or doesn't answer in 5 s.
 */
export class Requests {
  readonly #t: SyncTransport;
  readonly #warn: Warn;
  readonly #handlers = new Map<string, RequestHandler>();
  readonly #pending = new Map<string, Pending>();
  readonly #byKey = new Map<string, Promise<Json>>();
  readonly #tag = Math.random().toString(36).slice(2, 8);
  #seq = 0;

  constructor(t: SyncTransport, warn: Warn) {
    this.#t = t;
    this.#warn = warn;
  }

  request(type: string, data: Json): Promise<Json> {
    const where = `room.request('${type}')`;
    checkName('room.request', type);
    const json = checkJson(where, data);
    const key = `${type}\u0000${json}`;
    const waiting = this.#byKey.get(key);
    if (waiting) {
      this.#warn('request', `request:${type}`, `${where} repeated while the first is still waiting: you get the same answer; await the first call instead`);
      return waiting;
    }
    const body = JSON.parse(json) as Json;
    const host = this.#t.hostId?.() ?? '';
    let promise: Promise<Json>;
    if (host === this.#t.me) {
      promise = this.#run(type, body, this.#t.me).then((a) => ('e' in a ? Promise.reject(new GameRelayError('rejected', a.e)) : a.d));
    } else {
      const i = `${this.#tag}:${++this.#seq}`;
      promise = new Promise<Json>((resolve, reject) => {
        this.#pending.set(i, { type, key, host, at: this.#t.now(), resolve, reject });
      });
      this.#t.send({ $gr: 'q', i, n: type, d: body } as unknown as Json, { to: host, reliable: true });
    }
    this.#byKey.set(key, promise);
    const forget = () => {
      if (this.#byKey.get(key) === promise) this.#byKey.delete(key);
    };
    promise.then(forget, forget);
    return promise;
  }

  onRequest(type: string, handler: RequestHandler): () => void {
    checkName('room.onRequest', type);
    this.#handlers.set(type, handler);
    return () => {
      if (this.#handlers.get(type) === handler) this.#handlers.delete(type);
    };
  }

  /** `$gr: 'q'` (a request, on the host) or `$gr: 'a'` (an answer); false for anything else. */
  receive(data: unknown, from: PlayerId): boolean {
    if (!isObj(data) || (data.$gr !== 'q' && data.$gr !== 'a') || typeof data.i !== 'string') return false;
    if (data.$gr === 'q') {
      // Sent to us while we were host, arriving after the handover: the caller already has
      // host_changed and will ask the new host. Running the handler here would grant it twice.
      if (typeof data.n !== 'string' || this.#t.hostId?.() !== this.#t.me) return true;
      const i = data.i;
      void this.#run(data.n, (data.d ?? null) as Json, from).then((a) => {
        const body = 'e' in a ? { $gr: 'a', i, e: a.e } : { $gr: 'a', i, ok: 1, d: a.d };
        this.#t.send(body as unknown as Json, { to: from, reliable: true, host: true });
      });
      return true;
    }
    const p = this.#pending.get(data.i);
    if (!p || p.host !== from) return true;
    this.#pending.delete(data.i);
    if (typeof data.e === 'string') p.reject(new GameRelayError('rejected', data.e));
    else p.resolve((data.d ?? null) as Json);
    return true;
  }

  /** Time out requests older than 5 s. */
  tick(): void {
    const now = this.#t.now();
    for (const [i, p] of this.#pending) {
      if (now - p.at < REQUEST_TIMEOUT_MS) continue;
      this.#fail(i, 'timeout', `room.request('${p.type}'): no answer from the host in 5 s; does the host call room.onRequest('${p.type}', …)?`);
    }
  }

  /** Reject everything waiting on the old host. */
  hostChanged(): void {
    for (const [i, p] of this.#pending) this.#fail(i, 'host_changed', `room.request('${p.type}'): the host changed before answering; try again`);
  }

  close(): void {
    for (const [i, p] of this.#pending) this.#fail(i, 'disconnected', `room.request('${p.type}'): you left the room before the host answered`);
  }

  #fail(i: string, code: 'timeout' | 'host_changed' | 'disconnected', message: string): void {
    const p = this.#pending.get(i);
    if (!p) return;
    this.#pending.delete(i);
    p.reject(new GameRelayError(code, message));
  }

  async #run(type: string, data: Json, from: PlayerId): Promise<Answer> {
    const handler = this.#handlers.get(type);
    if (!handler) return { e: `the host has no room.onRequest('${type}', …) handler` };
    try {
      const result = await handler(data, from);
      // `return room.reject('why')` refuses too: the natural guess, and resolving with `{ reason }` would be a silent bug.
      if (result instanceof RequestRejection) return { e: result.reason };
      const json = JSON.stringify(result ?? null) as string | undefined;
      if (json === undefined) return { e: `the host's room.onRequest('${type}') handler returned something that isn't JSON` };
      return { d: JSON.parse(json) as Json };
    } catch (err) {
      if (err instanceof RequestRejection) return { e: err.reason };
      console.error(`[gamerelay] room.onRequest('${type}') handler error`, err);
      return { e: `the host's room.onRequest('${type}') handler threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
