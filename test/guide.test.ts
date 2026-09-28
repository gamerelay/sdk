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

/** Methods and getters up the prototype chain (on / off come from a shared base), plus instance fields. */
function members(proto: object, fields: string[]): Set<string> {
  const out = new Set(fields);
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) out.add(k);
  }
  return out;
}
const ROOM = members(Room.prototype, ['id', 'code', 'me', 'maxPlayers', 'hostId', 'players', 'state', 'chatHistory', 'seed']);
const RELAY = members(GameRelay.prototype, ['playerId', 'room', 'party', 'features', 'storage', 'leaderboard']);
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
      expect(block).toContain('<script src="https://gamerelay.io/sdk/gamerelay.js"></script>');
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
