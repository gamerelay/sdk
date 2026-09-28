import type { Json, PlayerInfo } from '@gamerelay/protocol/types';
import { seededRandom } from '../src/index';
import type { SyncTransport } from '../src/sync/transport';

export interface NetOptions {
  /** Round trip, ms (half each way). */
  latency?: number;
  /** ± ms per message per direction. */
  jitter?: number;
  /** Share of `reliable: false` messages dropped. */
  loss?: number;
  /** Share of messages delivered twice (a retransmit or a buggy proxy). */
  duplicate?: number;
  seed?: number;
}

export interface JoinOptions {
  /** This player's estimate of server time is off by this many ms (clock skew). */
  clockOffset?: number;
}

type Handler = (data: Json, from: string, at: number) => void;
interface Queued {
  deliverAt: number;
  seq: number;
  to: string;
  from: string;
  at: number;
  data: Json;
}

/**
 * A deterministic stand-in for the relay: one ordered socket per player, the server stamps `at` on
 * receipt, unreliable messages can be lost. Time only moves when a test calls `advanceTo`.
 */
export class FakeNet {
  now = 0;
  /** The room's current host, as the server would say (`host_changed`). */
  host = '';
  readonly sent: { from: string; to?: string; reliable: boolean; host: boolean; data: Json }[] = [];
  readonly #opts: NetOptions;
  readonly #rand: () => number;
  readonly #handlers = new Map<string, Handler>();
  readonly #players = new Map<string, PlayerInfo>();
  readonly #lastAt = new Map<string, number>();
  readonly #lastDeliver = new Map<string, number>();
  #queue: Queued[] = [];
  #seq = 0;
  readonly #blackouts: [number, number][] = [];

  constructor(opts: NetOptions = {}) {
    this.#opts = opts;
    this.#rand = seededRandom(opts.seed ?? 1);
  }

  join(id: string, name: string, onMessage: Handler, opts: JoinOptions = {}): SyncTransport {
    this.#players.set(id, { id, name, avatar: null, joinedAt: this.now, connected: true, slot: this.#players.size });
    this.#handlers.set(id, onMessage);
    const offset = opts.clockOffset ?? 0;
    return {
      me: id,
      now: () => this.now + offset,
      player: (p) => this.#players.get(p),
      hostId: () => this.host,
      send: (data, o) => this.#send(id, data, o),
    };
  }

  /** Mark a player connected or not, as the server would tell everyone. */
  setConnected(id: string, connected: boolean): void {
    const p = this.#players.get(id);
    if (p) this.#players.set(id, { ...p, connected });
  }

  /** Drop every unreliable message sent between these times (a burst of loss). */
  blackout(from: number, to: number): void {
    this.#blackouts.push([from, to]);
  }

  leave(id: string): void {
    this.#handlers.delete(id);
    this.#players.delete(id);
  }

  #oneWay(): number {
    const { latency = 0, jitter = 0 } = this.#opts;
    return Math.max(0, latency / 2 + (this.#rand() * 2 - 1) * jitter);
  }

  #send(from: string, data: Json, o: { to?: string; reliable: boolean; host?: boolean }): void {
    this.sent.push({ from, to: o.to, reliable: o.reliable, host: o.host === true, data });
    if (o.host && from !== this.host) return; // the server drops a replaced host's host-only writes
    if (!o.reliable && this.#rand() < (this.#opts.loss ?? 0)) return;
    if (!o.reliable && this.#blackouts.some(([a, b]) => this.now >= a && this.now < b)) return;
    const at = Math.max(this.now + this.#oneWay(), this.#lastAt.get(from) ?? 0);
    this.#lastAt.set(from, at);
    for (const to of this.#handlers.keys()) {
      if (to === from || (o.to !== undefined && o.to !== to)) continue;
      const deliverAt = Math.max(at + this.#oneWay(), this.#lastDeliver.get(to) ?? 0);
      this.#lastDeliver.set(to, deliverAt);
      this.#queue.push({ deliverAt, seq: this.#seq++, to, from, at, data: JSON.parse(JSON.stringify(data)) });
      if (this.#rand() < (this.#opts.duplicate ?? 0)) {
        this.#queue.push({ deliverAt, seq: this.#seq++, to, from, at, data: JSON.parse(JSON.stringify(data)) });
      }
    }
  }

  /** Move time to `t`, delivering everything due, in order. */
  advanceTo(t: number): void {
    this.#queue.sort((a, b) => a.deliverAt - b.deliverAt || a.seq - b.seq);
    while (this.#queue.length > 0 && this.#queue[0]!.deliverAt <= t) {
      const m = this.#queue.shift()!;
      this.now = Math.max(this.now, m.deliverAt);
      this.#handlers.get(m.to)?.(m.data, m.from, m.at);
    }
    this.now = t;
  }

  /** Messages of the SDK's entity channel sent by `from`. */
  updates(from: string): { to?: string; reliable: boolean; host: boolean; t: number; e: [string, number, Json[], string?][] }[] {
    return this.sent
      .filter((m) => m.from === from && (m.data as { $gr?: string } | null)?.$gr === 'u')
      .map((m) => ({ to: m.to, reliable: m.reliable, host: m.host, ...(m.data as { t: number; e: [string, number, Json[], string?][] }) }));
  }
}
