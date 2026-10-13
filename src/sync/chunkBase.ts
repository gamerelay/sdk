/** The P2P chunk's file name (scripts/build.ts): named by a hash of its contents. */
export const CHUNK_NAME = /^gamerelay-p2p\.[0-9a-f]{12}\.mjs$/;

/**
 * Where the script-tag build looks for its P2P chunk, in order (scripts/build.ts): next to itself
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
