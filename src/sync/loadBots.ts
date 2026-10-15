/**
 * The bots' code (bots.ts and the brain Worker), fetched when a bot host first runs bots
 * (`room.bots`). This is the source build's loader (Bun, JSR, tests); the published builds replace
 * this file (scripts/build.ts) with one that imports the hashed chunk, as for `load.ts`.
 */
export const loadBots = (): Promise<typeof import('./bots')> => import('./bots');
