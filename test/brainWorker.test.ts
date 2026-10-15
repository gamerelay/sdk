import { afterEach, describe, expect, test } from 'bun:test';
import { BrainTimeout, ViewError, workerBrain, type Brain } from '../src/sync/brainWorker';

const open: Brain[] = [];
const brain = (ms?: number) => {
  const b = workerBrain(ms);
  open.push(b);
  return b;
};
afterEach(() => open.splice(0).forEach((b) => b.close()));

describe('workerBrain', () => {
  test('runs the function with view and memory, and returns its action and lines', async () => {
    const b = brain();
    expect(await b.load('(view, memory) => { memory.n = (memory.n ?? 0) + 1; log("n", memory.n); return { steer: view.game.turn * 2 }; }')).toBeNull();
    const first = await b.step({ game: { turn: 0.25 } });
    expect(first.action).toEqual({ steer: 0.5 });
    expect(first.lines).toEqual([{ level: 'info', text: 'n 1' }]);
    expect((await b.step({ game: { turn: 0 } })).lines[0]?.text).toBe('n 2');
  });

  test('load refuses what isn\'t a function', async () => {
    expect(await brain().load('42')).toContain('function');
    expect(await brain().load('(() => {')).toBeTruthy();
  });

  test('a brain whose last line is a // comment still loads', async () => {
    const b = brain();
    expect(await b.load('() => 7\n// the end')).toBeNull();
    expect((await b.step({})).action).toBe(7);
  });

  test('a brain that throws: no action, the error as a warn line', async () => {
    const b = brain();
    await b.load('() => { throw new Error("boom"); }');
    const out = await b.step({});
    expect(out.action).toBeUndefined();
    expect(out.lines).toEqual([{ level: 'warn', text: 'Error: boom' }]);
  });

  test('junk out becomes JSON or nothing', async () => {
    const b = brain();
    await b.load('(v) => v.k === 1 ? { f: () => 1, n: NaN, s: "x" } : v.k === 2 ? (() => 1) : "y".repeat(5000)');
    expect((await b.step({ k: 1 })).action).toEqual({ n: null, s: 'x' });
    expect((await b.step({ k: 2 })).action).toBeUndefined();
    const big = await b.step({ k: 3 });
    expect(big.action).toBeUndefined(); // over 4 KB of JSON
    expect(big.lines[0]?.level).toBe('warn');
  });

  test('no network, no imports: those globals are gone', async () => {
    const b = brain();
    await b.load('() => [typeof fetch, typeof WebSocket, typeof XMLHttpRequest, typeof importScripts, typeof postMessage]');
    expect((await b.step({})).action).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  test('lines are capped and cut', async () => {
    const b = brain();
    await b.load('() => { for (let k = 0; k < 50; k++) log("x".repeat(500)); return 1; }');
    const out = await b.step({});
    expect(out.lines.length).toBe(20);
    expect(out.lines[0]!.text.length).toBe(200);
  });

  test('a brain that never returns times out, and the brain is closed', async () => {
    const b = brain(100);
    await b.load('() => { while (true) {} }');
    await expect(b.step({})).rejects.toBeInstanceOf(BrainTimeout);
    await expect(b.step({})).rejects.toBeInstanceOf(BrainTimeout); // the Worker is gone
  });

  test('eval, Function constructors, import() and FontFace are out', async () => {
    const b = brain();
    await b.load('() => [typeof eval, typeof (() => 0).constructor, typeof (async () => 0).constructor, typeof FontFace, typeof WebSocketStream]');
    expect((await b.step({})).action).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    expect(await brain().load('() => import("x")')).toContain('import');
  });

  test('a thrown value that cannot be shown does not kill the bot', async () => {
    const b = brain();
    await b.load('() => { throw Object.create(null); }');
    const out = await b.step({});
    expect(out.lines).toEqual([{ level: 'warn', text: 'a value that cannot be shown' }]);
  });
});

describe('a second load is a fresh Worker', () => {
  test('memory starts over', async () => {
    const b = brain();
    const src = '(v, m) => (m.n = (m.n ?? 0) + 1)';
    await b.load(src);
    await b.step({});
    expect((await b.step({})).action).toBe(2);
    await b.load(src);
    expect((await b.step({})).action).toBe(1);
  });
  test('the old Worker is terminated', async () => {
    let made = 0;
    let terminated = 0;
    const makeWorker = (url: string) => {
      made++;
      const real = new Worker(url);
      const terminate = real.terminate.bind(real);
      real.terminate = () => (terminated++, terminate());
      return real;
    };
    const b = workerBrain(250, makeWorker);
    open.push(b);
    await b.load('() => 1');
    await b.load('() => 2');
    expect([made, terminated]).toEqual([2, 1]);
    expect((await b.step({})).action).toBe(2);
  });
  test('a load after a timeout brings the bot back', async () => {
    const b = brain(100);
    await b.load('() => { while (true) {} }');
    await expect(b.step({})).rejects.toBeInstanceOf(BrainTimeout);
    await b.load('() => 3');
    expect((await b.step({})).action).toBe(3);
  });
  test('a brain cannot re-enter the handler to load or step again', async () => {
    const b = brain();
    await b.load('(v, m) => { try { self.onmessage({ data: { t: "load", src: "() => 9" } }); } catch (e) {} self.dispatchEvent(new MessageEvent("message", { data: { t: "step", view: {} } })); return 5; }');
    const out = await b.step({});
    expect(out.action).toBe(5);
  });
});

describe('the game\'s side', () => {
  test('a view that cannot be sent (a function in it) rejects with ViewError; the brain and its memory go on', async () => {
    const b = brain();
    await b.load('(v, m) => { m.n = (m.n ?? 0) + 1; return m.n; }');
    expect((await b.step({})).action).toBe(1);
    const bad = { car: { steer: () => 0 } } as unknown as Parameters<Brain['step']>[0];
    const err = await b.step(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViewError);
    expect(err).not.toBeInstanceOf(BrainTimeout);
    expect((await b.step({})).action).toBe(2);
  });

  test('a load gets longer than a step: starting the Worker is part of it', async () => {
    const w: any = {
      postMessage(msg: { t: string; id: number }) {
        setTimeout(() => w.onmessage({ data: { t: 'loaded', error: null, id: msg.id } }), 400); // a slow cold start
      },
      terminate() {},
    };
    const b = workerBrain(250, () => w);
    open.push(b);
    expect(await b.load('() => 1')).toBeNull();
  });
});

describe('replies from the Worker are validated', () => {
  // A fake Worker that answers load and step with the given replies (a missing one is a plain success).
  const forged = (replies: { loaded?: unknown; stepped?: unknown }) => {
    const w: any = {
      postMessage(msg: { t: string; id: number }) {
        const r = msg.t === 'load' ? (replies.loaded ?? { t: 'loaded', error: null }) : replies.stepped;
        setTimeout(() => w.onmessage({ data: r && typeof r === 'object' ? { ...r, id: msg.id } : r }), 0);
      },
      terminate() {},
    };
    const b = workerBrain(250, () => w);
    open.push(b);
    return b;
  };
  const stepOf = async (stepped: unknown) => {
    const b = forged({ stepped });
    await b.load('() => 1');
    return b.step({});
  };
  test('step keeps only well-formed lines, a short JSON action and a finite ms', async () => {
    const lines = [{ level: 'info', text: 'x'.repeat(500) }, { level: 'evil', text: 'a' }, { level: 'warn', text: 5 }, null, ...Array.from({ length: 40 }, () => ({ level: 'info', text: 'k' }))];
    const out = await stepOf({ t: 'stepped', action: '{"a":1}', lines, ms: 'x' });
    expect(out.action).toEqual({ a: 1 });
    expect(out.lines.length).toBe(20);
    expect(out.lines[0]!.text.length).toBe(200);
    expect(out.lines.every((l) => l.level === 'info')).toBe(true);
    expect(out.ms).toBe(0);
  });
  test('an oversized, non-string or unparsable action is dropped', async () => {
    expect((await stepOf({ t: 'stepped', action: 'y'.repeat(5000), lines: [], ms: 1 })).action).toBeUndefined();
    expect((await stepOf({ t: 'stepped', action: { a: 1 }, lines: 'no', ms: 1 })).action).toBeUndefined();
    const bad = await stepOf({ t: 'stepped', action: '{nope', lines: [], ms: 1 });
    expect(bad.action).toBeUndefined();
    expect(bad.lines[0]?.level).toBe('warn');
  });
  test('load takes only a string error', async () => {
    expect(await forged({ loaded: { t: 'loaded', error: { x: 1 } } }).load('() => 1')).toBeNull();
    expect(await forged({ loaded: { t: 'loaded', error: 'nope' } }).load('() => 1')).toBe('nope');
  });
  test('a reply of the wrong kind is refused and the brain stopped', async () => {
    const b = forged({ stepped: { t: 'loaded', error: null } });
    await b.load('() => 1');
    await expect(b.step({})).rejects.toBeInstanceOf(BrainTimeout);
    await expect(b.step({})).rejects.toBeInstanceOf(BrainTimeout);
  });
  // A fake Worker that answers nothing by itself; `sent` holds each request's id.
  const silent = (ms = 250) => {
    const sent: number[] = [];
    const w: any = { postMessage(m: { id: number }) { sent.push(m.id); }, terminate() {} };
    const b = workerBrain(ms, () => w);
    open.push(b);
    return { b, w, sent };
  };
  test('a reply with nothing pending is ignored', async () => {
    const { b, w, sent } = silent();
    const loading = b.load('() => 1');
    w.onmessage({ data: { t: 'loaded', id: sent[0], error: null } });
    expect(await loading).toBeNull();
    w.onmessage({ data: { t: 'stepped', id: sent[0], action: '666' } }); // nothing pending: dropped, not kept for the next step
    const stepping = b.step({});
    w.onmessage({ data: { t: 'stepped', id: sent[1], action: '1', lines: [], ms: 1 } });
    expect((await stepping).action).toBe(1);
  });
  test('a late reply to an earlier request is ignored: replies are matched by id', async () => {
    const { b, w, sent } = silent(50);
    const loading = b.load('() => 1');
    w.onmessage({ data: { t: 'loaded', id: sent[0], error: null } });
    await loading;
    await expect(b.step({})).rejects.toBeInstanceOf(BrainTimeout); // step sent[1] never answered
    const reloading = b.load('() => 1');
    w.onmessage({ data: { t: 'loaded', id: sent[2], error: null } });
    await reloading;
    const stepping = b.step({});
    w.onmessage({ data: { t: 'stepped', id: sent[1], action: '666', lines: [], ms: 1 } }); // the timed-out step's reply, late
    w.onmessage({ data: { t: 'stepped', id: sent[3], action: '1', lines: [], ms: 1 } });
    expect((await stepping).action).toBe(1);
    expect(new Set(sent).size).toBe(4);
  });
  test('a Worker error stops the brain with a BrainTimeout, its message capped', async () => {
    const huge = 'x'.repeat(100_000);
    const w: any = { postMessage() { setTimeout(() => w.onerror({ message: huge, preventDefault() {} }), 0); }, terminate() {} };
    const b = workerBrain(250, () => w);
    open.push(b);
    const err = await b.load('() => 1').catch((e) => e);
    expect(err).toBeInstanceOf(BrainTimeout);
    expect(err.message.startsWith('the brain failed: xxx')).toBe(true);
    expect(err.message.length).toBeLessThanOrEqual(250);
  });
  test('a Worker error during a step stops the brain: this step and the next reject with BrainTimeout', async () => {
    const { b, w, sent } = silent();
    const loading = b.load('() => 1');
    w.onmessage({ data: { t: 'loaded', id: sent[0], error: null } });
    await loading;
    const stepping = b.step({}).catch((e) => e);
    w.onerror({ message: 'DataCloneError: '.padEnd(100_000, 'y'), preventDefault() {} });
    const err = await stepping;
    expect(err).toBeInstanceOf(BrainTimeout);
    expect(err.message.length).toBeLessThanOrEqual(250);
    await expect(b.step({})).rejects.toBeInstanceOf(BrainTimeout);
  });
  test('a main-thread stall that fires the watchdog late gets one more grace period, not a halt', async () => {
    const { b, w, sent } = silent(50);
    const loading = b.load('() => 1');
    w.onmessage({ data: { t: 'loaded', id: sent[0], error: null } });
    await loading;
    let failed: unknown = null;
    const stepping = b.step({}).catch((e) => ((failed = e), null));
    for (const end = performance.now() + 200; performance.now() < end; ); // a shader compile, say
    await new Promise((r) => setTimeout(r, 5)); // the overdue watchdog fires now, 150 ms late
    expect(failed).toBeNull();
    w.onmessage({ data: { t: 'stepped', id: sent[1], action: '1', lines: [], ms: 1 } });
    expect((await stepping)?.action).toBe(1);
  });
  test('a brain still silent after that grace period is stopped', async () => {
    const { b, w, sent } = silent(50);
    const loading = b.load('() => 1');
    w.onmessage({ data: { t: 'loaded', id: sent[0], error: null } });
    await loading;
    const stepping = b.step({}).catch((e) => e);
    for (const end = performance.now() + 200; performance.now() < end; );
    expect(await stepping).toBeInstanceOf(BrainTimeout);
  });
  test('a Worker that cannot be made rejects load with a BrainTimeout', async () => {
    const b = workerBrain(250, () => { throw new Error('no Workers here'); });
    open.push(b);
    await expect(b.load('() => 1')).rejects.toBeInstanceOf(BrainTimeout);
  });
});
