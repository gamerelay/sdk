import { LIMITS } from '@gamerelay/protocol/limits';
import { Rate } from '../debug/rate';
import type { Warn } from '../debug/warnings';
import type { Json, PlayerId } from '@gamerelay/protocol/types';
import { GameRelayError } from '../errors';
import type { SyncTransport } from './transport';

/** Built-in room event names: games can't emit these. */
export const RESERVED_EVENTS = new Set([
  'message',
  'seed',
  'player_joined',
  'player_left',
  'player_disconnected',
  'player_reconnected',
  'host_changed',
  'state',
  'chat',
  'closed',
  'spawn',
  'remove',
  'host',
  'timer',
  'claimed',
  'released',
]);
const NAME = /^[A-Za-z][\w:.-]{0,63}$/;
const RATE_WARN = 30;

export type Deliver = (type: string, data: Json, from: PlayerId, meta: { at: number }) => void;

/** `data` as JSON text, or a throw that says what's wrong (not JSON, or over the message limit). */
export function checkJson(where: string, data: Json): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(data ?? null);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw new GameRelayError('bad_request', `${where}: data must be JSON (objects, arrays, numbers, strings, booleans, null)`);
  }
  if (new TextEncoder().encode(json).byteLength > LIMITS.maxMessageBytes - 512) {
    throw new GameRelayError(
      'too_large',
      `${where}: data is over ${Math.floor(LIMITS.maxMessageBytes / 1024)} KB; for big or fast-changing data use room.define + room.spawn`,
    );
  }
  return json;
}

export const EVENT_NAME = NAME;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class Messages {
  readonly #t: SyncTransport;
  readonly #deliver: Deliver;
  readonly #warn: Warn;
  readonly #rates = new Map<string, Rate>();

  constructor(t: SyncTransport, deliver: Deliver, warn: Warn = () => {}) {
    this.#t = t;
    this.#deliver = deliver;
    this.#warn = warn;
  }

  emit(type: string, data: Json, options: { to?: PlayerId; echo?: boolean } = {}): void {
    if (typeof type !== 'string' || !NAME.test(type)) {
      throw new GameRelayError('bad_request', `room.emit: '${type}' isn't a valid event name (a letter, then letters, digits, _ : . -, max 64)`);
    }
    if (RESERVED_EVENTS.has(type)) throw new GameRelayError('bad_request', `room.emit('${type}'): that name is reserved for built-in events; pick another`);
    const json = checkJson(`room.emit('${type}')`, data);
    this.#count(type);
    const toSelf = options.to === this.#t.me;
    if (!toSelf) this.#t.send({ $gr: 'e', n: type, d: data ?? null } as unknown as Json, { to: options.to, reliable: true });
    if ((options.echo ?? true) && (options.to === undefined || toSelf)) {
      this.#deliver(type, JSON.parse(json) as Json, this.#t.me, { at: this.#t.now() });
    }
  }

  receive(data: unknown, from: PlayerId, at: number): boolean {
    if (!isObj(data) || data.$gr !== 'e') return false;
    if (typeof data.n === 'string' && !RESERVED_EVENTS.has(data.n)) this.#deliver(data.n, (data.d ?? null) as Json, from, { at });
    return true;
  }

  #count(type: string): void {
    let rate = this.#rates.get(type);
    if (!rate) this.#rates.set(type, (rate = new Rate(RATE_WARN)));
    if (rate.hit(this.#t.now())) {
      this.#warn(
        'emit',
        `emit:${type}`,
        `room.emit('${type}') more than ${RATE_WARN}×/s: events are for moments; for things that change every frame use room.define + room.spawn`,
      );
    }
  }
}
