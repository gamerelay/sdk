/**
 * The name checks that look at a name as typed, shared by the server and the SDK: invisible
 * characters, markup, length, charset and links. The server runs them before its word lists
 * (apps/server/src/names.ts); the SDK runs them as a player types (`GameRelay.precheck`), with the
 * game's rules (`relay.moderationRules()`), so a name field can say "too long" before it's sent.
 * The word lists stay on the server.
 */
import { LIMITS } from './limits';
import type { ModerationCharset, ModerationReason } from './types';

/** What a player reads for each reason (`error.message`); games that translate use the reason. */
export const NAME_MESSAGES: Record<ModerationReason, string> = {
  empty: "Invalid name: it's empty",
  too_short: 'Invalid name: too short',
  too_long: 'Invalid name: too long',
  charset: "Invalid name: it has characters that aren't allowed",
  unsafe: 'Invalid name: no HTML or code',
  offensive: 'Invalid name: offensive language',
  reserved: 'Invalid name: kept for the game',
  link: 'Invalid name: no links',
  blocked: 'Invalid name: not allowed in this game',
  unchecked: "Invalid name: couldn't be checked right now",
};

/** The rules a precheck applies, all optional: a name's own limits (1 to 24 characters, any charset, no links) otherwise. */
export interface PrecheckRules {
  minLength?: number;
  maxLength?: number;
  charset?: ModerationCharset;
  /** Whether links count against a name (default true). */
  links?: boolean;
}

const CHARSET_RULES: Record<ModerationCharset, RegExp | null> = {
  any: null,
  // Latin letters (with accents), digits, spaces and a little punctuation.
  latin: /^[\p{Script=Latin}\p{M}\p{N} _.'-]+$/u,
  alnum: /^[A-Za-z0-9 ]+$/,
};

/** The charsets from loosest to strictest: a stricter one only ever narrows the one before. */
export const CHARSET_ORDER: readonly ModerationCharset[] = ['any', 'latin', 'alnum'];

/** Text that reads as markup or script: a tag or quoted attribute, or a `javascript:` link. */
const UNSAFE = /[<>"`]|javascript:|data:text\/html/i;
const LINK = /(https?:|www\.|discord\.gg|\.(com|net|org|io|gg|ru|xyz|tk|ly|me|tv|co)\b)/i;

let graphemes: Intl.Segmenter | undefined;
const segments = (text: string): Iterable<string> => {
  // (A browser without Intl.Segmenter counts code points: an emoji with a joiner counts as more.)
  if (typeof Intl === 'undefined' || !Intl.Segmenter) return [...text];
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...graphemes.segment(text)].map((s) => s.segment);
};

/** Characters as a player sees them: an emoji counts as one. */
export function nameLength(text: string): number {
  let n = 0;
  for (const _ of segments(text)) n++;
  return n;
}

/** `text` cut to `max` characters as a player sees them (never half an emoji). */
export function cutName(text: string, max: number): string {
  let out = '';
  let n = 0;
  for (const segment of segments(text)) {
    if (++n > max) break;
    out += segment;
  }
  return out;
}

// Characters that show as nothing: controls (C0 and C1), format characters (bidi controls,
// zero-width spaces, tags), and the fillers some scripts draw blank. A name shown with them can
// hide or reverse what it says, and one between two letters splits a word for the filter only.
export const CONTROLS = /\p{Cc}/gu;
export const FILLERS = /[\u034F\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]/g;
const FORMAT = /(?!\u200D)\p{Cf}/gu;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
/** What may sit between an emoji and its joiner: the emoji presentation selector and skin tones. */
const MODIFIER = /^[\uFE0F\u{1F3FB}-\u{1F3FF}]$/u;

/**
 * Joiners (U+200D) out, except between two emoji (👩‍💻, 🏳️‍🌈). A loop, not a lookbehind: Bun's
 * regexes don't match `\p{…}` inside one.
 */
function joinersOut(text: string): string {
  if (!text.includes('\u200D')) return text;
  const cs = [...text];
  let out = '';
  for (let i = 0; i < cs.length; i++) {
    if (cs[i] !== '\u200D') {
      out += cs[i];
      continue;
    }
    let j = i - 1;
    while (j >= 0 && MODIFIER.test(cs[j]!)) j--;
    if (j >= 0 && PICTOGRAPH.test(cs[j]!) && PICTOGRAPH.test(cs[i + 1] ?? '')) out += cs[i];
  }
  return out;
}

/** Control, invisible and bidi characters out (emoji joiners kept), trimmed: what a name gets before any check. */
export function tidyName(name: string): string {
  return joinersOut(name.replace(CONTROLS, '').replace(FORMAT, '').replace(FILLERS, '')).trim();
}

/**
 * The checks that look at a name as typed: empty, markup, length, charset, links. A refusal, or
 * the name tidied (`tidyName`). Lengths are kept within a name's own (1 to 24).
 */
export function precheckName(input: string, rules: PrecheckRules = {}): { ok: false; reason: ModerationReason } | { ok: true; name: string } {
  const { charset = 'any', links = true } = rules;
  const name = tidyName(String(input));
  if (!name.replace(/\u200D/g, '')) return { ok: false, reason: 'empty' };
  if (UNSAFE.test(name)) return { ok: false, reason: 'unsafe' };
  const n = nameLength(name);
  if (n > Math.min(LIMITS.maxPlayerNameLength, rules.maxLength ?? LIMITS.maxPlayerNameLength)) return { ok: false, reason: 'too_long' };
  if (n < Math.max(1, rules.minLength ?? 1)) return { ok: false, reason: 'too_short' };
  if (CHARSET_RULES[charset]?.test(name) === false) return { ok: false, reason: 'charset' };
  if (links && LINK.test(name)) return { ok: false, reason: 'link' };
  return { ok: true, name };
}
