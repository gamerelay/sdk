/** Counts hits in 1 s windows; `hit` is true once per window, when the count first passes `limit`. */
export class Rate {
  #start = -Infinity;
  #n = 0;
  constructor(readonly limit: number) {}

  hit(now: number): boolean {
    if (now - this.#start >= 1000) {
      this.#start = now;
      this.#n = 0;
    }
    return ++this.#n === this.limit + 1;
  }
}

const isPoint = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && typeof (v as { x?: unknown }).x === 'number' && typeof (v as { y?: unknown }).y === 'number';

/** A message that carries a position: {x, y}, one level down, or a list of them. */
export function looksPositional(data: unknown): boolean {
  if (Array.isArray(data)) return isPoint(data[0]);
  if (typeof data !== 'object' || data === null) return false;
  return isPoint(data) || Object.values(data).some(isPoint);
}
