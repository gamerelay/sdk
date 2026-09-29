export interface DelayOptions {
  minMs?: number;
  maxMs?: number;
}

/**
 * How far behind server time to render other players' entities: the typical age of a sample when it
 * arrives, plus one send interval, plus 3× the variation in that age. Moves gradually (after the
 * first sample) so the render timeline never jumps.
 */
export class DelayEstimator {
  readonly #min: number;
  readonly #max: number;
  #mean = 0;
  #dev = 0;
  #delay = 100;
  #seen = false;

  constructor({ minMs = 60, maxMs = 500 }: DelayOptions = {}) {
    this.#min = minMs;
    this.#max = maxMs;
  }

  /** Whether any sample has come in (until then, `ms` is a default guess). */
  get sampled(): boolean {
    return this.#seen;
  }

  get ms(): number {
    return this.#delay;
  }

  observe(ageMs: number, intervalMs: number): void {
    if (!this.#seen) {
      this.#seen = true;
      this.#mean = ageMs;
      this.#delay = this.#target(intervalMs);
      return;
    }
    this.#dev += (Math.abs(ageMs - this.#mean) - this.#dev) * 0.1;
    this.#mean += (ageMs - this.#mean) * 0.1;
    this.#delay += (this.#target(intervalMs) - this.#delay) * 0.05;
  }

  #target(intervalMs: number): number {
    return Math.min(this.#max, Math.max(this.#min, this.#mean + intervalMs + 3 * this.#dev));
  }
}
