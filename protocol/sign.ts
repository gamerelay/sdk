/**
 * Signed frames (docs/HISTORY.md, "1.0 hardening"): every client -> server frame is
 * `<check>.<seq>.<json>`, where `check` is a keyed 32-bit hash of the sequence number and the
 * JSON text, with a per-connection key the server hands out (masked) in `welcome`.
 *
 * This is a hassle, not cryptography: the key lives in the player's browser, and anyone who reads
 * the SDK can reproduce it. What it stops is the easy stuff: copying a frame out of DevTools and
 * replaying or editing it, or scripting raw requests with a token lifted from storage. TLS already
 * covers tampering in transit, and the server already knows who sent what.
 */

/** Four 32-bit words. */
export type FrameKey = readonly [number, number, number, number];

const PRIME = 0x01000193;

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Keyed FNV-1a over the sequence number and body, finished with murmur3's mixer. */
export function frameCheck(key: FrameKey, seq: number, body: string): number {
  let h = (key[0] ^ Math.imul(seq, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, PRIME);
    if ((i & 63) === 63) h ^= key[(i >>> 6) & 3]!;
  }
  return fmix(h ^ key[1] ^ Math.imul(body.length, key[2] | 1) ^ key[3]);
}

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

export function signFrame(key: FrameKey, seq: number, body: string): string {
  return `${hex8(frameCheck(key, seq, body))}.${seq}.${body}`;
}

/**
 * The most a signature adds in front of the JSON: `<8 hex>.<seq>.` with `seq` at most 16 digits
 * (any safe integer), which is what `openFrame` accepts.
 */
export const MAX_FRAME_ENVELOPE = 8 + 1 + 16 + 1;

/** Split a signed frame; null if it isn't one. The caller checks `check` and `seq`. */
export function openFrame(frame: string): { check: number; seq: number; body: string } | null {
  if (frame.length < 11 || frame.charCodeAt(8) !== 46 /* . */) return null;
  const dot = frame.indexOf('.', 9);
  if (dot < 10 || dot > 25) return null;
  const check = Number.parseInt(frame.slice(0, 8), 16);
  const seq = Number(frame.slice(9, dot));
  if (!Number.isSafeInteger(seq) || seq < 1 || Number.isNaN(check)) return null;
  return { check: check >>> 0, seq, body: frame.slice(dot + 1) };
}

/** Salt words for masking, derived from something both sides know (the player id). */
function saltWords(salt: string): FrameKey {
  let h = 0x811c9dc5;
  for (let i = 0; i < salt.length; i++) h = Math.imul(h ^ salt.charCodeAt(i), PRIME);
  return [fmix(h ^ 0x6a09e667), fmix(h ^ 0xbb67ae85), fmix(h ^ 0x3c6ef372), fmix(h ^ 0xa54ff53a)];
}

/** The key as `welcome` carries it: XOR-masked with the player id, as 32 hex characters. */
export function maskKey(key: FrameKey, salt: string): string {
  const s = saltWords(salt);
  return key.map((w, i) => hex8(w ^ s[i]!)).join('');
}

export function unmaskKey(masked: string, salt: string): FrameKey | null {
  if (!/^[0-9a-f]{32}$/.test(masked)) return null;
  const s = saltWords(salt);
  const w = (i: number) => (Number.parseInt(masked.slice(i * 8, i * 8 + 8), 16) ^ s[i]!) >>> 0;
  return [w(0), w(1), w(2), w(3)];
}
