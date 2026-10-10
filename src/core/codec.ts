import type { Json } from '@gamerelay/protocol/types';
import { GameRelayError } from '../errors';
import type { FieldKind, SmoothFn } from './buffer';
import { fitsUtf8, utf8Length } from '@gamerelay/protocol/bytes';

export type FieldType = 'number' | 'angle' | 'flag' | 'text' | 'value';
export type FieldInput = FieldType | { type: FieldType; precision?: number; smooth?: false | SmoothFn };
export interface FieldSpec {
  name: string;
  type: FieldType;
  precision: number;
  /** Decimals that write `precision` exactly (`decimalsOf`), worked out once here. */
  decimals: number;
  smooth?: false | SmoothFn;
}
export interface KindSchema {
  kind: string;
  fields: FieldSpec[];
  index: Map<string, number>;
  rate: number;
  hash: string;
}

/** Entry flags. */
export const SPAWN = 1;
export const REMOVE = 2;
export const TELEPORT = 4;
export const FULL = 8;
/** A host-owned entity: whoever is host writes it. */
export const HOST = 16;
/** A player entity the host keeps when its owner leaves (`spawn(…, { onLeave: 'host' })`); on full updates. */
export const LEAVE_HOST = 32;
/** One entity's update on the wire: id, flags, [fieldIndex, value, …], schema hash on full updates. */
export type Entry = [id: string, flags: number, pairs: Json[], hash?: string];

export const RESERVED_FIELDS = new Set(['id', 'kind', 'owner', 'mine', 'teleport', 'remove']);
export const MAX_FIELDS = 32;
const TYPES = new Set<FieldType>(['number', 'angle', 'flag', 'text', 'value']);
const KIND = /^[A-Za-z][\w-]{0,31}$/;
const NAME = /^[A-Za-z_$][\w$]{0,31}$/;

/** A name `room.define` accepts: anything else can never be defined, so nothing waits for it. */
export const isKindName = (kind: string): boolean => KIND.test(kind);

const bad = (message: string) => new GameRelayError('bad_request', message);

export const MAX_VALUE_BYTES = 4096;
/** The most one entity's update may take on the wire (the server's message limit is 16 KB). */
export const MAX_ENTITY_BYTES = 13_000;
/** The most one field can take in an entry (UTF-8: up to 3 bytes per text character). */
const WORST_FIELD_BYTES: Record<FieldType, number> = { number: 24, angle: 24, flag: 8, text: 256 * 3 + 8, value: MAX_VALUE_BYTES + 8 };

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function compileSchema(kind: string, fields: Record<string, FieldInput>, rate = 20): KindSchema {
  if (typeof kind !== 'string' || !KIND.test(kind)) {
    throw bad(`room.define: kind '${kind}' must start with a letter and use only letters, digits, - or _ (max 32)`);
  }
  const names = Object.keys(fields ?? {});
  if (names.length === 0 || names.length > MAX_FIELDS) {
    throw bad(`room.define('${kind}'): give 1 to ${MAX_FIELDS} fields, e.g. { x: 'number', y: 'number' }`);
  }
  if (!(rate >= 1 && rate <= 60)) throw bad(`room.define('${kind}'): rate must be between 1 and 60 updates per second`);
  const specs = names.map((name): FieldSpec => {
    if (!NAME.test(name) || RESERVED_FIELDS.has(name)) throw bad(`room.define('${kind}'): '${name}' can't be a field name`);
    const input = fields[name];
    const o = typeof input === 'string' ? { type: input } : input;
    if (!o || !TYPES.has(o.type)) {
      throw bad(`room.define('${kind}'): field '${name}' needs a type: 'number', 'angle', 'flag', 'text' or 'value'`);
    }
    const precision = 'precision' in o && o.precision !== undefined ? o.precision : 0.01;
    if (!(typeof precision === 'number' && Number.isFinite(precision) && precision > 0)) {
      throw bad(`room.define('${kind}'): precision for '${name}' must be a number above 0, like 0.01`);
    }
    return { name, type: o.type, precision, decimals: decimalsOf(precision), smooth: 'smooth' in o ? o.smooth : undefined };
  });
  // One entity's full update must fit in a message: messages split between entities, not inside one.
  const worst = specs.reduce((sum, f) => sum + WORST_FIELD_BYTES[f.type] + f.name.length, 100);
  if (worst > MAX_ENTITY_BYTES) {
    throw bad(
      `room.define('${kind}'): one ${kind} update could reach about ${Math.round(worst / 1024)} KB, over the ${MAX_ENTITY_BYTES / 1000} KB limit per entity ` +
        `(a 'value' field holds up to 4 KB, a 'text' field 256 characters); use fewer or smaller fields, or put bulk data in room.setState`,
    );
  }
  const signature = `${kind}|${specs.map((f) => `${f.name}:${f.type}`).join(',')}`;
  return { kind, fields: specs, index: new Map(specs.map((f, i) => [f.name, i])), rate, hash: fnv1a(signature) };
}

export const bufferKind = (type: FieldType): FieldKind => (type === 'number' ? 'linear' : type === 'angle' ? 'angle' : 'step');
export const isDiscrete = (type: FieldType): boolean => type === 'flag' || type === 'text' || type === 'value';

