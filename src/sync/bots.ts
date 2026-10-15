/**
 * Bots (BOTS.md): in a bot host that's the room's host, each bot's brain runs about 30 times a
 * second: the game's adapter says what it sees (`observe`) and plays what it returns (`drive`).
 * Lines a brain logs go to the server once a second (the instance logs), at most 20 a second each
 * (`LIMITS.maxBotLogLines`), and at most that many wait while the send budget is spent.
 * Its own chunk, loaded only by a bot host (`loadBots.ts`): the main file imports nothing here but types.
 */
import { LIMITS } from '@gamerelay/protocol/limits';
import type { BotLogLine, BotSpec, Json } from '@gamerelay/protocol/types';
import { BrainTimeout, ViewError, type Brain } from './brainWorker';

/** This file is the bots chunk's entry (scripts/build.ts): the brain Worker comes with it. */
export { workerBrain } from './brainWorker';

export interface BotInfo {
  readonly id: string;
  readonly name: string;
}
export interface BotAdapter {
  /**
   * A bot arrived (or this tab became its host) and its brain loaded: give it something to play.
   * Return false if there's no room for it (no free car, say): it sits out, with a warn line in the
   * instance logs, until update_bot or the next host. Anything else means it's in (an info line, "started").
   */
  join?(bot: BotInfo): boolean | void;
  /** It left (removed, or this tab stopped hosting): hand its car back. */
  leave?(bot: BotInfo): void;
  /** What its brain sees as view.game. Called about 30 times a second. */
  observe(bot: BotInfo): Json;
  /** Apply what its brain returned. */
  drive(bot: BotInfo, action: Json): void;
}
export interface BotsDeps {
  now(): number;
  /** False if it couldn't go out now (offline, or the send budget is spent): the lines wait for the next flush. */
  sendLog(bot: string, lines: BotLogLine[]): boolean;
  brain(): Brain;
}

const SLOW_MS = 5;
/** A surrogate pair (kept), a lone surrogate (U+FFFD) or a control character (a space): see `#line`. */
const UNSAFE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]|[\u0000-\u001F]/g;
const SLOW_NOTE_MS = 5000;

interface Running {
  info: BotInfo;
  src: string;
  /** The server's `rev` for the brain it runs: update_bot bumps it, even for the same source. */
  rev: number;
  brain: Brain;
  /** The latest load's outcome, never rejecting: an error message, null (loaded), or how it failed. */
  loaded: Promise<string | null | BrainTimeout>;
  /** Bumped on every load: a step begun on an older brain doesn't speak for the new one. */
  version: number;
  busy: boolean;
  /** In the game: `join` took it (and `leave` is owed). */
  joined: boolean;
  /** Halted (its brain failed) or sitting out (`join` said no room), until update_bot. */
  stopped: boolean;
  /** Removed (or this tab stopped hosting): whatever its brain still answers is ignored. */
  gone: boolean;
  /** Its log has said once that the game's `observe` returned what a brain can't be sent. */
  viewWarned: boolean;
  lines: BotLogLine[];
  lineWindow: number;
  lineCount: number;
  slowNoteAt: number;
}

export class Bots {
  #adapter: BotAdapter | null = null;
  #list: BotSpec[] = [];
  #host = false;
  #running = new Map<string, Running>();
  #lastFlush = 0;
  /** What the game's adapter threw (or anything else unexpected), each message said once. */
  #warned = new Set<string>();
  readonly #deps: BotsDeps;

  constructor(deps: BotsDeps) {
    this.#deps = deps;
  }

