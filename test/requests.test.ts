import { describe, expect, spyOn, test } from 'bun:test';
import type { Json } from '@gamerelay/protocol/types';
import { GameRelayError } from '../src/errors';
import { RequestRejection, Requests } from '../src/sync/requests';
import { FakeNet } from './fakeNet';

function setup() {
  const net = new FakeNet({ latency: 40 });
  net.host = 'pa';
  const warns: string[] = [];
  const warn = (_kind: string, key: string) => warns.push(key);
  const reqs: Record<string, Requests> = {};
  for (const [id, name] of [['pa', 'ada'], ['pb', 'bo'], ['pc', 'cy']] as const) {
    const t = net.join(id, name, (d, from) => void reqs[id]!.receive(d, from));
    reqs[id] = new Requests(t, warn);
  }
  /** Advance fake time in small steps, letting async handlers run in between. */
  const run = async (ms: number) => {
    const end = net.now + ms;
    while (net.now < end) {
      net.advanceTo(Math.min(end, net.now + 10));
      for (let i = 0; i < 5; i++) await Promise.resolve();
      for (const r of Object.values(reqs)) r.tick();
    }
  };
  return { net, a: reqs.pa!, b: reqs.pb!, c: reqs.pc!, warns, run };
}

const answers = (net: FakeNet) => net.sent.filter((m) => (m.data as { $gr?: string } | null)?.$gr === 'a');
const asks = (net: FakeNet) => net.sent.filter((m) => (m.data as { $gr?: string } | null)?.$gr === 'q');

