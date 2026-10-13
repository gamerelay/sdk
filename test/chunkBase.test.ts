import { expect, test } from 'bun:test';
import { chunkBases } from '../src/sync/chunkBase';

const V = '0.1.0-alpha.10';
const JSDELIVR = `https://cdn.jsdelivr.net/npm/@gamerelay/sdk@${V}/`;
const NAME = 'gamerelay-p2p.0123456789ab.mjs';
const at = (src: string | undefined) => chunkBases(src, V).map((base) => new URL(NAME, base).href);

test('the script tag looks for its P2P chunk next to itself, then on jsDelivr at its own version', () => {
  // Our file, wherever it's served (a copy the game hosts too): beside it first.
  expect(at('https://gamerelay.io/sdk/v0/gamerelay.js')).toEqual([`https://gamerelay.io/sdk/v0/${NAME}`, JSDELIVR + NAME]);
  expect(at('https://gamerelay.io/sdk/gamerelay.js?v=2')).toEqual([`https://gamerelay.io/sdk/${NAME}`, JSDELIVR + NAME]);
  expect(at('https://mygame.itch.zone/html/123/vendor/gamerelay.js')).toEqual([`https://mygame.itch.zone/html/123/vendor/${NAME}`, JSDELIVR + NAME]);
  // jsDelivr's own file at this version: once is enough.
  expect(at(`${JSDELIVR}gamerelay.js`)).toEqual([JSDELIVR + NAME]);
  expect(at(`${JSDELIVR}gamerelay.min.js`)).toEqual([JSDELIVR + NAME]);
  // A CDN's bare package URL (the `jsdelivr`/`unpkg` fields) names a directory that isn't ours: the
  // chunk beside it would be `…/npm/@gamerelay/gamerelay-p2p…`.
  for (const bare of ['https://cdn.jsdelivr.net/npm/@gamerelay/sdk', `https://cdn.jsdelivr.net/npm/@gamerelay/sdk@${V}`, 'https://unpkg.com/@gamerelay/sdk']) {
    expect(at(bare)).toEqual([JSDELIVR + NAME]);
  }
  // No script to go by (run as a module, or eval'd), or a game's own bundle with us inside.
  for (const none of [undefined, '', 'https://mygame.com/assets/bundle.js']) expect(at(none)).toEqual([JSDELIVR + NAME]);
});