  /** A different adapter (or none): the bots leave the old one first, and join the new one on the next tick. */
  setAdapter(adapter: BotAdapter | null): void {
    if (adapter !== this.#adapter) this.#stopAll();
    this.#adapter = adapter;
  }
  setList(bots: BotSpec[]): void {
    this.#list = bots;
    if (!this.#active) return;
    const ids = new Set(bots.map((b) => b.id));
    for (const [id, r] of this.#running) if (!ids.has(id)) this.#stop(r);
    for (const b of bots) {
      const r = this.#running.get(b.id);
      // Only update_bot bumps `rev` (the server sends the whole list on any change): memory starts
      // over, and a halted bot (or one sitting out) joins again. Any other list leaves it as it is.
      if (!r || r.rev === b.rev) continue;
      r.rev = b.rev;
      this.#load(r, b.brain);
      r.stopped = false;
    }
  }
  setHost(isHost: boolean): void {
    this.#host = isHost;
    if (isHost) return;
    // Forget the list too: as host again, it runs only what the server's next `bots` message says.
    this.#list = [];
    this.#stopAll();
  }
  /** Stop: what was logged goes out, every bot leaves, and nothing runs until a new adapter. */
  close(): void {
    this.flushLogs();
    this.setAdapter(null);
  }

  get #active(): boolean {
    return this.#host && this.#adapter !== null;
  }

  /** One round: every bot that isn't waiting on its brain sees, thinks and plays. */
  async tick(): Promise<void> {
    if (!this.#active) return;
    const adapter = this.#adapter!;
    for (const spec of this.#list) {
      if (!this.#running.has(spec.id)) this.#start(spec);
    }
    await Promise.all([...this.#running.values()].map((r) => this.#step(r, adapter)));
    if (this.#deps.now() - this.#lastFlush >= 1000) this.flushLogs();
  }

  flushLogs(): void {
    this.#lastFlush = this.#deps.now();
    for (const r of this.#running.values()) this.#flush(r);
  }

  /** It joins the game once its brain has loaded (`#step`). */
  #start(spec: BotSpec): void {
    const info: BotInfo = Object.freeze({ id: spec.id, name: spec.name });
    const r: Running = {
      info, src: '', rev: spec.rev, brain: this.#deps.brain(), loaded: Promise.resolve(null), version: 0, busy: false, joined: false, stopped: false, gone: false, viewWarned: false,
      lines: [], lineWindow: this.#deps.now(), lineCount: 0, slowNoteAt: -Infinity,
    };
    this.#load(r, spec.brain);
    this.#running.set(spec.id, r);
  }

  /** Into the game: "started", or (`join` returned false) a warn line and it sits out. */
  #join(r: Running, adapter: BotAdapter): boolean {
    let placed: boolean | void = undefined;
    try {
      placed = adapter.join?.(r.info);
    } catch (err) {
      this.#warnOnce(err); // said once; it plays on, as for any other adapter call that throws
    }
    if (placed === false) {
      this.#line(r, { level: 'warn', text: 'no room for this bot in the game' });
      r.stopped = true;
      this.#flush(r);
      return false;
    }
    r.joined = true;
    this.#line(r, { level: 'info', text: 'started' });
    return true;
  }

  /** Load (or replace) its brain. The outcome is kept settled, so a fast failure is never unhandled. */
  #load(r: Running, src: string): void {
    r.src = src;
    r.version++;
    r.loaded = r.brain.load(src).catch((err: unknown) => (err instanceof BrainTimeout ? err : new BrainTimeout(String(err))));
  }

  async #step(r: Running, adapter: BotAdapter): Promise<void> {
    if (r.busy || r.stopped) return;
    r.busy = true;
    const version = r.version;
    // Removed, or given a newer brain while this step waited: what the old brain did doesn't count.
    const stale = () => r.gone || r.version !== version;
    try {
      const loaded = await r.loaded;
      if (stale()) return;
      if (loaded instanceof BrainTimeout) throw loaded;
      if (loaded !== null) {
        this.#line(r, { level: 'warn', text: `the brain didn't load: ${loaded}` });
        return this.#halt(r, adapter);
      }
      if (!r.joined && !this.#join(r, adapter)) return;
      let game: Json;
      try {
        game = adapter.observe(r.info);
      } catch (err) {
        return this.#warnOnce(err);
      }
      const out = await r.brain.step({ game, now: this.#deps.now() });
      if (stale()) return;
      for (const line of out.lines) this.#line(r, line);
      const now = this.#deps.now();
      if (out.ms > SLOW_MS && now - r.slowNoteAt >= SLOW_NOTE_MS) {
        r.slowNoteAt = now;
        this.#line(r, { level: 'warn', text: `the brain took ${Math.round(out.ms)} ms (keep it under ${SLOW_MS} ms a call)` });
      }
      if (out.action !== undefined) this.#call(() => adapter.drive(r.info, out.action!));
    } catch (err) {
      if (err instanceof ViewError) {
        // The game's bug, not the brain's: it keeps playing (this round skipped), said once in its log and the console.
        if (!r.viewWarned) this.#line(r, { level: 'warn', text: "the game's observe() returned something a brain can't be sent (plain data only: no functions or class instances). Fix observe, not the brain." });
        r.viewWarned = true;
        return this.#warnOnce(err);
      }
      if (!(err instanceof BrainTimeout)) return this.#warnOnce(err); // (a Brain rejects only with these two)
      if (stale()) return;
      this.#line(r, { level: 'warn', text: `${err.message}. Fix it with update_bot.` });
      this.#halt(r, adapter);
    } finally {
      r.busy = false;
    }
  }

  /**
   * A brain that failed: the bot leaves the game until update_bot sends a new one. Its Brain stays
   * open for that (`load` starts a fresh Worker; a timed-out or failed one has none left), so
   * `close` is only for `#stop`.
   */
  #halt(r: Running, adapter: BotAdapter): void {
    r.stopped = true;
    if (r.joined) this.#call(() => adapter.leave?.(r.info));
    r.joined = false;
    this.#flush(r);
  }

  /** Call the game's adapter: what it throws is said once (per message), and the round goes on. */
  #call(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#warnOnce(err);
    }
  }

  #warnOnce(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.#warned.has(message)) return;
    this.#warned.add(message);
    console.warn(`[gamerelay] bots: ${message}`, err);
  }

  /**
   * A line, at most `maxBotLogLineLength` characters (the server refuses the whole message for a
   * longer one), with no control characters or lone surrogates: JSON writes each of those as 6
   * bytes, and a full message of them would go over the server's `maxMessageBytes`.
   */
  #line(r: Running, line: BotLogLine): void {
    const max = LIMITS.maxBotLogLineLength;
    const text = line.text.length > max ? `${line.text.slice(0, max - 1)}…` : line.text;
    line = { level: line.level, text: text.replace(UNSAFE, (m) => (m.length === 2 ? m : m < ' ' ? ' ' : '\uFFFD')) };
    const now = this.#deps.now();
    if (now - r.lineWindow >= 1000) {
      r.lineWindow = now;
      r.lineCount = 0;
    }
    if (r.lineCount >= LIMITS.maxBotLogLines || r.lines.length >= LIMITS.maxBotLogLines) return;
    r.lineCount++;
    r.lines.push(line);
  }

  #flush(r: Running): void {
    if (r.lines.length === 0) return;
    const batch = r.lines.slice(0, LIMITS.maxBotLogLines);
    if (this.#deps.sendLog(r.info.id, batch)) r.lines.splice(0, batch.length);
  }

  /** It's gone (removed, or this tab stopped hosting): it leaves if it was in the game. */
  #stop(r: Running): void {
    this.#flush(r);
    r.gone = true;
    r.brain.close();
    this.#running.delete(r.info.id);
    if (r.joined) this.#call(() => this.#adapter?.leave?.(r.info));
    r.joined = false;
  }

  #stopAll(): void {
    for (const r of [...this.#running.values()]) this.#stop(r);
  }
}
