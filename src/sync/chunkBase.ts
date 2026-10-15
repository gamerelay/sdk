/** A chunk's file name (scripts/build.ts: the P2P or bots code), named by a hash of its contents. */
export const CHUNK_NAME = /^gamerelay-(?:p2p|bots)\.[0-9a-f]{12}\.mjs$/;

/**
 * Where the script-tag build looks for its chunks, in order (scripts/build.ts): next to itself
 * when the page loaded our file by name (`/sdk/v0/gamerelay.js`, a versioned jsDelivr or unpkg
 * file, a copy the game hosts), then jsDelivr at this exact version, which has every release's. A
 * CDN's bare package URL (`…/npm/@gamerelay/sdk`) serves our file from a path that isn't its
 * directory, and with no script to go by (run as a module, or bundled into a game's own file)
 * there's nothing to resolve against: jsDelivr only.
 */
export function chunkBases(src: string | undefined, version: string): string[] {
  const cdn = `https://cdn.jsdelivr.net/npm/@gamerelay/sdk@${version}/`;
  const path = src ? new URL(src).pathname : '';
  return /\/gamerelay(?:\.min)?\.js$/.test(path) && new URL('.', src).href !== cdn ? [src!, cdn] : [cdn];
}

/**
 * The script-tag build's chunk loader (scripts/build.ts): each place in turn, since a copy the game
 * hosts may have come without its chunks, which jsDelivr then has. Made at load: `currentScript` is
 * only there while the script first runs.
 */
export function chunkImporter(version: string): (name: string) => Promise<unknown> {
  const script = typeof document === 'undefined' ? null : (document.currentScript as HTMLScriptElement | null);
  const bases = chunkBases(script ? script.src : undefined, version);
  return async (name) => {
    let failed: unknown;
    for (const base of bases) {
      try {
        return await import(new URL(name, base).href);
      } catch (err) {
        failed = err;
      }
    }
    throw failed;
  };
}