describe('Requests', () => {
  test('a request reaches the host’s handler and resolves with its result', async () => {
    const s = setup();
    s.a.onRequest('buy', (d, from) => ({ ok: true, item: (d as { item: string }).item, from }));
    const p = s.b.request('buy', { item: 'sword' });
    await s.run(200);
    expect(await p).toEqual({ ok: true, item: 'sword', from: 'pb' });
  });

  test('throw room.reject(reason) rejects the caller with that reason', async () => {
    const s = setup();
    s.a.onRequest('buy', () => {
      throw new RequestRejection('Not enough gold');
    });
    const p = s.b.request('buy', null);
    await s.run(200);
    await expect(p).rejects.toMatchObject({ code: 'rejected', message: 'Not enough gold' });
  });

  test('an async handler is awaited, and undefined becomes null', async () => {
    const s = setup();
    s.a.onRequest('slow', async () => {
      await Promise.resolve();
      return 7;
    });
    s.a.onRequest('nothing', () => undefined);
    const p = s.b.request('slow', null);
    const q = s.b.request('nothing', null);
    await s.run(200);
    expect(await p).toBe(7);
    expect(await q).toBeNull();
  });

  test('no handler, or a handler that throws, rejects with a message saying so', async () => {
    const s = setup();
    const quiet = spyOn(console, 'error').mockImplementation(() => {});
    s.a.onRequest('boom', () => {
      throw new Error('kaput');
    });
    const p = s.b.request('missing', null);
    const q = s.b.request('boom', null);
    await s.run(200);
    await expect(p).rejects.toThrow(/has no room\.onRequest\('missing'/);
    await expect(q).rejects.toThrow(/handler threw: kaput/);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  test('an identical request waiting returns the same promise, sends once, and warns', async () => {
    const s = setup();
    const p = s.b.request('sit', { seat: 2 });
    const q = s.b.request('sit', { seat: 2 });
    expect(q).toBe(p);
    expect(asks(s.net)).toHaveLength(1);
    expect(s.warns).toEqual(['request:sit']);
    s.a.onRequest('sit', () => true);
    await s.run(200);
    expect(await q).toBe(true);
    const again = s.b.request('sit', { seat: 2 }); // settled: a new request
    expect(again).not.toBe(p);
    await s.run(200);
  });

  test('different data is a different request', () => {
    const s = setup();
    expect(s.b.request('sit', { seat: 1 })).not.toBe(s.b.request('sit', { seat: 2 }));
    expect(asks(s.net)).toHaveLength(2);
  });

  test('the host changing mid-request rejects with host_changed; the old host’s late answer is ignored', async () => {
    const s = setup();
    s.a.onRequest('buy', () => 'from a');
    const p = s.b.request('buy', null);
    s.net.host = 'pc';
    s.b.hostChanged();
    await expect(p).rejects.toMatchObject({ code: 'host_changed' });
    await s.run(200); // a's answer is sent host-only, dropped; nothing else settles
    expect(answers(s.net).every((m) => m.host)).toBe(true);
  });

  test('a stray answer from someone who isn’t the host asked is ignored', async () => {
    const s = setup();
    const p = s.b.request('buy', null);
    const id = (asks(s.net)[0]!.data as { i: string }).i;
    s.b.receive({ $gr: 'a', i: id, ok: 1, d: 'forged' }, 'pc');
    s.a.onRequest('buy', () => 'real');
    await s.run(200);
    expect(await p).toBe('real');
  });

  test('no answer in 5 s rejects with timeout', async () => {
    const s = setup();
    s.a.onRequest('slow', () => new Promise<Json>(() => {}));
    const p = s.b.request('slow', null);
    await s.run(4900);
    await s.run(200);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });

  test('on the host itself, request runs the handler locally', async () => {
    const s = setup();
    s.a.onRequest('buy', (_d, from) => from);
    expect(await s.a.request('buy', null)).toBe('pa');
    expect(asks(s.net)).toHaveLength(0);
  });

  test('answers go out host-only and only to the caller', async () => {
    const s = setup();
    s.a.onRequest('buy', () => 1);
    const p = s.b.request('buy', null);
    await s.run(200);
    await p;
    expect(answers(s.net).map((m) => [m.from, m.to, m.host, m.reliable])).toEqual([['pa', 'pb', true, true]]);
    expect(asks(s.net).map((m) => [m.to, m.reliable])).toEqual([['pa', true]]);
  });

  test('bad names, reserved names and non-JSON data throw at once', () => {
    const s = setup();
    expect(() => s.b.request('', null)).toThrow(/valid request name/);
    expect(() => s.b.request('spawn', null)).toThrow(/reserved/);
    expect(() => void s.b.request('x', { f: () => 1 } as unknown as Json)).not.toThrow(); // functions drop out, as JSON does
    expect(() => s.b.request('x', 1n as unknown as Json)).toThrow(/must be JSON/);
    expect(() => s.a.onRequest('', () => 1)).toThrow(/valid request name/);
  });

  test('close rejects everything waiting', async () => {
    const s = setup();
    const p = s.b.request('buy', null);
    s.b.close();
    await expect(p).rejects.toMatchObject({ code: 'disconnected' });
  });
  test('a request reaching a player who is no longer host doesn’t run its handler', async () => {
    const s = setup();
    let ran = 0;
    s.a.onRequest('grant', () => ++ran);
    const p = s.b.request('grant', null);
    s.net.host = 'pc'; // the server moved the host before pa got the request
    await s.run(200);
    expect(ran).toBe(0);
    s.b.hostChanged();
    await expect(p).rejects.toMatchObject({ code: 'host_changed' });
  });

  describe('the host asking itself waits like anyone else (SDK review #11)', () => {
    test('a handler that never settles times out in 5 s, and a repeat after that runs again', async () => {
      const s = setup();
      let runs = 0;
      s.a.onRequest('slow', () => (runs++, new Promise<Json>(() => {})));
      const first = s.a.request('slow', null);
      first.catch(() => {});
      await s.run(4900);
      expect(s.a.request('slow', null)).toBe(first); // still waiting: the same promise
      await s.run(200);
      await expect(first).rejects.toMatchObject({ code: 'timeout' });
      const again = s.a.request('slow', null);
      again.catch(() => {});
      expect(again).not.toBe(first);
      expect(runs).toBe(2);
    });

    test('leaving fails it, and a late answer is ignored', async () => {
      const s = setup();
      let finish: (v: Json) => void = () => {};
      s.a.onRequest('buy', () => new Promise<Json>((r) => (finish = r)));
      const left = s.a.request('buy', 1);
      await s.run(20);
      s.a.close();
      await expect(left).rejects.toMatchObject({ code: 'disconnected' });
      finish('late');
      await s.run(20);
    });
  });

  test('a host change doesn’t fail the host’s own request: its handler ran as host, and its answer stands', async () => {
    const s = setup();
    let finish: (v: Json) => void = () => {};
    s.a.onRequest('buy', () => new Promise<Json>((r) => (finish = r)));
    const own = s.a.request('buy', 1);
    s.b.onRequest('buy', () => 'b');
    s.net.host = 'pb';
    s.a.hostChanged();
    finish('granted once');
    expect(await own).toBe('granted once');
  });

  test('the host’s own request that times out says its handler is still running, not that there is none', async () => {
    const s = setup();
    s.a.onRequest('slow', () => new Promise<Json>(() => {}));
    const own = s.a.request('slow', null);
    own.catch(() => {});
    await s.run(5100);
    const err = await own.then(
      () => null,
      (e: GameRelayError) => e,
    );
    expect(err?.code).toBe('timeout');
    expect(err?.message).toContain('still running');
    expect(err?.message).not.toContain('does the host call');
  });
});
