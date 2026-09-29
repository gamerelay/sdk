import { describe, expect, test } from 'bun:test';
import type { Json } from '@gamerelay/protocol/types';
import { Inputs, MAX_HELD_KEYS } from '../src/sync/inputs';
import { FakeNet } from './fakeNet';

function setup() {
  const net = new FakeNet({ latency: 20 });
  net.host = 'pa';
  const ins: Record<string, Inputs> = {};
  const live: Record<string, boolean> = { pa: true, pb: true, pc: true };
  for (const [id, name] of [['pa', 'ada'], ['pb', 'bo'], ['pc', 'cy']] as const) {
    const t = net.join(id, name, (d, from) => void ins[id]!.receive(d, from));
    ins[id] = new Inputs(t);
  }
  /** Advance fake time in 10 ms steps, ticking every live player's inputs. */
  const run = (ms: number) => {
    const end = net.now + ms;
    while (net.now < end) {
      net.advanceTo(Math.min(end, net.now + 10));
      for (const [id, i] of Object.entries(ins)) if (live[id]) i.tick();
    }
  };
  const sentInputs = (from: string) =>
    net.sent.filter((m) => m.from === from && (m.data as { $gr?: string } | null)?.$gr === 'i') as {
      to?: string;
      reliable: boolean;
      data: { k: string; s: number; d: Record<string, Json> };
    }[];
  return { net, a: ins.pa!, b: ins.pb!, c: ins.pc!, run, sentInputs, stop: (id: string) => (live[id] = false) };
}

