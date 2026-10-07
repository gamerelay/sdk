import { afterEach, expect, test } from 'bun:test';
import { CLOSE } from '@gamerelay/protocol/clients';
import { GameRelay } from '../src/index';

/** A server that hands out tokens and then refuses every socket as too old, counting attempts. */
function refusingServer() {
  let sockets = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/auth/anonymous') return Response.json({ token: 't', playerId: 'p_1', expiresAt: Date.now() + 3_600_000 });
      if (url.pathname === '/ws' && srv.upgrade(req, { data: {} })) return undefined;
      return new Response('no', { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets++;
        ws.send(JSON.stringify({ v: 1, t: 'error', code: 'upgrade_required', message: 'too old' }));
        ws.close(CLOSE.upgradeRequired, 'Upgrade required');
      },
      message() {},
    },
  });
  return { server, attempts: () => sockets };
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
});

test('upgrade_required (close 4426) rejects connect with that code and never retries', async () => {
  const { server, attempts } = refusingServer();
  stop = () => void server.stop(true);
  const err = await GameRelay.connect({ url: `http://127.0.0.1:${server.port}`, publicKey: 'gr_pub_x' }).catch((e: unknown) => e);
  expect((err as { code?: string }).code).toBe('upgrade_required');
  await Bun.sleep(600);
  expect(attempts()).toBe(1);
});
