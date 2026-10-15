/**
 * A bot's brain (BOTS.md), run in its own Worker: the game's tab never runs it. This is a
 * best-effort lockdown for a developer's own tab, not a sandbox. Before the brain is compiled the
 * Worker sets these to undefined on the global object and on every prototype above it (Chrome keeps
 * fetch, setTimeout and others on WorkerGlobalScope.prototype): fetch, XMLHttpRequest, WebSocket,
 * WebSocketStream, EventSource, FontFace, fonts, importScripts, indexedDB, caches, BroadcastChannel,
 * Worker, SharedWorker, WebTransport, navigator, location, Request, Response, postMessage, close,
 * eval, Function, setTimeout, setInterval and Notification. The Function constructors of functions,
 * async functions and generators are blocked too, and source containing the word `import` is refused
 * (dynamic import is syntax, so it can't be removed). The Worker's own state lives in a closure
 * and the main thread re-validates every reply. NOT blocked: CPU or memory use beyond what the
 * watchdog's kill stops, timing side channels, and any API an engine adds that isn't listed. A brain
 * can also replace builtins in its own Worker; replies are re-validated on the main thread. Hosted
 * games need the QuickJS sandbox, BOTS.md phase 5.
 */
import { LIMITS } from '@gamerelay/protocol/limits';
import type { BotLogLine, Json } from '@gamerelay/protocol/types';

export interface BrainStep {
  action?: Json;
  lines: BotLogLine[];
  ms: number;
}
/**
 * Whatever the brain does, load and step reject only with BrainTimeout: a timeout, a Worker error
 * (reportError, an uncloneable reply), a forged reply or close() all stop the Worker and reject with
 * one, its message capped. The one other rejection is the game's, not the brain's: step rejects with
 * ViewError when the view can't be sent to the Worker, and the brain goes on.
 */
export interface Brain {
  /** Load (or replace) the brain; memory starts over. Resolves with an error message if it isn't one function. */
  load(src: string): Promise<string | null>;
  /** One call. Rejects with BrainTimeout after `timeoutMs` (the Worker is gone then), or ViewError. */
  step(view: Json): Promise<BrainStep>;
  close(): void;
}
export class BrainTimeout extends Error {}
/** The game's `observe` returned something a Worker can't be sent (a function, a class instance with methods). */
export class ViewError extends Error {}

/** A load includes starting a fresh Worker, which a busy tab or a slow machine can take a while to do. */
const LOAD_TIMEOUT_MS = 2000;

const MAX_LINES = LIMITS.maxBotLogLines;
const MAX_LINE = LIMITS.maxBotLogLineLength;
const MAX_ACTION = 4096;

