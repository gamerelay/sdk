/**
 * Choosing a TURN relay for a pair of players (LAN.md, "Relays"). Each player times a STUN ping
 * to every relay once; the offerer adds both players' delays and names the relay with the least,
 * so both allocate on the same one (a relay only forwards between its own allocations).
 */

/** Delays to each relay, in ms, keyed by `relayKey`. */
export type Delays = Record<string, number>;

/** More relays than this in a peer's delays are ignored (a handful of regions is the plan). */
const MAX_RELAYS = 16;
const MAX_DELAY_MS = 10_000;
/** A relay that hasn't answered a STUN ping in this long is too far to help. */
export const PROBE_MS = 1500;

const urlsOf = (s: RTCIceServer): string[] => (Array.isArray(s.urls) ? s.urls : [s.urls]);

/** A relay's name: its first URL. Every player gets the same list from the server. */
export const relayKey = (s: RTCIceServer): string => urlsOf(s)[0] ?? '';

/** A relay's UDP TURN URLs as STUN URLs: the relay answers STUN on its TURN port. */
export function stunUrls(s: RTCIceServer): string[] {
  return urlsOf(s)
    .filter((u) => u.startsWith('turn:') && !u.includes('transport=tcp'))
    .map((u) => `stun:${u.slice('turn:'.length).split('?')[0]}`);
}

/**
 * The addresses our relays' candidates can have: the host of each TURN URL. A peer's relay
 * candidate is only used when it's one of these, or a player could pass off its own address (or
 * anyone's) as a relay's and have us probe it from ours. So relay URLs must be IP literals, as the
 * server's `turn` reply gives them: a hostname can't be matched to a candidate's address, and a
 * relay named by one lets no peer relay candidate through.
 */
export function relayAddresses(servers: RTCIceServer[]): Set<string> {
  const out = new Set<string>();
  for (const s of servers) {
    for (const u of urlsOf(s)) {
      const host = /^turns?:(\[[^\]]+\]|[^:?/]+)/i.exec(u)?.[1]?.replace(/^\[|\]$/g, '').toLowerCase();
      if (host && (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':'))) out.add(host);
    }
  }
  return out;
}

/** Another player's delays, checked (they come from a peer): sane numbers, a few relays at most. */
export function delaysFrom(r: unknown): Delays | undefined {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return undefined;
  const out: Delays = {};
  for (const [k, v] of Object.entries(r).slice(0, MAX_RELAYS)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_DELAY_MS && k.length <= 512) out[k] = v;
  }
  return out;
}

/**
 * The relay for a pair: the least total delay over relays both players timed; failing that, the
 * least of whichever delays there are; failing that, the first relay.
 */
export function pickRelay(servers: RTCIceServer[], mine: Delays, theirs: Delays | undefined): string | undefined {
  const keys = servers.map(relayKey);
  const best = (cost: (k: string) => number | undefined): string | undefined => {
    let pick: string | undefined;
    let least = Number.POSITIVE_INFINITY;
    for (const k of keys) {
      const c = cost(k);
      if (c !== undefined && c < least) [pick, least] = [k, c];
    }
    return pick;
  };
  return (
    best((k) => (mine[k] !== undefined && theirs?.[k] !== undefined ? mine[k] + theirs[k] : undefined)) ??
    best((k) => mine[k]) ??
    best((k) => theirs?.[k]) ??
    keys[0]
  );
}

export interface ProbeDeps {
  createPeer?(config: RTCConfiguration): RTCPeerConnection;
  clock?(): number;
  timeoutMs?: number;
}

/**
 * The delay to a relay: how long until our public-address (srflx) candidate arrives, which takes
 * one STUN round trip to it. That candidate shows the page our own address; it is never sent to
 * anyone. `null`: no STUN URL, no answer before the timeout or the end of gathering, or no WebRTC.
 */
export async function probeRelay(server: RTCIceServer, deps: ProbeDeps = {}): Promise<number | null> {
  const urls = stunUrls(server);
  if (urls.length === 0) return null;
  const clock = deps.clock ?? (() => performance.now());
  const config: RTCConfiguration = { iceServers: [{ urls }] };
  let pc: RTCPeerConnection;
  try {
    pc = deps.createPeer?.(config) ?? new RTCPeerConnection(config);
  } catch {
    return null;
  }
  try {
    pc.createDataChannel('probe');
    const offer = await pc.createOffer();
    const start = clock();
    return await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), deps.timeoutMs ?? PROBE_MS);
      const done = (ms: number | null) => {
        clearTimeout(timer);
        resolve(ms);
      };
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return done(null); // gathering ended without an answer
        const parts = ev.candidate.candidate.split(' ');
        if (parts[parts.indexOf('typ') + 1] === 'srflx') done(Math.round(clock() - start));
      };
      pc.setLocalDescription(offer).catch(() => done(null));
    });
  } catch {
    return null;
  } finally {
    try {
      pc.close();
    } catch {
      // already closed
    }
  }
}

type Stat = Record<string, unknown>;
/** What `getStats()` resolves to (an `RTCStatsReport`), as far as we read it. */
export type StatsReport = { get(id: string): unknown; forEach(fn: (s: Stat) => void): void };

const getter = (report: StatsReport) => (id: unknown) => (typeof id === 'string' ? (report.get(id) as Stat | undefined) : undefined);

/** The candidate pair a connection sends on, from `getStats()`. */
function selectedPair(report: StatsReport): Stat | undefined {
  const get = getter(report);
  let pair: Stat | undefined;
  report.forEach((s) => {
    if (s.type === 'transport') pair ??= get(s.selectedCandidatePairId);
  });
  // Firefox has no transport stats: it marks the selected pair instead.
  report.forEach((s) => {
    if (s.type === 'candidate-pair' && s.selected === true) pair ??= s;
  });
  return pair;
}

/** Whether a connection's selected route goes through a relay, from `getStats()`. */
export function routeOf(report: StatsReport): 'direct' | 'relay' | null {
  const get = getter(report);
  const pair = selectedPair(report);
  if (!pair) return null;
  const local = get(pair.localCandidateId)?.candidateType;
  const remote = get(pair.remoteCandidateId)?.candidateType;
  if (local === undefined && remote === undefined) return null;
  return local === 'relay' || remote === 'relay' ? 'relay' : 'direct';
}

/**
 * The selected route's latest round trip in ms (its STUN checks' `currentRoundTripTime`, in
 * seconds), or `null` before one was measured.
 */
export function rttOf(report: StatsReport): number | null {
  const rtt = selectedPair(report)?.currentRoundTripTime;
  return typeof rtt === 'number' && Number.isFinite(rtt) && rtt >= 0 ? Math.round(rtt * 1000) : null;
}
