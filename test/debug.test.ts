import { describe, expect, spyOn, test } from 'bun:test';
import { formatOverlay, mountOverlay } from '../src/debug/overlay';
import { SECTIONS, Warnings } from '../src/debug/warnings';

describe('Warnings', () => {
  test('print once per key with the llms.txt section to read, then count', () => {
    const spy = spyOn(console, 'warn').mockImplementation(() => {});
    const w = new Warnings();
    w.warn('jump', 'jump:ship', 'ship jumped');
    w.warn('jump', 'jump:ship', 'ship jumped');
    w.warn('emit', 'emit:hit', 'too many hits');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0]).toBe('[gamerelay] ship jumped (llms.txt: "## Entities", https://gamerelay.io/llms.txt)');
    expect(w.list()).toEqual([
      { message: 'ship jumped', count: 2 },
      { message: 'too many hits', count: 1 },
    ]);
    spy.mockRestore();
  });

  test('every section named in the catalog is a real llms.txt heading', async () => {
    const guide = await Bun.file(new URL('../llms.txt', import.meta.url)).text();
    for (const section of Object.values(SECTIONS)) expect(guide).toContain(`\n## ${section}\n`);
  });
});

describe('overlay', () => {
  test('formats the numbers a person debugging needs', () => {
    const text = formatOverlay({
      ping: 42,
      delayMs: 118.4,
      msgsIn: 40,
      msgsOut: 21,
      bytesIn: 3072,
      bytesOut: 1536,
      entities: { ship: 3, drone: 12 },
      host: true,
      warnings: [{ message: 'ship jumped', count: 2 }],
    });
    expect(text).toBe(
      [
        'gamerelay debug',
        'ping 42 ms · smoothing 118 ms · host',
        'frames/s 40 in · 21 out',
        'KB/s 3.0 in · 1.5 out',
        'entities ship 3 · drone 12',
        '! ship jumped (×2)',
      ].join('\n'),
    );
  });

  test('the LAN line shows the open channels’ round trips once known (reliability review)', () => {
    const base = { ping: 1, delayMs: 0, msgsIn: 0, msgsOut: 0, bytesIn: 0, bytesOut: 0, entities: {}, host: false, warnings: [] };
    const line = (rttMs: Record<string, number>) => formatOverlay({ ...base, lan: { peers: 2, lanFirst: 5, serverFirst: 1, rttMs } }).split('\n').at(-1);
    expect(line({})).toBe('lan 2 peers · first 5 lan · 1 server');
    expect(line({ a: 12 })).toBe('lan 2 peers · first 5 lan · 1 server · rtt 12 ms');
    expect(line({ a: 31, b: 4 })).toBe('lan 2 peers · first 5 lan · 1 server · rtt 4–31 ms');
  });

  test('mounting outside a browser does nothing', () => {
    const unmount = mountOverlay(() => {
      throw new Error('should not read');
    });
    expect(() => unmount()).not.toThrow();
  });
});