// The Worker's code. Plain JS in a string: it must stand alone.
export const BRAIN_SOURCE = `(() => {
'use strict';
const post = self.postMessage.bind(self);
// The only reference to the compiler: taken before Function is removed, dropped once the brain is compiled.
let Compile = Function;
const safe = (x) => { try { return String(x); } catch (e) { return 'a value that cannot be shown'; } };
const why = (e) => { try { return safe(e && e.message || e); } catch (x) { return 'an error'; } };
const gone = ['fetch','XMLHttpRequest','WebSocket','WebSocketStream','EventSource','importScripts','indexedDB','caches','BroadcastChannel',
  'Worker','SharedWorker','WebTransport','navigator','location','postMessage','close','Request','Response','FontFace','fonts','eval',
  'Function','setTimeout','setInterval','Notification'];
for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  for (const k of gone) {
    try { Object.defineProperty(o, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
}
for (const f of [function () {}, async function () {}, function* () {}, async function* () {}]) {
  try { Object.defineProperty(Object.getPrototypeOf(f), 'constructor', { value: undefined, writable: false, configurable: false }); } catch (e) {}
}
let brain = null, memory = {}, lines = [], busy = false, loaded = false;
const apply = Reflect.apply, indexOf = String.prototype.indexOf, charCodeAt = String.prototype.charCodeAt;
const wordChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
// The word "import" anywhere in the source, found without the (replaceable) RegExp methods.
const mentionsImport = (src) => {
  for (let i = apply(indexOf, src, ['import', 0]); i >= 0; i = apply(indexOf, src, ['import', i + 1])) {
    const before = i === 0 ? 0 : apply(charCodeAt, src, [i - 1]), after = apply(charCodeAt, src, [i + 6]);
    if (!wordChar(before) && !wordChar(after)) return true;
  }
  return false;
};
const text = (a) => a.map((x) => typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return safe(x); } })()).join(' ').slice(0, ${MAX_LINE});
const log = (...a) => { if (lines.length < ${MAX_LINES}) lines.push({ level: 'info', text: text(a) }); };
const warn = (s) => { if (lines.length < ${MAX_LINES}) lines.push({ level: 'warn', text: safe(s).slice(0, ${MAX_LINE}) }); };
// One Worker per brain version: the first message loads it, then the compiler is let go and only steps are taken.
self.addEventListener('message', (e) => {
  if (!e.isTrusted || busy) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  busy = true;
  try {
    if (!loaded && m.t === 'load' && typeof m.src === 'string') {
      loaded = true;
      try {
        if (mentionsImport(m.src)) throw new Error('a brain cannot import');
        const c = Compile;
        Compile = null;
        const f = new c('log', '"use strict"; return (' + m.src + '\\n);')(log);
        if (typeof f !== 'function') throw new Error('the brain must be one function, (view, memory) => action');
        brain = f; lines = [];
        post({ t: 'loaded', id: m.id, error: null });
      } catch (err) { Compile = null; post({ t: 'loaded', id: m.id, error: why(err) }); }
    } else if (loaded && m.t === 'step') {
      const t0 = performance.now();
      let action;
      try { action = brain ? brain(m.view, memory) : undefined; } catch (err) { warn(safe(err)); action = undefined; }
      let out;
      if (typeof action !== 'function' && action !== undefined) {
        try { out = JSON.stringify(action); } catch (err) { warn('the action is not JSON: ' + safe(err)); }
      }
      if (out !== undefined && out.length > ${MAX_ACTION}) { warn('the action is over 4 KB of JSON: ignored'); out = undefined; }
      post({ t: 'stepped', id: m.id, action: out, lines, ms: performance.now() - t0 });
      lines = [];
    }
  } finally { busy = false; }
});
})();`;

/** Why a Worker failed, as a BrainTimeout message: the text may be the brain's, so it is capped. */
function failed(message: unknown): string {
  return `the brain failed: ${typeof message === 'string' && message ? message.slice(0, MAX_LINE) : 'unknown error'}`;
}

let blobUrl: string | null = null;
const sourceUrl = () => (blobUrl ??= URL.createObjectURL(new Blob([BRAIN_SOURCE], { type: 'text/javascript' })));

/** The Worker's replies are untrusted (the brain may have forged one): keep only what fits the shapes. */
function cleanLines(v: unknown): BotLogLine[] {
  if (!Array.isArray(v)) return [];
  const out: BotLogLine[] = [];
  for (const l of v) {
    if (out.length >= MAX_LINES) break;
    if (l && typeof l === 'object' && ((l as BotLogLine).level === 'info' || (l as BotLogLine).level === 'warn') && typeof (l as BotLogLine).text === 'string') {
      out.push({ level: (l as BotLogLine).level, text: (l as BotLogLine).text.slice(0, MAX_LINE) });
    }
  }
  return out;
}

