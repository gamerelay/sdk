import type { JsonObject } from '@gamerelay/protocol/types';
import { GameRelayError } from '../errors';

export const TIMERS_KEY = '$timers';
const NAME = /^[A-Za-z][\w:.-]{0,63}$/;
const bad = (message: string) => new GameRelayError('bad_request', message);

export interface TimerDeps {
  /** Server clock, ms (`relay.now()`). */
  now(): number;
  isHost(): boolean;
  state(): JsonObject;
  setState(patch: JsonObject): void;
  /** Run the game's handlers for a timer that fell due (host only). */
  fire(name: string): void;
  /** False while disconnected: a timer fired offline would fire again once state resyncs. */
  ready?(): boolean;
  /** Run `fn` with every `setState` inside merged into one patch (so effects and the clear land together). */
  batch?(fn: () => void): void;
}

/**
 * Timers as deadlines on the server clock, stored in `room.state` so they outlive the host that set
 * them. The host fires each due timer once and clears it in the same batch as the handlers' own
 * `setState` changes, so a new host sees a timer either pending or gone with its effects, never half.
 */
export class Timers {
  readonly #d: TimerDeps;
  #firing = false;
  /** Due timers whose handlers have run, this pass. */
  readonly #fired = new Set<string>();
  /** …and those set again after that: kept even if the new deadline is due already. */
  readonly #rearmed = new Set<string>();

  constructor(deps: TimerDeps) {
    this.#d = deps;
  }

  #all(): Record<string, number> {
    const raw = this.#d.state()[TIMERS_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, number>) : {};
  }

  set(name: string, ms: number): void {
    if (!this.#d.isHost()) throw new GameRelayError('not_host', `room.timer('${name}'): only the host can start timers; check room.isHost`);
    if (typeof name !== 'string' || !NAME.test(name)) throw bad(`room.timer: '${name}' isn't a valid timer name (a letter, then letters, digits, _ : . -)`);
    if (!(Number.isFinite(ms) && ms >= 0)) throw bad(`room.timer('${name}', ms): ms must be a number of milliseconds, 0 or more`);
    this.#d.setState({ [TIMERS_KEY]: { ...this.#all(), [name]: Math.round(this.#d.now() + ms) } });
    if (this.#firing && this.#fired.has(name)) this.#rearmed.add(name);
  }

  clear(name: string): void {
    if (!this.#d.isHost()) throw new GameRelayError('not_host', `room.clearTimer('${name}'): only the host can clear timers`);
    const { [name]: _gone, ...rest } = this.#all();
    void _gone;
    this.#d.setState({ [TIMERS_KEY]: rest });
  }

  /**
   * True while due timers' handlers run. The room sends everything they send as host-only, so if the
   * server has already replaced this host, it drops those sends along with the rejected clear, and
   * the new host fires the timer once, for everyone.
   */
  get firing(): boolean {
    return this.#firing;
  }

  /** Milliseconds until `name` falls due (0 once due), or null if there's no such timer. */
  left(name: string): number | null {
    const at = this.#all()[name];
    return typeof at === 'number' ? Math.max(0, at - this.#d.now()) : null;
  }

  tick(): void {
    if (!this.#d.isHost() || !(this.#d.ready?.() ?? true)) return;
    const all = this.#all();
    const now = this.#d.now();
    const due = Object.keys(all).filter((k) => typeof all[k] === 'number' && all[k]! <= now);
    if (due.length === 0) return;
    const run = () => {
      this.#firing = true;
      this.#fired.clear();
      this.#rearmed.clear();
      try {
        for (const name of due) {
          // An earlier handler may have cleared it, or set it again for later.
          const at = this.#all()[name];
          if (!(typeof at === 'number' && at <= now)) continue;
          this.#fired.add(name);
          try {
            this.#d.fire(name);
          } catch (err) {
            console.error('[gamerelay] timer handler error', err);
          }
        }
      } finally {
        this.#firing = false;
      }
      const rest = { ...this.#all() }; // handlers may have set new timers
      // Each timer that fired is cleared, unless set again after its handler ran (by name: set for
      // 0 ms within the same millisecond, its deadline is the one that just fell due). One an
      // earlier handler cleared or put off didn't fire and is left as that handler made it.
      for (const name of this.#fired) if (!this.#rearmed.has(name)) delete rest[name];
      this.#fired.clear();
      this.#rearmed.clear();
      this.#d.setState({ [TIMERS_KEY]: rest });
    };
    if (this.#d.batch) this.#d.batch(run);
    else run();
  }
}
