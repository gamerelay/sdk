/**
 * Chat text rules, shared by the SDK (to fail fast) and the server (the authority).
 * Dependency-free so the SDK can import it without pulling in schemas.
 */
import { LIMITS } from './limits';

// Bidi overrides/isolates can make a message render reversed or spoof other text.
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
// C0/C1 control characters, including newlines and tabs: chat lines are single-line.
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

let segmenter: Intl.Segmenter | undefined;

/** User-perceived characters, so an emoji (even a multi-codepoint one) counts as one. */
export function chatLength(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

export type ChatCheck = { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_long' };

/** Single line, whitespace collapsed, controls stripped, 1..maxChatLength characters. */
export function normalizeChat(raw: string): ChatCheck {
  const text = raw.replace(BIDI_CONTROLS, '').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (chatLength(text) > LIMITS.maxChatLength) return { ok: false, reason: 'too_long' };
  return { ok: true, text };
}
