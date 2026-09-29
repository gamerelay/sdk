/**
 * Assemble the npm package in `packages/sdk/npm/`: the minified builds, one self-contained
 * type declaration file (the protocol types inlined, since @gamerelay/protocol isn't
 * published), the guide, README and licence, and a package.json for consumers.
 *
 *   bun run pack:npm            # build into npm/
 *   bun run publish:sdk         # from the repo root: pack, then publish with NPM_TOKEN from .env
 *                               # (a fallback: releases normally go out from the public repo's CI)
 *
 * The workspace package.json stays as it is: inside the monorepo, Bun and TypeScript resolve
 * `@gamerelay/sdk` to the source. The same script runs in the public gamerelay/sdk repo (see
 * scripts/export.ts), where CI publishes the result.
 */
import { $ } from 'bun';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const out = join(root, 'npm');
const pkg = await Bun.file(join(root, 'package.json')).json();

await $`bun run build`.cwd(root);
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const dts = join(out, 'gamerelay.d.ts');
// `stripInternal` keeps members tagged `@internal` (plumbing between the SDK's own classes) out
// of the published types. A throwaway tsconfig, so the workspace and public configs stay as they are.
const packConfig = join(root, 'tsconfig.pack.json');
await Bun.write(packConfig, JSON.stringify({ extends: './tsconfig.json', compilerOptions: { stripInternal: true } }));
try {
  await $`bunx dts-bundle-generator -o ${dts} src/index.ts --project ${packConfig} --external-inlines @gamerelay/protocol --no-banner --no-check`
    .cwd(root)
    .quiet();
} finally {
  rmSync(packConfig, { force: true });
}
if ((await Bun.file(dts).text()).includes('@internal')) throw new Error('gamerelay.d.ts still has @internal members');
// `declare const X = 1 as const` isn't valid in a declaration file; the literal alone is.
let types = (await Bun.file(dts).text()).replace(/^(declare const \w+ = [\w'"]+) as const;$/gm, '$1;');
// Room's constructor is internal, so stripping it would leave an implicit public `new Room()`.
const roomClass = /^(export declare class Room extends [^{]+\{)$/m;
if (!roomClass.test(types)) throw new Error('gamerelay.d.ts: no Room class to make unconstructable');
types = types.replace(roomClass, '$1\n\tprivate constructor();');
await Bun.write(dts, types);
for (const f of ['gamerelay.mjs', 'gamerelay.js']) cpSync(join(root, 'dist', f), join(out, f));
cpSync(join(root, 'llms.txt'), join(out, 'llms.txt'));
cpSync(join(root, 'README.md'), join(out, 'README.md'));
cpSync(join(root, 'CHANGELOG.md'), join(out, 'CHANGELOG.md'));
// The licence sits at the repo root: two levels up here, beside package.json in the public repo.
cpSync(existsSync(join(root, 'LICENSE')) ? join(root, 'LICENSE') : join(root, '../../LICENSE'), join(out, 'LICENSE'));

await Bun.write(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      // What people search npm for (docs/BREADCRUMBS.md). Only true ones: it works with any engine.
      keywords: [
        'multiplayer', 'browser-games', 'html5-game', 'gamedev', 'game-server', 'netcode', 'realtime',
        'websocket', 'lobby', 'matchmaking', 'relay', 'host-migration', 'entity-sync',
        'phaser', 'threejs', 'kaplay', 'pixi', 'llm', 'ai',
      ],
      homepage: 'https://gamerelay.io/docs',
      // npm checks provenance against this, so it must name the public repo CI publishes from.
      repository: { type: 'git', url: 'git+https://github.com/gamerelay/sdk.git' },
      bugs: { url: 'https://gamerelay.io/support' },
      license: 'MIT',
      type: 'module',
      main: './gamerelay.mjs',
      module: './gamerelay.mjs',
      types: './gamerelay.d.ts',
      exports: { '.': { types: './gamerelay.d.ts', default: './gamerelay.mjs' }, './package.json': './package.json' },
      // The script-tag build, for CDNs: <script src="https://cdn.jsdelivr.net/npm/@gamerelay/sdk"></script>
      unpkg: './gamerelay.js',
      jsdelivr: './gamerelay.js',
      sideEffects: false,
      files: ['gamerelay.mjs', 'gamerelay.js', 'gamerelay.d.ts', 'llms.txt', 'CHANGELOG.md'],
      publishConfig: { access: 'public' },
    },
    null,
    2,
  )}\n`,
);
// For a publish from this machine: npm reads the token from the environment, so the file holds no
// secret, and npm never packs it. CI authenticates on its own and skips this.
if (process.env.NPM_TOKEN) await Bun.write(join(out, '.npmrc'), '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n');
console.log(`packed ${pkg.name}@${pkg.version} into ${out}`);
