/**
 * The peer code (peers.ts), fetched when a room starts P2P. This is the source build's loader
 * (Bun, JSR, tests); the published builds replace this file (scripts/build.ts): the ESM build
 * imports the hashed chunk next to it, the script-tag build the one next to its own script.
 */
export const loadPeers = (): Promise<typeof import('./peers')> => import('./peers');
