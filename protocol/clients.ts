/**
 * Who is connecting, and what it understands (SDK_PLAN.md, §2–3). Every client puts two things on
 * its WebSocket URL:
 *
 * - `sdk=<name>/<version>`, e.g. `js/0.1.0-alpha.6`: for telemetry and the version floors. Other
 *   SDKs (Python, C#, Swift) use their own name, so their version numbers never mix with ours.
 * - `caps=<cap>,<cap>`: what it can handle. New behaviour is gated on a cap, never on a version
 *   compare, so another SDK opts in by listing it. Unknown caps are ignored.
 *
 * The protocol version itself is the WebSocket subprotocol (`gamerelay.v1.json`, `codec.ts`): a v2
 * is a new subprotocol, chosen from the client's list.
 */

/**
 * Everything a client can declare:
 * - `compact`: reads relayed messages in their short form (`CompactMessageMsg`). Also `compact=1`.
 * - `lan`: knows the LAN shortcut's wire format. Also `lan=1`.
 * - `moved`: follows `server_restarting.url` to another host.
 * - `notices`: shows `welcome.notices` and `notice` messages to the developer.
 */
export const CAPS = ['compact', 'lan', 'moved', 'notices'] as const;
export type Cap = (typeof CAPS)[number];

/** WebSocket close codes the server uses, and what a client should do about each. */
export const CLOSE = {
  /** Another connection for the same player took over (a second tab, a reconnect): stop, don't retry. */
  replaced: 4001,
  /** This client is older than the server accepts (`upgrade_required`): stop, don't retry. */
  upgradeRequired: 4426,
} as const;

export interface ClientId {
  /** `js`, later `py`, `cs`, `swift`… */
  name: string;
  version: string;
}

const CLIENT = /^([a-z][a-z0-9-]{0,15})\/([0-9A-Za-z.+-]{1,32})$/;

/** `js/0.1.0-alpha.6` → `{ name: 'js', version: '0.1.0-alpha.6' }`; anything else → null. */
export function parseClient(value: string | null | undefined): ClientId | null {
  const m = value ? CLIENT.exec(value) : null;
  return m ? { name: m[1]!, version: m[2]! } : null;
}

/** `compact,lan,moved` → those caps; unknown names and duplicates are dropped. */
export function parseCaps(value: string | null | undefined): Set<Cap> {
  const caps = new Set<Cap>();
  if (!value) return caps;
  for (const raw of value.split(',', 32)) {
    const cap = raw.trim();
    if ((CAPS as readonly string[]).includes(cap)) caps.add(cap as Cap);
  }
  return caps;
}

export type { Notice } from './types';

/**
 * Semver order with prereleases: `0.1.0-alpha.5 < 0.1.0-alpha.6 < 0.1.0 < 0.1.1`. Numeric
 * prerelease parts compare as numbers, others as text; build metadata (`+…`) is ignored.
 * Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre] = v.split('+', 1)[0]!.split(/-(.*)/s, 2);
    // Digits only: `Infinity`, `1e9` or `0x10` count as 0, never as a huge version.
    return { core: core.split('.').map((n) => (/^\d{1,15}$/.test(n) ? Number(n) : 0)), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length, 3); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  // A release is newer than any of its prereleases.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d{1,15}$/.test(p);
    const qn = /^\d{1,15}$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d;
    } else if (pn !== qn) {
      return pn ? -1 : 1; // numeric parts sort before text
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

const SEMVER = /^\d{1,15}\.\d{1,15}\.\d{1,15}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Version floors per client name, from `js/0.1.0-alpha.6,py/0.2.0`. Throws on a bad entry. */
export function parseFloors(value: string | null | undefined): Map<string, string> {
  const floors = new Map<string, string>();
  for (const entry of (value ?? '').split(',')) {
    if (!entry.trim()) continue;
    const client = parseClient(entry.trim());
    // Strict semver: a typo (`0.1.0alpha6`, `latest`) would otherwise compare as some other version.
    if (!client || !SEMVER.test(client.version)) throw new Error(`"${entry.trim()}" isn't a client floor like js/0.1.0-alpha.6`);
    floors.set(client.name, client.version);
  }
  return floors;
}

/** The floor this client is under, or null (no floor for its name, or not under it). */
export function floorAbove(client: ClientId, floors: ReadonlyMap<string, string>): string | null {
  const floor = floors.get(client.name);
  return floor !== undefined && compareVersions(client.version, floor) < 0 ? floor : null;
}
