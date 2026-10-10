/**
 * UTF-8 sizes without encoding: measuring a message by `TextEncoder.encode` makes a copy of it
 * just to read its length, on paths that run for every message, every frame (the SDK's sends and
 * the server's frames, `frameByteLength`).
 */

/** `text`'s length in UTF-8 bytes, as `TextEncoder` writes it: a surrogate pair is 4, a lone surrogate 3 (U+FFFD). */
export function utf8Length(text: string): number {
  let n = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 2; // with its low half: 4 bytes for 2 units
      i++;
    } else n += 2;
  }
  return n;
}

/** Whether `text` is at most `max` UTF-8 bytes; the common case (short, or plainly over) without counting. */
export function fitsUtf8(text: string, max: number): boolean {
  if (text.length > max) return false;
  if (text.length * 3 <= max) return true;
  return utf8Length(text) <= max;
}
