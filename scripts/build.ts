/**
 * Build the SDK's browser files: the P2P chunk (`src/sync/peers.ts`, loaded on demand) first, named
 * by a hash of its contents, then the ESM build (`gamerelay.mjs`) and the script-tag build
 * (`gamerelay.js`), each with `src/sync/load.ts` swapped for a loader of that chunk:
 *
 * - ESM: `import('./gamerelay-p2p.<hash>.mjs')`, a literal path, so a game's bundler (Vite, webpack,
 *   esbuild, Rollup) copies the chunk and splits it as its own.
 * - Script tag: the chunk next to the script that loaded us when that's our file (`/sdk/v0/`, a
 *   versioned jsDelivr file, a copy the game hosts), then jsDelivr at this exact version
 *   (`src/sync/chunkBase.ts`).
 *
 * Named by contents, not by version: `/sdk/v0/` gets fixes between releases, and a page holding a
 * cached main file must never get a newer chunk (their internal interface can change). An old one
 * asks for a chunk that's gone, and that page plays without P2P, as when the chunk is blocked.
 *
 *   bun scripts/build.ts                 # into dist/ (what `bun run build` runs)
 *   bun scripts/build.ts --out DIR       # somewhere else
 *   bun scripts/build.ts --no-minify
 *
 * Also a module: `buildSdk()` returns the files without writing them. The server builds through
 * this script in a process of its own (apps/server/src/http/static.ts).
 */
import type { BunPlugin } from 'bun';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CHUNK_NAME } from '../src/sync/chunkBase';

const root = join(import.meta.dir, '..');
const src = join(root, 'src');

export interface SdkFiles {
  /** The ESM build. */
  'gamerelay.mjs': string;
  /** The script-tag (IIFE) build. */
  'gamerelay.js': string;
  /** The P2P chunk's file name (`gamerelay-p2p.<hash>.mjs`) and its code. */
  chunk: { name: string; code: string };
}

export { CHUNK_NAME };

/** Earlier builds' chunks kept in `dist/chunks/` for the server: a page holding a main file from before a deploy still finds its own. */
const KEEP_CHUNKS = 20;

export async function buildSdk({ minify = true } = {}): Promise<SdkFiles> {
  const code = await build(join(src, 'sync/peers.ts'), 'esm', minify);
  const hash = new Bun.CryptoHasher('sha256').update(code).digest('hex').slice(0, 12);
  const name = `gamerelay-p2p.${hash}.mjs`;
  const { version } = await Bun.file(join(root, 'package.json')).json();
  const esm = `export const loadPeers = () => import('./${name}');`;
  // `currentScript` is only there while the script first runs: read once, at load. Each place in
  // turn: a copy the game hosts may have come without its chunk, which jsDelivr then has.
  const iife = `
    import { chunkBases } from './chunkBase';
    const script = typeof document === 'undefined' ? null : document.currentScript;
    const bases = chunkBases(script ? script.src : undefined, '${version}');
    export const loadPeers = async () => {
      let failed;
      for (const base of bases) {
        try {
          return await import(new URL('${name}', base).href);
        } catch (err) {
          failed = err;
        }
      }
      throw failed;
    };`;
  return {
    'gamerelay.mjs': await build(join(src, 'index.ts'), 'esm', minify, esm),
    'gamerelay.js': await build(join(src, 'global.ts'), 'iife', minify, iife),
    chunk: { name, code },
  };
}

async function build(entry: string, format: 'esm' | 'iife', minify: boolean, loader?: string): Promise<string> {
  const plugins: BunPlugin[] = [];
  if (loader) {
    plugins.push({
      name: 'p2p-loader',
      setup(b) {
        b.onLoad({ filter: /[\\/]sync[\\/]load\.ts$/ }, () => ({ contents: loader, loader: 'js' }));
        b.onResolve({ filter: /^\.\/gamerelay-p2p\./ }, (args) => ({ path: args.path, external: true }));
      },
    });
  }
  const result = await Bun.build({ entrypoints: [entry], format, minify, target: 'browser', plugins });
  const output = result.outputs[0];
  if (!result.success || !output || result.outputs.length !== 1) throw new Error(`SDK build failed (${entry}): ${result.logs.join('\n')}`);
  const code = await output.text();
  // The peer code must stay out of the main builds, and the chunk must stand alone.
  if (loader && code.includes('createDataChannel')) throw new Error(`${entry}: the P2P code was bundled in`);
  if (!loader && /\bimport\s*[({'"]|\bfrom\s*['"]/.test(code)) throw new Error('the P2P chunk imports something: it must stand alone');
  return code;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = at >= 0 ? args[at + 1]! : join(root, 'dist');
  const files = await buildSdk({ minify: !args.includes('--no-minify') });
  mkdirSync(out, { recursive: true });
  // One chunk per build: an older one left in dist/ would ship in the npm package too.
  for (const f of readdirSync(out)) if (CHUNK_NAME.test(f)) rmSync(join(out, f));
  await Bun.write(join(out, 'gamerelay.mjs'), files['gamerelay.mjs']);
  await Bun.write(join(out, 'gamerelay.js'), files['gamerelay.js']);
  await Bun.write(join(out, files.chunk.name), files.chunk.code);
  if (at < 0) {
    // dist/ only: every build's chunk in dist/chunks/ (not in the npm package), the newest kept.
    const kept = join(out, 'chunks');
    await Bun.write(join(kept, files.chunk.name), files.chunk.code);
    const old = readdirSync(kept)
      .filter((f) => CHUNK_NAME.test(f))
      .sort((a, b) => statSync(join(kept, b)).mtimeMs - statSync(join(kept, a)).mtimeMs)
      .slice(KEEP_CHUNKS);
    for (const f of old) rmSync(join(kept, f));
  }
  console.log(`built gamerelay.mjs, gamerelay.js and ${files.chunk.name} into ${out}`);
}
