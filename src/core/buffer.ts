/** Per-entity sample buffer: the value of every field at any time, from timestamped samples. */

export type FieldKind = 'linear' | 'angle' | 'step';
export type SmoothFn = (a: number, b: number, t: number) => number;
export interface BufferField {
  kind: FieldKind;
  smooth?: false | SmoothFn;
}
export interface BufferOptions {
  capacity?: number;
  maxExtrapolateMs?: number;
  /** Only extrapolate from two samples at most this far apart: a rest keyframe then a move isn't a velocity. */
  maxSpanMs?: number;
  /** A step more than this many times the typical step is an unannounced teleport. */
  jumpFactor?: number;
  /** …and must also be bigger than this, so a resting entity that starts moving isn't snapped. */
  minJump?: number;
  /** Which fields can count as a jump (default: every linear field). Positions, not velocities. */
  jumpFields?: readonly boolean[];
}

interface Sample {
  t: number;
  v: unknown[];
  snap: boolean;
}

const TAU = Math.PI * 2;

/** Shortest signed difference from one angle to another, in (−π, π]. */
export function angleDelta(from: number, to: number): number {
  const d = ((((to - from + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return d === -Math.PI ? Math.PI : d;
}

function mix(f: BufferField, a: unknown, b: unknown, k: number): unknown {
  if (f.kind === 'step' || f.smooth === false || typeof a !== 'number' || typeof b !== 'number') return k >= 1 ? b : a;
  if (f.smooth) return f.smooth(a, b, k);
  return f.kind === 'angle' ? a + angleDelta(a, b) * k : a + (b - a) * k;
}

export class SampleBuffer {
  readonly #fields: readonly BufferField[];
  readonly #cap: number;
  readonly #maxExtrap: number;
  readonly #maxSpan: number;
  readonly #jumpFactor: number;
  readonly #minJump: number;
  readonly #typical: number[];
  readonly #jumpFields: readonly boolean[];
  #samples: Sample[] = [];
  #steps = 0;

  constructor(fields: readonly BufferField[], opts: BufferOptions = {}) {
    this.#fields = fields;
    this.#cap = opts.capacity ?? 32;
    this.#maxExtrap = opts.maxExtrapolateMs ?? 250;
    this.#maxSpan = opts.maxSpanMs ?? 250;
    this.#jumpFactor = opts.jumpFactor ?? 10;
    this.#minJump = opts.minJump ?? 100;
    this.#typical = fields.map(() => 0);
    this.#jumpFields = opts.jumpFields ?? fields.map((f) => f.kind === 'linear');
  }

  get size(): number {
    return this.#samples.length;
  }

  get latestTime(): number | undefined {
    return this.#samples.at(-1)?.t;
  }

  /** The newest sample's values (what a new host continues from), not the smoothed ones. */
  latest(): unknown[] | undefined {
    return this.#samples.at(-1)?.v.slice();
  }

  push(t: number, values: readonly unknown[], teleport = false): boolean {
    const prev = this.#samples.at(-1);
    const v = this.#fields.map((_, i) => (values[i] === undefined ? prev?.v[i] : values[i]));
    let jumped = false;
    if (prev && !teleport) {
      const steps = this.#fields.map((f, i) => {
        const a = prev.v[i];
        const b = v[i];
        return f.kind === 'linear' && this.#jumpFields[i] && typeof a === 'number' && typeof b === 'number' ? Math.abs(b - a) : null;
      });
      jumped =
        this.#steps >= 3 &&
        steps.some((d, i) => d !== null && d > this.#minJump && d > this.#typical[i]! * this.#jumpFactor);
      // A jump still teaches the estimate (at half weight): otherwise a fast start after a rest
      // freezes it near 0 and every later sample counts as a jump too.
      const weight = jumped ? 0.5 : this.#steps === 0 ? 1 : 0.2;
      steps.forEach((d, i) => {
        if (d !== null) this.#typical[i] = this.#typical[i]! + (d - this.#typical[i]!) * weight;
      });
      this.#steps++;
    }
    const sample: Sample = { t, v, snap: teleport || jumped };
    let at = this.#samples.length;
    while (at > 0 && this.#samples[at - 1]!.t > t) at--;
    this.#samples.splice(at, 0, sample);
    if (this.#samples.length > this.#cap) this.#samples.shift();
    return jumped;
  }

  read(t: number): unknown[] {
    const s = this.#samples;
    if (s.length === 0) return [];
    let i = s.length - 1;
    while (i >= 0 && s[i]!.t > t) i--;
    if (i < 0) return s[0]!.v.slice();
    if (i >= 2) {
      s.splice(0, i - 1); // keep one sample before t, for extrapolation
      i = 1;
    }
    const a = s[i]!;
    const b = s[i + 1];
    if (b) {
      if (b.snap) return a.v.slice();
      const span = b.t - a.t;
      const k = span > 0 ? (t - a.t) / span : 1;
      return this.#fields.map((f, j) => mix(f, a.v[j], b.v[j], k));
    }
    const p = s[i - 1];
    if (!p || a.snap) return a.v.slice();
    const span = a.t - p.t;
    if (span <= 0 || span > this.#maxSpan) return a.v.slice();
    const k = 1 + Math.min(t - a.t, this.#maxExtrap) / span;
    return this.#fields.map((f, j) => mix(f, p.v[j], a.v[j], k));
  }
}
