import { describe, expect, test } from 'bun:test';
import { HEALTH_WINDOW_MS, HostHealth, STEP_DOWN_COOLDOWN_MS, type HealthMessage } from '../src/sync/host';

function setup(host = true) {
  let now = 0;
  let isHost = host;
  let ready = true;
  const sent: HealthMessage[] = [];
  const h = new HostHealth({ now: () => now, isHost: () => isHost, ready: () => ready, send: (m) => sent.push(m) });
  /** Tick at `rate` per second for `ms`. */
  const run = (rate: number, ms: number) => {
    const end = now + ms;
    while (now + 1000 / rate <= end) {
      now += 1000 / rate;
      h.tick();
    }
    now = end;
  };
  return { h, sent, run, setHost: (v: boolean) => (isHost = v), setReady: (v: boolean) => (ready = v), kinds: () => sent.map((m) => m.t) };
}

describe('HostHealth', () => {
  test('a host sends a heartbeat about every 250 ms', () => {
    const s = setup();
    s.run(60, 2000);
    const beats = s.kinds().filter((k) => k === 'heartbeat').length;
    expect(beats).toBeGreaterThanOrEqual(7);
    expect(beats).toBeLessThanOrEqual(9);
  });

  test('a non-host sends nothing', () => {
    const s = setup(false);
    s.run(60, 2000);
    expect(s.sent).toEqual([]);
  });

  test('a host whose loop crawls (a hidden Safari tab, ~5/s) steps down once, then waits', () => {
    const s = setup();
    s.run(5, HEALTH_WINDOW_MS + 400); // the window opens at the first tick (200 ms in at 5/s)
    expect(s.kinds().filter((k) => k === 'step_down').length).toBe(1);
    s.run(5, STEP_DOWN_COOLDOWN_MS - 1000);
    expect(s.kinds().filter((k) => k === 'step_down').length).toBe(1);
    s.run(5, 3000);
    expect(s.kinds().filter((k) => k === 'step_down').length).toBe(2);
  });

  test('a healthy host never steps down', () => {
    const s = setup();
    s.run(60, 10_000);
    expect(s.kinds()).not.toContain('step_down');
  });

  test('becoming host starts a fresh measurement', () => {
    const s = setup(false);
    s.run(5, 3000); // slow while not host: doesn't count
    s.setHost(true);
    s.run(60, 2000);
    expect(s.kinds()).not.toContain('step_down');
  });

  test('visibility is reported on change only', () => {
    const s = setup(false);
    s.h.visibility(true);
    s.h.visibility(true);
    s.h.visibility(false);
    expect(s.sent).toEqual([
      { t: 'visibility', hidden: true },
      { t: 'visibility', hidden: false },
    ]);
  });

  test('offline: no heartbeats or step-downs pile up, and measuring starts over after', () => {
    const s = setup();
    s.setReady(false);
    s.run(5, 5000);
    expect(s.sent).toEqual([]);
    s.setReady(true);
    s.run(60, 2000);
    expect(s.kinds()).not.toContain('step_down');
    expect(s.kinds()).toContain('heartbeat');
  });
});
