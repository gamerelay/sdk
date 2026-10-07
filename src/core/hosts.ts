import { attempt } from '@gamerelay/protocol/util';

/**
 * Whether the SDK may open its socket at `url` (a token response's `wsUrl`, a restart notice's
 * `url`): a `ws(s)://…/ws` URL on gamerelay.io or one of its subdomains, or on exactly the host
 * and port of the server it was given (a self-hosted or dev server). A secure base needs `wss`.
 * Nothing broader ("the same site"): shared domains such as fly.dev or co.uk would let anyone's
 * host in. Anything else, a bad token response or a tampered message can't send a game, and its
 * token, elsewhere.
 */
export function followable(url: string, base: string): boolean {
  const target = attempt(() => new URL(url), null);
  const from = attempt(() => new URL(base), null);
  if (!target || !from || !/^wss?:$/.test(target.protocol) || target.pathname !== '/ws' || target.username || target.password) return false;
  if (from.protocol === 'https:' && target.protocol !== 'wss:') return false;
  const host = target.hostname;
  if (host === 'gamerelay.io' || host.endsWith('.gamerelay.io')) return true;
  return target.host === from.host;
}