export function workerBrain(timeoutMs = 250, makeWorker: (url: string) => Worker = (url) => new Worker(url)): Brain {
  type Kind = 'loaded' | 'stepped';
  let worker: Worker | null = null;
  let pending: { kind: Kind; id: number; resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let closed = false;
  let seq = 0; // each request's id, echoed by the Worker: a reply to an earlier request is ignored
  let dead: string | null = null; // why there is no Worker, when it was stopped (not just never loaded)
  /** Stop the current Worker; whatever waits on it is rejected with `why`. */
  const stop = (why: string, replacing = false) => {
    const w = worker;
    worker = null;
    dead = replacing ? null : why;
    w?.terminate();
    const p = pending;
    pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new BrainTimeout(why));
    }
  };
  const start = () => {
    const w = makeWorker(sourceUrl());
    worker = w;
    w.onmessage = (e: MessageEvent) => {
      if (w !== worker) return;
      const p = pending;
      if (!p) return;
      const d = e.data as Record<string, unknown> | null;
      if (d && typeof d === 'object' && d.id !== p.id) return; // a late reply to an earlier request
      if (!d || typeof d !== 'object' || d.t !== p.kind) {
        // Not the reply that was asked for: the brain is up to something. Stop it.
        stop('the brain sent a reply nobody asked for: stopped');
        return;
      }
      pending = null;
      clearTimeout(p.timer);
      p.resolve(d);
    };
    // A Worker that can't start (a CSP, say) or a brain that makes its Worker report an error
    // (reportError, a reply that can't be cloned): stop it. The message is the brain's, so it is capped.
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      if (w === worker) stop(failed(e?.message));
    };
    w.onmessageerror = () => {
      if (w === worker) stop(failed('a reply could not be read'));
    };
    return w;
  };
  const ask = (w: Worker, kind: Kind, msg: Record<string, unknown>, limitMs = timeoutMs) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++seq;
      const sent = performance.now();
      let graced = false;
      // The watchdog. Firing over twice the limit after it was set means this tab's main thread
      // stalled (a shader compile, say), not that the brain did: the reply may be queued behind the
      // stall, so one more period before stopping it.
      const watch = () => {
        if (pending?.id !== id) return;
        if (!graced && performance.now() - sent > 2 * limitMs) {
          graced = true;
          pending.timer = setTimeout(watch, limitMs);
          return;
        }
        stop(`the brain took over ${limitMs} ms: stopped`);
      };
      const timer = setTimeout(watch, limitMs);
      pending = { kind, id, resolve, reject, timer };
      try {
        w.postMessage({ ...msg, id });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (kind === 'loaded') return stop(failed(why));
        // Only the view can fail to clone (the rest is an id): the game's doing, so the Worker stays.
        pending = null;
        clearTimeout(timer);
        reject(new ViewError(`observe() returned something that can't be sent to the brain (plain data only: no functions or class instances): ${why}`));
      }
    });
  return {
    async load(src) {
      if (closed) throw new BrainTimeout('the brain was stopped');
      stop('the brain was replaced', true);
      let w: Worker;
      try {
        w = start();
      } catch (e) {
        dead = failed(e instanceof Error ? e.message : e);
        throw new BrainTimeout(dead);
      }
      const r = await ask(w, 'loaded', { t: 'load', src }, Math.max(timeoutMs, LOAD_TIMEOUT_MS));
      return typeof r.error === 'string' ? r.error : null;
    },
    async step(view) {
      if (!worker && dead) throw new BrainTimeout(dead);
      if (!worker) return { lines: [], ms: 0 }; // never loaded
      const r = await ask(worker, 'stepped', { t: 'step', view });
      const lines = cleanLines(r.lines);
      let action: Json | undefined;
      if (typeof r.action === 'string') {
        if (r.action.length > MAX_ACTION) lines.push({ level: 'warn', text: 'the action is over 4 KB of JSON: ignored' });
        else {
          try {
            action = JSON.parse(r.action) as Json;
          } catch {
            lines.push({ level: 'warn', text: 'the action is not JSON: ignored' });
          }
        }
      }
      return { action, lines: lines.slice(0, MAX_LINES), ms: typeof r.ms === 'number' && Number.isFinite(r.ms) ? r.ms : 0 };
    },
    close() {
      closed = true;
      stop('the brain was stopped');
    },
  };
}
