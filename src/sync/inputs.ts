import type { Json, PlayerId } from '@gamerelay/protocol/types';
import { GameRelayError } from '../errors';
import type { SyncTransport } from './transport';

/** Inputs go to the host at most this often… */
export const INPUT_SEND_MS = 50;
/** …and repeat this often when nothing changed, so they never look stale. */
export const INPUT_REPEAT_MS = 200;
/** A player silent this long reads as neutral input (no stuck keys). */
export const INPUT_STALE_MS = 500;
const MAX_INPUT_BYTES = 1024;
/** Presses the host holds for one player at once (see `receive`); more are shown as sent, not held. */
export const MAX_HELD_KEYS = 32;

type InputState = Record<string, Json>;
const EMPTY: Readonly<InputState> = Object.freeze({});
const utf8 = new TextEncoder();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The same keys at rest: booleans false, numbers 0, anything else kept. */
function neutral(state: InputState): Readonly<InputState> {
  const out: InputState = {};
  for (const [k, v] of Object.entries(state)) out[k] = typeof v === 'boolean' ? false : typeof v === 'number' ? 0 : v;
  return Object.freeze(out);
}

/**
 * Inputs for host-simulated games. Each player calls `set` every frame; the latest goes to the host
 * at most every 50 ms (and every 200 ms regardless). A key that was true at any point since the last
 * send goes out true, so taps between sends aren't lost; a send carrying a new press is reliable.
 * On the host, a press reads true for at least 50 ms after it arrives, even if its release arrives
 * right behind it. The host reads each player's latest with `get`, neutral once it's 500 ms old. A
 * page that stops calling `set` (a hidden tab: no animation frames) sends neutral once and goes quiet.
 */
export class Inputs {
  readonly #t: SyncTransport;
  readonly #tag = Math.random().toString(36).slice(2, 8);
  readonly #remote = new Map<PlayerId, { k: string; s: number; d: Readonly<InputState>; at: number; held: Map<string, number> }>();
  /** Keys pressed since the last send (and, on the host, within the last 50 ms): key → when. */
  readonly #latch = new Map<string, number>();
  #latest: InputState | null = null;
  #lastSent: InputState | null = null;
  #lastJson = '';
  #lastSendAt = Number.NEGATIVE_INFINITY;
  #lastSetAt = Number.NEGATIVE_INFINITY;
  #quiet = false;
  #seq = 0;
  #force = false;

  constructor(t: SyncTransport) {
    this.#t = t;
  }

  set(state: Record<string, Json>): void {
    if (!isObj(state)) throw new GameRelayError('bad_request', 'room.input(state): state must be a plain object like { left: true, ax: 0.5 }');
    let json: string | undefined;
    try {
      json = JSON.stringify(state);
    } catch {
      json = undefined;
    }
    if (json === undefined) throw new GameRelayError('bad_request', 'room.input(state): state must be JSON (booleans, numbers, strings)');
    if (utf8.encode(json).byteLength > MAX_INPUT_BYTES) {
      throw new GameRelayError('too_large', 'room.input: keep inputs small (under 1 KB): buttons and axes, not game state');
    }
    this.#latest = JSON.parse(json) as InputState;
    const now = this.#t.now();
    this.#lastSetAt = now;
    this.#quiet = false;
    for (const [k, v] of Object.entries(this.#latest)) if (v === true && !this.#latch.has(k)) this.#latch.set(k, now);
  }

  get(id: PlayerId): Readonly<InputState> {
    if (id === this.#t.me) return this.#current() ?? EMPTY;
    const rec = this.#remote.get(id);
    if (!rec) return EMPTY;
    const now = this.#t.now();
    if (now - rec.at > INPUT_STALE_MS) return neutral(rec.d);
    let out: InputState | null = null;
    for (const [k, until] of rec.held) {
      if (until <= now || rec.d[k] === true) continue;
      out ??= { ...rec.d };
      out[k] = true;
    }
    return out ? Object.freeze(out) : rec.d;
  }

  tick(): void {
    if (!(this.#t.ready?.() ?? true)) return;
    const now = this.#t.now();
    const host = this.#t.hostId?.() ?? '';
    if (host === this.#t.me) {
      // Our own presses last 50 ms from the press here too, so a 20 Hz host loop sees every tap.
      for (const [k, at] of this.#latch) if (now - at >= INPUT_SEND_MS) this.#latch.delete(k);
      return;
    }
    const cur = this.#current();
    if (!cur || !host || this.#quiet) return;
    if (now - this.#lastSetAt > INPUT_STALE_MS) {
      // Nobody's calling input() (a hidden tab has no animation frames): let go of every key, once.
      this.#t.send({ $gr: 'i', k: this.#tag, s: ++this.#seq, d: neutral(this.#latest!) } as unknown as Json, { to: host, reliable: true });
      this.#quiet = true;
      this.#lastSent = null;
      this.#lastJson = '';
      this.#latch.clear();
      return;
    }
    if (!this.#force && now - this.#lastSendAt < INPUT_SEND_MS) return;
    const json = JSON.stringify(cur);
    if (!this.#force && json === this.#lastJson && now - this.#lastSendAt < INPUT_REPEAT_MS) return;
    const pressed = Object.entries(cur).some(([k, v]) => v === true && this.#lastSent?.[k] !== true);
    this.#t.send({ $gr: 'i', k: this.#tag, s: ++this.#seq, d: cur } as unknown as Json, { to: host, reliable: pressed });
    this.#lastSent = cur;
    this.#lastJson = json;
    this.#lastSendAt = now;
    this.#force = false;
    this.#latch.clear();
  }

  /** `$gr: 'i'`: a player's input (kept only on the host); false for anything else. */
  receive(data: unknown, from: PlayerId): boolean {
    if (!isObj(data) || data.$gr !== 'i') return false;
    if (this.#t.hostId?.() !== this.#t.me || !isObj(data.d) || typeof data.s !== 'number' || typeof data.k !== 'string') return true;
    const rec = this.#remote.get(from);
    if (rec && rec.k === data.k && data.s <= rec.s) return true; // an older one, late
    const now = this.#t.now();
    const d = Object.freeze(data.d as InputState);
    const held = rec?.held ?? new Map<string, number>();
    // Presses that have shown for their interval are done: a player cycling through key names
    // mustn't grow the host's memory.
    for (const [k, until] of held) if (until <= now) held.delete(k);
    // A press shows for at least one send interval, even if its release arrives right behind it.
    for (const [k, v] of Object.entries(d)) {
      if (v !== true || rec?.d[k] === true) continue;
      if (held.size >= MAX_HELD_KEYS && !held.has(k)) continue; // no real pad has this many buttons down at once
      held.set(k, now + INPUT_SEND_MS);
    }
    this.#remote.set(from, { k: data.k, s: data.s, d, at: now, held });
    return true;
  }

  /** A new host has none of our input yet: send on the next tick. */
  hostChanged(): void {
    this.#force = true;
  }

  playerLeft(id: PlayerId): void {
    this.#remote.delete(id);
  }

  #current(): InputState | null {
    if (!this.#latest) return null;
    if (this.#latch.size === 0) return this.#latest;
    const out = { ...this.#latest };
    for (const k of this.#latch.keys()) out[k] = true;
    return out;
  }
}
