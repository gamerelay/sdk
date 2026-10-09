/**
 * llms.txt is what models write code from, so every call it shows must exist: a renamed method
 * fails here instead of in someone's game.
 */
import { describe, expect, test } from 'bun:test';
import { GameRelay, Room, seededRandom } from '../src/index';
import { makeKind, type KindHost } from '../src/sync/kind';

const guide = await Bun.file(new URL('../llms.txt', import.meta.url)).text();
// The README is the package's page on npm and GitHub: its snippets are held to the same rule.
const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();
const codeOf = (doc: string) => [...doc.matchAll(/```(?:js|ts|html)\n([\s\S]*?)```/g)].map((m) => m[1]!).join('\n');
const source = await Bun.file(new URL('../src/index.ts', import.meta.url)).text();
// Other pages that make the same claims (read-only here). They're in the monorepo only: the public
// gamerelay/sdk repo is this package alone, so there those checks are skipped.
const optional = async (path: string) => {
  const file = Bun.file(new URL(path, import.meta.url));
  return (await file.exists()) ? file.text() : null;
};
const rootReadme = await optional('../../../README.md');
const docsPage = await optional('../../../apps/dashboard/src/pages/DocsPage.vue');
const monorepo = rootReadme !== null && docsPage !== null;

/** Members tagged `@internal`: they're left out of the published types, so docs can't use them. */
const INTERNAL = new Set([...source.matchAll(/@internal(?:(?!\*\/)[^])*\*\/\s*(\w+)\(/g)].map((m) => m[1]!));

/** Methods and getters up the prototype chain (on / off come from a shared base), plus instance fields. */
function members(proto: object, fields: string[]): Set<string> {
  const out = new Set(fields);
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) if (!INTERNAL.has(k)) out.add(k);
  }
  return out;
}
const ROOM = members(Room.prototype, ['id', 'code', 'me', 'maxPlayers', 'hostId', 'players', 'state', 'chatHistory', 'seed']);
// Room.request is public (ask the host); GameRelay.request is the internal one.
ROOM.add('request');
const RELAY = members(GameRelay.prototype, ['playerId', 'room', 'party', 'features', 'storage', 'leaderboard']);
/** Built-in event names, read from the source so the lists can't drift. */
const ROOM_EVENTS = new Set([
  ...[...(source.match(/const ROOM_EVENTS = new Set<string>\(\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]!),
  ...[...source.matchAll(/override on\(event: '(\w+)'/g)].map((m) => m[1]!), // spawn, remove, timer, host
]);
const RELAY_EVENTS = new Set(
  [...(source.match(/export type RelayEvents = \{([^]*?)\n\};/)?.[1] ?? '').matchAll(/^  (\w+):/gm)].map((m) => m[1]!),
);
/** A real handle's members, so the list can't drift from the SDK. */
const KIND = new Set(Object.keys(makeKind('x', {} as KindHost)));

function usedIn(code: string, name: string): Set<string> {
  return new Set([...code.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1]!));
}

for (const [file, doc, minHandles] of [['llms.txt', guide, 5], ['README.md', readme, 1]] as const) {
  const code = codeOf(doc);
  const used = (name: string) => usedIn(code, name);
  describe(`${file} only names real API`, () => {
    test('room.* exists on Room', () => {
      expect([...used('room')].filter((k) => !ROOM.has(k))).toEqual([]);
    });

    test('relay.* exists on GameRelay', () => {
      expect([...used('relay')].filter((k) => !RELAY.has(k))).toEqual([]);
    });

    test('GameRelay.* statics exist', () => {
      // global.ts adds seededRandom to the script-tag GameRelay.
      const statics = new Set([...Object.getOwnPropertyNames(GameRelay), ...(typeof seededRandom === 'function' ? ['seededRandom'] : [])]);
      expect([...used('GameRelay')].filter((k) => !statics.has(k))).toEqual([]);
    });

    test("room.on / relay.on name real events (a custom room event is one the doc also emits)", () => {
      const on = (name: string) => [...code.matchAll(new RegExp(`\\b${name}\\.on\\('(\\w+)'`, 'g'))].map((m) => m[1]!);
      const emitted = new Set([...code.matchAll(/\.emit\('(\w+)'/g)].map((m) => m[1]!));
      expect(on('room').filter((e) => !ROOM_EVENTS.has(e) && !emitted.has(e))).toEqual([]);
      expect(on('relay').filter((e) => !RELAY_EVENTS.has(e))).toEqual([]);
    });

    test('every kind handle (const x = room.define(…)) uses only Kind methods', () => {
      const handles = [...code.matchAll(/const (\w+) = room\.define\(/g)].map((m) => m[1]!);
      expect(handles.length).toBeGreaterThanOrEqual(minHandles);
      for (const h of handles) expect({ [h]: [...used(h)].filter((k) => !KIND.has(k)) }).toEqual({ [h]: [] });
    });
  });
}

describe('llms.txt starters', () => {

  test('the three starters are there, each a complete page', () => {
    for (const title of ['players own avatars', 'host simulates', 'mixed']) {
      const at = guide.indexOf(`## Starter: ${title}\n`);
      expect(at).toBeGreaterThan(-1);
      const block = guide.slice(at).match(/```html\n([\s\S]*?)```/)?.[1] ?? '';
      expect(block).toContain("publicKey: 'gr_pub_…'");
      expect(block).toContain('maxPlayers: 4');
      expect(block).toContain('<script src="https://gamerelay.io/sdk/v0/gamerelay.js"></script>');
    }
  });
});

test('the Debugging section lists every warning in the catalog', () => {
  const at = guide.indexOf('\n## Debugging\n');
  const debugging = guide.slice(at, guide.indexOf('\n## ', at + 5));
  for (const phrase of [
    "room.on('playerJoined')",
    'room.send() of x/y',
    'room.setState() more than 10',
    "room.emit('hit') more than 30",
    "room.all('shp')",
    'jumped across the map',
    'fields differ between players',
    'holds 1024 entities',
    'repeated while the first',
    'claims; release',
    'sent more than 120 per second',
    'fell back to setInterval',
    'names the llms.txt section',
  ]) {
    expect(debugging).toContain(phrase);
  }
});

describe('README.md', () => {
  test('the quick start syncs positions with entities, not room.send', () => {
    // room.send of x/y is what the send_positions warning flags; the first thing people copy can't be it.
    expect(codeOf(readme)).not.toMatch(/room\.send\(\{[^}]*\bx\b/);
    expect(codeOf(readme)).toContain('.spawn(');
  });

  test('its size claim matches the minified, gzipped build (±2 KB)', async () => {
    const claim = Number(readme.match(/about (\d+) KB gzipped/)?.[1]);
    // A separate process: Bun.build inside the whole suite's run trips over other tests' module state.
    const cwd = new URL('..', import.meta.url).pathname;
    const out = Bun.spawnSync(['bun', 'build', 'src/index.ts', '--minify', '--target', 'browser', '--format', 'esm'], { cwd });
    expect(out.exitCode).toBe(0);
    const kb = Bun.gzipSync(out.stdout).length / 1024;
    expect(Math.abs(kb - claim)).toBeLessThanOrEqual(2);
  });
});

describe('claims shared with the other docs', () => {
  test.skipIf(!monorepo)('the root README, SDK README and docs page give the same size', () => {
    const size = (doc: string | null) => doc?.match(/about (\d+) KB gzipped/)?.[1];
    expect(size(readme)).toBeDefined();
    expect({ root: size(rootReadme), docs: size(docsPage) }).toEqual({ root: size(readme), docs: size(readme) });
  });

  test('the experimental `lan` option stays out of llms.txt and the READMEs', () => {
    const lan = /\blan\s*:|`lan`|\blan: true/;
    for (const [file, doc] of Object.entries({ 'llms.txt': guide, 'README.md': readme, 'root README.md': rootReadme ?? '' })) {
      expect({ file, lan: lan.test(doc) }).toEqual({ file, lan: false });
    }
  });

  test.skipIf(!monorepo)('the experimental `lan` option is in its own docs section only', () => {
    const lan = /\blan\s*:|`lan`|\blan: true/;
    const page = docsPage ?? '';
    const start = page.indexOf('<h2 id="experimental">');
    const end = page.indexOf('<h2', start + 1);
    const template = page.slice(page.indexOf('<template>'));
    const outside = template.replace(page.slice(start, end), '');
    expect(start).toBeGreaterThan(0);
    expect(lan.test(outside)).toBe(false);
  });

  test('the event lists are read from the source', () => {
    expect(ROOM_EVENTS).toContain('player_joined');
    expect(ROOM_EVENTS).toContain('host');
    expect(RELAY_EVENTS).toContain('replaced');
    expect([...INTERNAL]).toEqual(['constructor']); // the rest is out of reach (src/internal.ts)
  });
});

test('jsDelivr links name files the npm package has: they sit at its root, not under dist/', async () => {
  for (const f of ['llms.txt', 'README.md', 'CHANGELOG.md']) {
    const text = await Bun.file(new URL(`../${f}`, import.meta.url)).text();
    for (const [url] of text.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/@gamerelay\/sdk@[^\s`)]+/g)) {
      expect(url).toMatch(/@gamerelay\/sdk@[^/]+\/gamerelay\.m?js$/);
    }
  }
});
