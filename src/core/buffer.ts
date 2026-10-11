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
  teleport: boolean;
  /** A starting point to glide from (what was shown), not an update: no velocity from it. */
  seed: boolean;
  /** The update as it came (undefined: a field it left out, unchanged since). Kept, not copied. */
  got: readonly unknown[];
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
  /** Per field, when the newest sample dropped that carried it was sent (the value the oldest kept build on). */
  readonly #dropped: number[];
  /** Steps learned from (`#typical`). */
  #count = 0;

  constructor(fields: readonly BufferField[], opts: BufferOptions = {}) {
    this.#fields = fields;
    this.#cap = opts.capacity ?? 32;
    this.#maxExtrap = opts.maxExtrapolateMs ?? 250;
    this.#maxSpan = opts.maxSpanMs ?? 250;
    this.#jumpFactor = opts.jumpFactor ?? 10;
    this.#minJump = opts.minJump ?? 100;
    this.#typical = fields.map(() => 0);
    this.#dropped = fields.map(() => Number.NEGATIVE_INFINITY);
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

  /**
   * A sample at `t`. Samples can arrive out of order (a late one over a slower path, a reliable one
   * behind faster updates): each is judged against the sample before it in time, not the newest,
   * and fields it doesn't carry are that sample's. A late one also fills the fields it carries
   * into the samples after it that left them out as unchanged (up to one that carried them: its
   * value was sent after), and redoes the jump check of each sample it changed and the one after.
   */
  push(t: number, values: readonly unknown[], teleport = false, seed = false): boolean {
    let at = this.#samples.length;
    while (at > 0 && this.#samples[at - 1]!.t > t) at--;
    const prev = this.#samples[at - 1];
    // (Older than every sample kept: nothing before it, so the one after it is the best guess.)
    const base = prev ?? this.#samples[at];
    const v = this.#fields.map((_, i) => (values[i] !== undefined ? values[i] : base?.v[i]));
    let jumped = false;
    // (Not from a seed: what was shown isn't where the sender was, so the step to it says nothing.)
    if (prev && !teleport && !prev.seed) {
      const steps = this.#steps(prev.v, v);
      jumped = this.#isJump(steps);
      // A jump still teaches the estimate (at half weight): otherwise a fast start after a rest
      // freezes it near 0 and every later sample counts as a jump too.
      const weight = jumped ? 0.5 : this.#count === 0 ? 1 : 0.2;
      steps.forEach((d, i) => {
        if (d !== null) this.#typical[i] = this.#typical[i]! + (d - this.#typical[i]!) * weight;
      });
      this.#count++;
    }
    const sample: Sample = { t, v, snap: teleport || jumped, teleport, seed, got: values };
    this.#samples.splice(at, 0, sample);
    const s = this.#samples;
    let end = at + 1;
    if (end < s.length) {
      values.forEach((x, j) => {
        if (x === undefined) return;
        // The ones after it that left it out have it from an earlier sample: older than this one
        // if it's kept (before it in time), else only if the dropped one was.
        let older = this.#dropped[j]! < t;
        for (let k = 0; k < at && !older; k++) older = s[k]!.got[j] !== undefined;
        for (let i = at + 1; older && i < s.length && s[i]!.got[j] === undefined; i++) {
          s[i]!.v[j] = x;
          end = Math.max(end, i + 1);
        }
      });
    }
    // The ones after it, up to the first it didn't change, were judged against older values.
    for (let i = at + 1; i <= end && i < s.length; i++) if (!s[i]!.teleport && !s[i]!.seed) s[i]!.snap = this.#isJump(this.#steps(s[i - 1]!.v, s[i]!.v));
    if (s.length > this.#cap) this.#drop(1);
    return jumped;
  }

  #drop(n: number): void {
    for (const old of this.#samples.splice(0, n)) {
      for (let j = 0; j < this.#fields.length; j++) if (old.got[j] !== undefined) this.#dropped[j] = Math.max(this.#dropped[j]!, old.t);
    }
  }

  /** How far each position field moved from `a` to `b` (null for the others). */
  #steps(a: readonly unknown[], b: readonly unknown[]): (number | null)[] {
    return this.#fields.map((f, i) => {
      const x = a[i];
      const y = b[i];
      return f.kind === 'linear' && this.#jumpFields[i] && typeof x === 'number' && typeof y === 'number' ? Math.abs(y - x) : null;
    });
  }

  #isJump(steps: (number | null)[]): boolean {
    return this.#count >= 3 && steps.some((d, i) => d !== null && d > this.#minJump && d > this.#typical[i]! * this.#jumpFactor);
  }

  read(t: number): unknown[] {
    const s = this.#samples;
    if (s.length === 0) return [];
    let i = s.length - 1;
    while (i >= 0 && s[i]!.t > t) i--;
    if (i < 0) return s[0]!.v.slice();
    if (i >= 2) {
      this.#drop(i - 1); // keep one sample before t, for extrapolation
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
    if (!p || a.snap || a.seed || p.seed) return a.v.slice();
    const span = a.t - p.t;
    if (span <= 0 || span > this.#maxSpan) return a.v.slice();
    const k = 1 + Math.min(t - a.t, this.#maxExtrap) / span;
    return this.#fields.map((f, j) => mix(f, p.v[j], a.v[j], k));
  }
}
