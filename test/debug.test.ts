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

  test('mounting outside a browser does nothing', () => {
    const unmount = mountOverlay(() => {
      throw new Error('should not read');
    });
    expect(() => unmount()).not.toThrow();
  });
});
