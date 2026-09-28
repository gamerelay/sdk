import { describe, expect, test } from 'bun:test';
import { Claims } from '../src/sync/claims';

function setup(me = 'pa', host = false) {
  const queued: { t: string; key: string }[] = [];
  const fired: [string, string, string][] = [];
  const warns: string[] = [];
  let isHost = host;
  const c = new Claims({
    me,
    isHost: () => isHost,
    queue: (m) => queued.push(m),
    fire: (e, key, id) => fired.push([e, key, id]),
    warn: (_kind, key) => warns.push(key),
  });
  const claimed = (key: string, playerId: string) => c.receive({ v: 1, t: 'claimed', key, playerId });
  const released = (key: string, playerId: string) => c.receive({ v: 1, t: 'released', key, playerId });
  const result = (key: string, holder: string | null) => c.receive({ v: 1, t: 'claim_result', key, holder });
  return { c, queued, fired, warns, claimed, released, result, setHost: (h: boolean) => (isHost = h) };
}

/** Settled value of a promise, or 'pending'. */
async function peek<T>(p: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 5))]);
}

describe('Claims', () => {
  test('a claim sends once and resolves from claim_result', async () => {
    const s = setup();
    const p = s.c.claim('pu:1');
    expect(s.queued).toEqual([{ t: 'claim', key: 'pu:1' }]);
    s.claimed('pu:1', 'pa');
    s.result('pu:1', 'pa');
    expect(await p).toBe(true);
    expect(s.c.holder('pu:1')).toBe('pa');
    expect(s.fired).toEqual([['claimed', 'pu:1', 'pa']]);
  });

  test('losing resolves false; someone else’s broadcast doesn’t settle my claim early', async () => {
    const s = setup();
    const p = s.c.claim('k');
    s.claimed('k', 'pb');
    expect(await peek(p)).toBe('pending');
    s.result('k', 'pb');
    expect(await p).toBe(false);
    expect(s.c.holder('k')).toBe('pb');
  });

  test('the same key while waiting returns the same promise and sends once', () => {
    const s = setup();
    const a = s.c.claim('k');
    const b = s.c.claim('k');
    expect(a).toBe(b);
    expect(s.queued).toHaveLength(1);
  });

  test('a key already held answers at once without asking', async () => {
    const s = setup();
    s.claimed('mine', 'pa');
    s.claimed('theirs', 'pb');
    expect(await s.c.claim('mine')).toBe(true);
    expect(await s.c.claim('theirs')).toBe(false);
    expect(s.queued).toEqual([]);
  });

  test('release: only the holder or the host; free keys do nothing', () => {
    const s = setup();
    s.c.release('free');
    expect(s.queued).toEqual([]);
    s.claimed('mine', 'pa');
    s.c.release('mine');
    expect(s.queued).toEqual([{ t: 'release', key: 'mine' }]);
    expect(s.c.holder('mine')).toBe('pa'); // until the server says so
    s.released('mine', 'pa');
    expect(s.c.holder('mine')).toBeNull();
    expect(s.fired.at(-1)).toEqual(['released', 'mine', 'pa']);
    s.claimed('theirs', 'pb');
    expect(() => s.c.release('theirs')).toThrow(/only the player holding it, or the host/);
    s.setHost(true);
    s.c.release('theirs');
    expect(s.queued.at(-1)).toEqual({ t: 'release', key: 'theirs' });
  });

  test('bad keys throw', () => {
    const s = setup();
    expect(() => s.c.claim('')).toThrow(/1–128 characters/);
    expect(() => s.c.claim('x'.repeat(129))).toThrow(/1–128 characters/);
    expect(() => s.c.claim(5 as unknown as string)).toThrow(/1–128 characters/);
    expect(() => s.c.release('')).toThrow(/1–128 characters/);
  });

  test('the room at its limit: false and one warning', async () => {
    const s = setup();
    const p = s.c.claim('a');
    s.result('a', null);
    expect(await p).toBe(false);
    const q = s.c.claim('b');
    s.result('b', null);
    expect(await q).toBe(false);
    expect(s.warns).toEqual(['claims:limit']);
  });

  test('sync after a reconnect settles pending claims from the table, re-sends the rest', async () => {
    const s = setup();
    s.claimed('old', 'pb');
    const a = s.c.claim('a');
    const b = s.c.claim('b');
    s.queued.length = 0;
    s.fired.length = 0;
    s.c.sync({ a: 'pa', c: 'pb' });
    expect(await a).toBe(true);
    expect(await peek(b)).toBe('pending');
    expect(s.queued).toEqual([{ t: 'claim', key: 'b' }]);
    expect(s.fired).toEqual([
      ['released', 'old', 'pb'],
      ['claimed', 'a', 'pa'],
      ['claimed', 'c', 'pb'],
    ]);
    s.result('b', 'pa');
    expect(await b).toBe(true);
  });

  test('close resolves every pending claim false', async () => {
    const s = setup();
    const a = s.c.claim('a');
    s.c.close();
    expect(await a).toBe(false);
  });
});
