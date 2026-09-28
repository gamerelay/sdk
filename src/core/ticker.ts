import { GameRelayError } from '../errors';

export type Scheduler = (intervalMs: number, wake: () => void) => () => void;

export const intervalScheduler: Scheduler = (ms, wake) => {
  const h = setInterval(wake, ms);
  return () => clearInterval(h);
};

const WORKER_SOURCE = 'let h;onmessage=(e)=>{clearInterval(h);h=setInterval(()=>postMessage(0),e.data)}';

/**
 * A timer in a worker: hidden tabs throttle page timers to about once a second, but not workers
 * (measured 2026-09-27, docs/NETCODE-AUDIT.md). Falls back to setInterval, and says so, when a page's
 * security policy blocks workers.
 */
export function workerScheduler(onFallback: () => void): Scheduler {
  return (ms, wake) => {
    let stop: () => void = () => {};
    const fallback = () => {
      onFallback();
      stop = intervalScheduler(ms, wake);
    };
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      const worker = new Worker(url);
      worker.onmessage = () => wake();
      worker.onerror = (e) => {
        e.preventDefault();
        worker.terminate();
        URL.revokeObjectURL(url);
        fallback();
      };
      worker.postMessage(ms);
      stop = () => {
        worker.terminate();
        URL.revokeObjectURL(url);
      };
    } catch {
      fallback();
    }
    return () => stop();
  };
}

export function pickScheduler(onFallback: () => void): Scheduler {
  return typeof document !== 'undefined' && typeof Worker === 'function' ? workerScheduler(onFallback) : intervalScheduler;
}

export const MAX_CATCH_UP = 5;

interface Loop {
  step: number;
  fn: (dt: number, tick: number) => void;
  acc: number;
  tick: number;
}

/** Fixed-step loops on one timer. `dt` is in seconds and never changes for a loop. */
export class Ticker {
  readonly #now: () => number;
  readonly #schedule: Scheduler;
  readonly #wakeMs: number;
  readonly #loops = new Set<Loop>();
  #stop: (() => void) | null = null;
  #last = 0;
  #stepAt: number | null = null;

  constructor({ now = () => performance.now(), schedule = intervalScheduler, wakeMs = 1000 / 60 }: { now?: () => number; schedule?: Scheduler; wakeMs?: number } = {}) {
    this.#now = now;
    this.#schedule = schedule;
    this.#wakeMs = wakeMs;
  }

  add(rate: number, fn: (dt: number, tick: number) => void): () => void {
    if (!(rate >= 1 && rate <= 240)) throw new GameRelayError('bad_request', 'tick rate must be between 1 and 240 per second');
    const loop: Loop = { step: 1000 / rate, fn, acc: 0, tick: 0 };
    this.#loops.add(loop);
    if (!this.#stop) {
      this.#last = this.#now();
      this.#stop = this.#schedule(this.#wakeMs, () => this.#wake());
    }
    return () => {
      this.#loops.delete(loop);
      if (this.#loops.size === 0) this.stop();
    };
  }

  /**
   * While a step runs: the moment it stands for on this ticker's clock (its scheduled time, not when
   * the timer happened to wake, which can be most of a wake interval later). Null outside a step.
   */
  stepTime(): number | null {
    return this.#stepAt;
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }

  #wake(): void {
    const now = this.#now();
    const elapsed = now - this.#last;
    this.#last = now;
    for (const loop of [...this.#loops]) {
      loop.acc += elapsed;
      let n = Math.floor(loop.acc / loop.step);
      let base: number; // the steps run at base + step, base + 2·step, …
      if (n > MAX_CATCH_UP) {
        n = MAX_CATCH_UP;
        loop.acc = 0;
        base = now - n * loop.step;
      } else {
        loop.acc -= n * loop.step;
        base = now - loop.acc - n * loop.step;
      }
      for (let i = 0; i < n && this.#loops.has(loop); i++) {
        this.#stepAt = base + (i + 1) * loop.step;
        try {
          loop.fn(loop.step / 1000, ++loop.tick);
        } catch (err) {
          console.error('[gamerelay] tick error', err);
        } finally {
          this.#stepAt = null;
        }
      }
    }
  }
}