function isJson(v: unknown): boolean {
  try {
    return v !== undefined && JSON.stringify(v) !== undefined;
  } catch {
    return false;
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return typeof v;
}

function valid(type: FieldType, v: unknown): boolean {
  switch (type) {
    case 'number':
    case 'angle':
      return typeof v === 'number' && Number.isFinite(v);
    case 'flag':
      return typeof v === 'boolean';
    case 'text':
      return typeof v === 'string' && v.length <= 256;
    case 'value':
      return isJson(v);
  }
}

export function checkValue(kind: string, field: FieldSpec, value: unknown): void {
  if (field.type === 'text' && typeof value === 'string' && value.length > 256) {
    throw bad(`${kind}.${field.name} is a 'text' field of at most 256 characters; got ${value.length}. For longer text use a 'value' field or room.setState`);
  }
  if (!valid(field.type, value)) throw bad(`${kind}.${field.name} is a '${field.type}' field; got ${describe(value)}`);
  if (field.type === 'value' && !fitsUtf8(JSON.stringify(value), MAX_VALUE_BYTES)) {
    throw bad(`${kind}.${field.name} is over 4 KB; keep 'value' fields small, and put bulk data in room.setState or an event`);
  }
}

/** Decimals that write `precision` exactly (0.25: 2, 0.125: 3); -1 past `toFixed`'s 20. */
export function decimalsOf(precision: number): number {
  let d = 0;
  while (d <= 20 && Math.abs(Number(precision.toFixed(d)) - precision) > precision * 1e-9) d++;
  return d > 20 ? -1 : d;
}

/**
 * `value` to the nearest multiple of `precision`, without float noise (0.1 + 0.2 stays 0.3).
 * `d`: `decimalsOf(precision)`, which a field works out once.
 */
export function roundTo(value: number, precision: number, d = decimalsOf(precision)): number {
  const snapped = Math.round(value / precision) * precision;
  // Too fine for toFixed: the multiple as it is (float noise there is far below the precision anyway).
  const rounded = d < 0 ? snapped : Number(snapped.toFixed(d));
  // Near the largest numbers, value / precision overflows: those keep their value.
  return Number.isFinite(rounded) ? rounded : value;
}

/**
 * What JSON writes as escapes (`\"`, `\\`, `\u0001`, a lone surrogate's `\udXXX`), and surrogates
 * generally (a pair is written as it is, 4 bytes): text with any of them is written out to measure.
 */
const ESCAPED = /["\\\u0000-\u001f\ud800-\udfff]/;

/** The bytes `text` takes as a JSON string. */
const stringBound = (text: string): number => (ESCAPED.test(text) ? utf8Length(JSON.stringify(text)) : utf8Length(text) + 2);

/**
 * At least as many bytes as `entry` takes as JSON, without writing it, for splitting updates into
 * messages (measuring each by `JSON.stringify` wrote every update twice). Numbers, flags and text
 * are counted exactly; only text with escapes or surrogates, and a 'value' field's object or
 * array, are written out to measure.
 */
export function entryBound(entry: Entry): number {
  const [id, flags, pairs, hash] = entry;
  // (A present but undefined hash is written `,null`.)
  let n = 6 + stringBound(id) + String(flags).length + (hash !== undefined ? stringBound(hash) + 1 : entry.length > 3 ? 5 : 0);
  for (const v of pairs) {
    n +=
      1 +
      (typeof v === 'number'
        ? Number.isFinite(v)
          ? String(v).length
          : 4 // NaN and ±Infinity are written `null`
        : typeof v === 'boolean' || v === null
          ? 5
          : typeof v === 'string'
            ? stringBound(v)
            : utf8Length(JSON.stringify(v)));
  }
  return n;
}

function wire(f: FieldSpec, v: unknown): Json {
  return f.type === 'number' || f.type === 'angle' ? roundTo(v as number, f.precision, f.decimals) : (v as Json);
}

/**
 * Changed fields as a flat `[index, value, index, value, …]` list, compared after rounding; `sent`
 * (one slot per field, what receivers last got) is updated to match. `full` sends every field.
 */
export function encodeChanges(
  schema: KindSchema,
  values: readonly unknown[],
  sent: unknown[],
  full: boolean,
): { pairs: Json[]; discrete: boolean } {
  const pairs: Json[] = [];
  let discrete = false;
  schema.fields.forEach((f, i) => {
    const w = wire(f, values[i]);
    const key = f.type === 'value' ? JSON.stringify(w) : w;
    if (!full && sent[i] !== undefined && sent[i] === key) return;
    sent[i] = key;
    pairs.push(i, w);
    if (isDiscrete(f.type)) discrete = true;
  });
  return { pairs, discrete };
}

export function decodeChanges(schema: KindSchema, pairs: unknown): (unknown | undefined)[] | null {
  if (!Array.isArray(pairs) || pairs.length % 2 !== 0) return null;
  const out: (unknown | undefined)[] = schema.fields.map(() => undefined);
  for (let i = 0; i < pairs.length; i += 2) {
    const idx = pairs[i];
    const f = typeof idx === 'number' && Number.isInteger(idx) ? schema.fields[idx] : undefined;
    if (!f || !valid(f.type, pairs[i + 1])) return null;
    out[idx as number] = pairs[i + 1];
  }
  return out;
}

export function isEntry(x: unknown): x is Entry {
  return (
    Array.isArray(x) &&
    x.length >= 3 &&
    typeof x[0] === 'string' &&
    typeof x[1] === 'number' &&
    Array.isArray(x[2]) &&
    (x[3] === undefined || typeof x[3] === 'string')
  );
}