describe('Inputs', () => {
  test('the latest input reaches the host, at most every 50 ms', () => {
    const s = setup();
    s.b.set({ left: false, ax: 0.5 });
    s.run(10);
    s.b.set({ left: false, ax: 1 }); // within 50 ms: coalesced
    s.run(200);
    expect(s.a.get('pb')).toEqual({ left: false, ax: 1 });
    const sends = s.sentInputs('pb');
    expect(sends.every((m) => m.to === 'pa')).toBe(true);
    for (let i = 1; i < sends.length; i++) expect(sends[i]!.data.s).toBeGreaterThan(sends[i - 1]!.data.s);
    expect(sends.length).toBeLessThanOrEqual(3);
  });

  test('a tap between two sends still reaches the host as true', () => {
    const s = setup();
    s.b.set({ fire: false });
    s.run(100);
    s.b.set({ fire: true });
    s.b.set({ fire: false }); // released before the next send
    const seen: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      s.run(10);
      seen.push(s.a.get('pb').fire === true);
    }
    expect(seen).toContain(true);
    expect(seen.at(-1)).toBe(false);
  });

  test('a press goes reliable; steady input goes unreliable', () => {
    const s = setup();
    s.b.set({ fire: false, ax: 0 });
    s.run(60);
    s.b.set({ fire: false, ax: 0.3 });
    s.run(60);
    s.b.set({ fire: true, ax: 0.3 });
    s.run(60);
    expect(s.sentInputs('pb').map((m) => m.reliable)).toEqual([false, false, true]);
  });

  test('silent for 500 ms reads as neutral: booleans false, numbers 0', () => {
    const s = setup();
    s.b.set({ left: true, ax: 1, name: 'x' });
    s.run(100);
    expect(s.a.get('pb')).toEqual({ left: true, ax: 1, name: 'x' });
    s.stop('pb'); // its page froze
    s.run(600);
    expect(s.a.get('pb')).toEqual({ left: false, ax: 0, name: 'x' });
  });

  test('an unchanged input repeats every 200 ms so it never goes stale', () => {
    const s = setup();
    for (let i = 0; i < 125; i++) {
      s.b.set({ up: true }); // the game calls input() every frame
      s.run(16);
    }
    expect(s.a.get('pb')).toEqual({ up: true });
    const n = s.sentInputs('pb').length;
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(12);
  });

  test('older sequence numbers are ignored; a new session starts fresh', () => {
    const s = setup();
    s.a.receive({ $gr: 'i', k: 'one', s: 5, d: { ax: 1 } }, 'pb');
    s.a.receive({ $gr: 'i', k: 'one', s: 4, d: { ax: -1 } }, 'pb');
    expect(s.a.get('pb')).toEqual({ ax: 1 });
    s.a.receive({ $gr: 'i', k: 'two', s: 1, d: { ax: 0.5 } }, 'pb'); // reloaded page
    expect(s.a.get('pb')).toEqual({ ax: 0.5 });
  });

  test('the host reads its own input directly, and nothing is sent', () => {
    const s = setup();
    s.a.set({ fire: true });
    s.a.set({ fire: false });
    expect(s.a.get('pa')).toEqual({ fire: true }); // latched until the next 50 ms beat
    s.run(100);
    expect(s.a.get('pa')).toEqual({ fire: false });
    expect(s.sentInputs('pa')).toEqual([]);
  });

  test('non-hosts ignore inputs sent to them', () => {
    const s = setup();
    expect(s.c.receive({ $gr: 'i', k: 'one', s: 1, d: { ax: 1 } }, 'pb')).toBe(true);
    expect(s.c.get('pb')).toEqual({});
    expect(s.c.receive({ $gr: 'e', n: 'x' }, 'pb')).toBe(false);
  });

  test('big or non-JSON inputs throw', () => {
    const s = setup();
    expect(() => s.b.set({ blob: 'x'.repeat(2000) })).toThrow(/under 1 KB/);
    expect(() => s.b.set([1] as unknown as Record<string, Json>)).toThrow(/plain object/);
    expect(() => s.b.set({ n: 1n } as unknown as Record<string, Json>)).toThrow(/JSON/);
  });

  test('after a host change the next tick sends to the new host at once', () => {
    const s = setup();
    s.b.set({ up: true });
    s.run(20);
    s.net.host = 'pc';
    s.b.hostChanged();
    s.run(10);
    expect(s.sentInputs('pb').at(-1)?.to).toBe('pc');
    s.run(50);
    expect(s.c.get('pb')).toEqual({ up: true });
  });

  test('unknown players read as {}; players who left are forgotten', () => {
    const s = setup();
    expect(s.a.get('nobody')).toEqual({});
    s.b.set({ up: true });
    s.run(100);
    s.a.playerLeft('pb');
    expect(s.a.get('pb')).toEqual({});
  });
  test('a page that stops calling input() (a hidden tab) sends neutral once, then goes quiet', () => {
    const s = setup();
    s.b.set({ ax: 1, kick: false });
    s.run(100);
    expect(s.a.get('pb')).toEqual({ ax: 1, kick: false });
    s.run(600); // the SDK loop keeps ticking, but nobody calls input()
    expect(s.a.get('pb')).toEqual({ ax: 0, kick: false });
    const n = s.sentInputs('pb').length;
    s.run(1000);
    expect(s.sentInputs('pb').length).toBe(n);
    s.b.set({ ax: -1, kick: false }); // back
    s.run(100);
    expect(s.a.get('pb')).toEqual({ ax: -1, kick: false });
  });

  test('a press and its release arriving together still read as a press on the host', () => {
    const s = setup();
    s.a.receive({ $gr: 'i', k: 'one', s: 1, d: { kick: true } }, 'pb');
    s.a.receive({ $gr: 'i', k: 'one', s: 2, d: { kick: false } }, 'pb');
    expect(s.a.get('pb')).toEqual({ kick: true });
    s.run(60);
    expect(s.a.get('pb')).toEqual({ kick: false });
  });

  test('the host’s own tap lasts 50 ms from the press, wherever it falls', () => {
    const s = setup();
    s.run(59); // just before a 50 ms beat (beats at 10, 60, 110… in this setup)
    s.a.set({ kick: true });
    s.a.set({ kick: false });
    s.run(10);
    expect(s.a.get('pa')).toEqual({ kick: true });
    s.run(50);
    expect(s.a.get('pa')).toEqual({ kick: false });
  });

  test('the host holds at most 32 presses per player, and forgets each once it has shown (security review)', () => {
    const s = setup();
    const keys = (from: number, n: number, v: boolean) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${from + i}`, v]));
    const heldNow = () => Object.values(s.a.get('pb')).filter((v) => v === true).length;
    // 100 distinct presses, released at once: only 32 are held.
    s.a.receive({ $gr: 'i', k: 'one', s: 1, d: keys(0, 100, true) }, 'pb');
    s.a.receive({ $gr: 'i', k: 'one', s: 2, d: {} }, 'pb');
    expect(heldNow()).toBe(MAX_HELD_KEYS);
    // Once those have shown, new key names are held again: the old ones don't sit in the cap for ever.
    s.run(60);
    expect(heldNow()).toBe(0);
    s.a.receive({ $gr: 'i', k: 'one', s: 3, d: keys(100, 10, true) }, 'pb');
    s.a.receive({ $gr: 'i', k: 'one', s: 4, d: {} }, 'pb');
    expect(heldNow()).toBe(10);
  });
});
