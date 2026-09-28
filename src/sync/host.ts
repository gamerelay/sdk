export type HealthMessage = { t: 'heartbeat' } | { t: 'step_down' } | { t: 'visibility'; hidden: boolean };
export interface HostHealthDeps {
  /** A local monotonic clock, ms. */
  now(): number;
  isHost(): boolean;
  send(message: HealthMessage): void;
  /** False while disconnected: nothing is sent (it would only pile up), and measuring starts over. */
  ready?(): boolean;
}

export const HEARTBEAT_MS = 250;
export const HEALTH_WINDOW_MS = 1500;
export const HEALTHY_SHARE = 0.75;
export const STEP_DOWN_COOLDOWN_MS = 5000;

/**
 * The host's side of host health: a heartbeat so the server notices a frozen or crashed host, and
 * a step-down when this tab can't keep its tick rate (a hidden Safari tab runs its loop at 4–7/s).
 * The thresholds live here, in the SDK, so tuning them needs no server deploy.
 */
export class HostHealth {
  readonly #d: HostHealthDeps;
  readonly #target: number;
  #wasHost = false;
  #lastBeat = Number.NEGATIVE_INFINITY;
  #windowStart = 0;
  #ticks = 0;
  #quietUntil = 0;
  #hidden: boolean | null = null;

  constructor(deps: HostHealthDeps, targetRate = 60) {
    this.#d = deps;
    this.#target = targetRate;
  }

  tick(): void {
    const now = this.#d.now();
    if (!(this.#d.ready?.() ?? true)) {
      this.#wasHost = false; // measure afresh once we're back
      return;
    }
    const host = this.#d.isHost();
    if (host && !this.#wasHost) {
      this.#windowStart = now;
      this.#ticks = 0;
    }
    this.#wasHost = host;
    if (!host) return;
    if (now - this.#lastBeat >= HEARTBEAT_MS) {
      this.#lastBeat = now;
      this.#d.send({ t: 'heartbeat' });
    }
    this.#ticks++;
    const span = now - this.#windowStart;
    if (span >= HEALTH_WINDOW_MS) {
      const rate = (this.#ticks * 1000) / span;
      if (rate < this.#target * HEALTHY_SHARE && now >= this.#quietUntil) {
        this.#quietUntil = now + STEP_DOWN_COOLDOWN_MS;
        this.#d.send({ t: 'step_down' });
      }
      this.#windowStart = now;
      this.#ticks = 0;
    }
  }

  visibility(hidden: boolean): void {
    if (hidden === this.#hidden) return;
    this.#hidden = hidden;
    this.#d.send({ t: 'visibility', hidden });
  }
}
