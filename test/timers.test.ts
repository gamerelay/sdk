import { describe, expect, spyOn, test } from 'bun:test';
import type { JsonObject } from '@gamerelay/protocol/types';
import { TIMERS_KEY, Timers } from '../src/sync/timers';

function setup(opts: { host?: boolean; state?: JsonObject } = {}) {
  let now = 10_000;
  let host = opts.host ?? true;
  const shared = { state: opts.state ?? ({} as JsonObject) };
  const patches: JsonObject[] = [];
  const fired: string[] = [];
  const handlers: Record<string, () => void> = {};
  let ready = true;
  let batched = 0;
  const deps = {
    ready: () => ready,
    batch: (fn: () => void) => {
      // Like the room: every setState inside is merged into one patch.
      const merged: JsonObject = {};
      const real = deps.setState;
      deps.setState = (patch: JsonObject) => {
        Object.assign(merged, patch);
        shared.state = { ...shared.state, ...patch };
      };
      try {
        fn();
      } finally {
        deps.setState = real;
      }
      batched++;
      real(merged);
    },
    now: () => now,
    isHost: () => host,
    state: () => shared.state,
    setState: (patch: JsonObject) => {
      patches.push(patch);
      shared.state = { ...shared.state, ...patch };
    },
    fire: (name: string) => {
      fired.push(name);
      handlers[name]?.();
    },
  };
  return {
    t: new Timers(deps),
    deps,
    shared,
    patches,
    fired,
    handlers,
    tick: (ms: number) => (now += ms),
    setHost: (v: boolean) => (host = v),
    setReady: (v: boolean) => (ready = v),
    batches: () => batched,
  };
}

describe('Timers', () => {
  test('set stores a deadline on the server clock in room state', () => {
    const s = setup();
    s.t.set('round', 5000);
    expect(s.shared.state[TIMERS_KEY]).toEqual({ round: 15_000 });
  });

  test('timeLeft counts down to 0, and is null for unknown timers', () => {
    const s = setup();
    s.t.set('round', 5000);
    s.tick(2000);
    expect(s.t.left('round')).toBe(3000);
    s.tick(9000);
    expect(s.t.left('round')).toBe(0);
    expect(s.t.left('nope')).toBeNull();
  });

  test('the host fires a due timer once, then clears it in one patch', () => {
    const s = setup();
    s.t.set('round', 1000);
    s.patches.length = 0;
    s.t.tick();
    expect(s.fired).toEqual([]);
    s.tick(1000);
    s.t.tick();
    s.t.tick();
    expect(s.fired).toEqual(['round']);
    expect(s.patches).toEqual([{ [TIMERS_KEY]: {} }]);
  });

  test('non-hosts never fire', () => {
    const s = setup();
    s.t.set('round', 0);
    s.setHost(false);
    s.t.tick();
    expect(s.fired).toEqual([]);
  });

  test('two due timers in one tick clear in a single patch', () => {
    const s = setup();
    s.t.set('a', 0);
    s.t.set('b', 0);
    s.patches.length = 0;
    s.t.tick();
    expect(s.fired.sort()).toEqual(['a', 'b']);
    expect(s.patches.length).toBe(1);
  });

  test('a handler can re-arm its own timer', () => {
    const s = setup();
    s.handlers.pu = () => s.t.set('pu', 5000);
    s.t.set('pu', 0);
    s.t.tick();
    expect(s.t.left('pu')).toBe(5000);
  });

  test('a throwing handler still clears its timer', () => {
    const s = setup();
    const err = spyOn(console, 'error').mockImplementation(() => {});
    s.handlers.boom = () => {
      throw new Error('game bug');
    };
    s.t.set('boom', 0);
    s.t.tick();
    expect(s.t.left('boom')).toBeNull();
    err.mockRestore();
  });

  test('only the host sets timers; bad names and times throw', () => {
    const s = setup({ host: false });
    expect(() => s.t.set('round', 100)).toThrow(/only the host can start timers/);
    const h = setup();
    expect(() => h.t.set('9x', 100)).toThrow(/isn't a valid timer name/);
    expect(() => h.t.set('x', -1)).toThrow(/0 or more/);
    expect(() => h.t.set('x', Number.NaN)).toThrow(/0 or more/);
  });

  test('across a handover: a timer the old host cleared never fires again; one it didn’t fires once', () => {
    const old = setup();
    old.t.set('done', 0);
    old.t.set('pending', 500);
    old.t.tick(); // fires 'done' and clears it
    const next = setup({ state: old.shared.state });
    next.tick(1000);
    next.t.tick();
    next.t.tick();
    expect(next.fired).toEqual(['pending']);
  });

  test('nothing fires while disconnected (it would fire again after the resume)', () => {
    const s = setup();
    s.t.set('round', 0);
    s.setReady(false);
    s.t.tick();
    expect(s.fired).toEqual([]);
    s.setReady(true);
    s.t.tick();
    expect(s.fired).toEqual(['round']);
  });

  test('the handlers’ changes and the clear go out as one patch', () => {
    const s = setup();
    s.handlers.round = () => s.deps.setState({ score: 3 });
    s.t.set('round', 0);
    s.patches.length = 0;
    s.t.tick();
    expect(s.patches).toEqual([{ score: 3, [TIMERS_KEY]: {} }]);
    expect(s.batches()).toBe(1);
  });
  test('firing is true only while handlers run, so their sends go out host-only (even if one throws)', () => {
    const s = setup();
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const seen: boolean[] = [];
    s.handlers.a = () => seen.push(s.t.firing);
    s.handlers.b = () => {
      throw new Error('game bug');
    };
    s.t.set('a', 0);
    s.t.set('b', 0);
    expect(s.t.firing).toBe(false);
    s.t.tick();
    expect(seen).toEqual([true]);
    expect(s.t.firing).toBe(false);
    err.mockRestore();
  });
});
