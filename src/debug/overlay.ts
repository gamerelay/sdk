import type { LanStats } from '../sync/lan';

export interface OverlayStats {
  ping: number | null;
  delayMs: number;
  msgsIn: number;
  msgsOut: number;
  bytesIn: number;
  bytesOut: number;
  entities: Record<string, number>;
  host: boolean;
  /** The LAN shortcut, when it's on: open channels, and which path delivered each broadcast first. */
  lan?: LanStats;
  warnings: { message: string; count: number }[];
}

/** The open channels' round trips, fastest to slowest (` · rtt 4–31 ms`), once any is known. */
function lanRtt(lan: LanStats): string {
  const ms = Object.values(lan.rttMs ?? {});
  if (ms.length === 0) return '';
  const [lo, hi] = [Math.min(...ms), Math.max(...ms)];
  return ` · rtt ${lo === hi ? lo : `${lo}–${hi}`} ms`;
}

export function formatOverlay(s: OverlayStats): string {
  const entities = Object.entries(s.entities)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(' · ');
  return [
    'gamerelay debug',
    `ping ${s.ping ?? '–'} ms · smoothing ${Math.round(s.delayMs)} ms${s.host ? ' · host' : ''}`,
    `frames/s ${s.msgsIn} in · ${s.msgsOut} out`,
    `KB/s ${(s.bytesIn / 1024).toFixed(1)} in · ${(s.bytesOut / 1024).toFixed(1)} out`,
    `entities ${entities || 'none'}`,
    ...(s.lan ? [`lan ${s.lan.peers} peer${s.lan.peers === 1 ? '' : 's'} · first ${s.lan.lanFirst} lan · ${s.lan.serverFirst} server${lanRtt(s.lan)}`] : []),
    ...s.warnings.map((w) => `! ${w.message}${w.count > 1 ? ` (×${w.count})` : ''}`),
  ].join('\n');
}

/** A small corner panel for `connect({ debug: true })`, refreshed twice a second. */
export function mountOverlay(read: () => OverlayStats): () => void {
  if (typeof document === 'undefined') return () => {};
  const el = document.createElement('pre');
  el.setAttribute('data-gamerelay-debug', '');
  el.style.cssText =
    'position:fixed;right:8px;bottom:8px;z-index:2147483647;margin:0;padding:8px 10px;max-width:360px;' +
    'white-space:pre-wrap;font:11px/1.4 ui-monospace,monospace;color:#e8e8e8;background:rgba(0,0,0,.72);' +
    'border-radius:6px;pointer-events:none';
  const render = () => {
    el.textContent = formatOverlay(read());
  };
  (document.body ?? document.documentElement).appendChild(el);
  render();
  const h = setInterval(render, 500);
  return () => {
    clearInterval(h);
    el.remove();
  };
}
