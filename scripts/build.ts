/**
 * Build the SDK's browser files: the chunks loaded on demand first (`CHUNKS`: the P2P peer code,
 * `src/sync/peers.ts`, and the bots' code, `src/sync/bots.ts`), each named by a hash of its
 * contents, then the ESM build (`gamerelay.mjs`) and the script-tag build (`gamerelay.js`), each with
 * every chunk's source loader (`src/sync/load.ts`, `src/sync/loadBots.ts`) swapped for a loader of
 * that chunk:
 *
 * - ESM: `import('./gamerelay-p2p.<hash>.mjs')`, a literal path, so a game's bundler (Vite, webpack,
 *   esbuild, Rollup) copies the chunk and splits it as its own.
 * - Script tag: the chunk next to the script that loaded us when that's our file (`/sdk/v0/`, a
 *   versioned jsDelivr file, a copy the game hosts), then jsDelivr at this exact version
 *   (`src/sync/chunkBase.ts`).
 *
 * Named by contents, not by version: `/sdk/v0/` gets fixes between releases, and a page holding a
 * cached main file must never get a newer chunk (their internal interface can change). An old one
 * asks for a chunk that's gone, and that page plays without P2P (or bots), as when the chunk is blocked.
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
import { basename, join } from 'node:path';
import { CHUNK_NAME } from '../src/sync/chunkBase';

const root = join(import.meta.dir, '..');
const src = join(root, 'src');

export interface SdkFiles {
  /** The ESM build. */
  'gamerelay.mjs': string;
  /** The script-tag (IIFE) build. */
  'gamerelay.js': string;
  /** Each chunk's file name (`gamerelay-<id>.<hash>.mjs`) and its code, in `CHUNKS`' order. */
  chunks: { name: string; code: string }[];
}

export { CHUNK_NAME };

/**
 * The chunks loaded on demand: the source built into each, the source loader (in `src/sync/`) the
 * main builds swap for one that fetches it, that loader's export, and a string only the chunk's code
 * has (a main build that contains it bundled the chunk in).
 */
const CHUNKS = [
  { id: 'p2p', entry: 'sync/peers.ts', loader: 'load.ts', fn: 'loadPeers', marker: 'createDataChannel' },
  { id: 'bots', entry: 'sync/bots.ts', loader: 'loadBots.ts', fn: 'loadBots', marker: 'Fix it with update_bot' },
] as const;

/** Earlier builds' chunks kept in `dist/chunks/` for the server: a page holding a main file from before a deploy still finds its own. */
const KEEP_CHUNKS = 40;

export async function buildSdk({ minify = true } = {}): Promise<SdkFiles> {
  const { version } = await Bun.file(join(root, 'package.json')).json();
  const chunks: SdkFiles['chunks'] = [];
  const esm = new Map<string, string>();
  const iife = new Map<string, string>();
  for (const c of CHUNKS) {
    const code = await build(join(src, c.entry), 'esm', minify);
    const hash = new Bun.CryptoHasher('sha256').update(code).digest('hex').slice(0, 12);
    const name = `gamerelay-${c.id}.${hash}.mjs`;
    chunks.push({ name, code });
    esm.set(c.loader, `export const ${c.fn} = () => import('./${name}');`);
    // The script tag: next to its script, else jsDelivr at this version (`chunkImporter`).
    iife.set(c.loader, `
      import { chunkImporter } from './chunkBase';
      const load = chunkImporter('${version}');
      export const ${c.fn} = () => load('${name}');`);
  }
  return {
    'gamerelay.mjs': await build(join(src, 'index.ts'), 'esm', minify, esm),
    'gamerelay.js': await build(join(src, 'global.ts'), 'iife', minify, iife),
    chunks,
  };
}

/** `loaders`: for a main build, each chunk's loader (by its source file's name in `src/sync/`). */
async function build(entry: string, format: 'esm' | 'iife', minify: boolean, loaders?: Map<string, string>): Promise<string> {
  const plugins: BunPlugin[] = [];
  if (loaders) {
    plugins.push({
      name: 'chunk-loaders',
      setup(b) {
        b.onLoad({ filter: /[\\/]sync[\\/]load(?:Bots)?\.ts$/ }, (args) => ({ contents: loaders.get(basename(args.path))!, loader: 'js' }));
        b.onResolve({ filter: /^\.\/gamerelay-(?:p2p|bots)\./ }, (args) => ({ path: args.path, external: true }));
      },
    });
  }
  const result = await Bun.build({ entrypoints: [entry], format, minify, target: 'browser', plugins });
  const output = result.outputs[0];
  if (!result.success || !output || result.outputs.length !== 1) throw new Error(`SDK build failed (${entry}): ${result.logs.join('\n')}`);
  const code = await output.text();
  // Each chunk's code must stay out of the main builds, and each chunk must stand alone.
  if (loaders) for (const c of CHUNKS) if (code.includes(c.marker)) throw new Error(`${entry}: the ${c.id} chunk's code was bundled in`);
  // (Parsed, not matched: the bots chunk's Worker source holds the word `import` in strings.)
  if (!loaders && new Bun.Transpiler({ loader: 'js' }).scanImports(code).length > 0) throw new Error(`${entry}: a chunk imports something: it must stand alone`);
  return code;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = at >= 0 ? args[at + 1]! : join(root, 'dist');
  const files = await buildSdk({ minify: !args.includes('--no-minify') });
  mkdirSync(out, { recursive: true });
  // One of each chunk per build: an older one left in dist/ would ship in the npm package too.
  for (const f of readdirSync(out)) if (CHUNK_NAME.test(f)) rmSync(join(out, f));
  await Bun.write(join(out, 'gamerelay.mjs'), files['gamerelay.mjs']);
  await Bun.write(join(out, 'gamerelay.js'), files['gamerelay.js']);
  for (const c of files.chunks) await Bun.write(join(out, c.name), c.code);
  if (at < 0) {
    // dist/ only: every build's chunks in dist/chunks/ (not in the npm package), the newest kept.
    const kept = join(out, 'chunks');
    for (const c of files.chunks) await Bun.write(join(kept, c.name), c.code);
    const old = readdirSync(kept)
      .filter((f) => CHUNK_NAME.test(f))
      .sort((a, b) => statSync(join(kept, b)).mtimeMs - statSync(join(kept, a)).mtimeMs)
      .slice(KEEP_CHUNKS);
    for (const f of old) rmSync(join(kept, f));
  }
  console.log(`built gamerelay.mjs, gamerelay.js, ${files.chunks.map((c) => c.name).join(' and ')} into ${out}`);
}
