# @gamerelay/sdk

[![CI](https://github.com/gamerelay/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/gamerelay/sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@gamerelay/sdk)](https://www.npmjs.com/package/@gamerelay/sdk)
[![gzip size](https://img.shields.io/bundlejs/size/@gamerelay/sdk)](https://bundlejs.com/?q=@gamerelay/sdk)
[![types](https://img.shields.io/npm/types/@gamerelay/sdk)](https://www.npmjs.com/package/@gamerelay/sdk)
[![license](https://img.shields.io/npm/l/@gamerelay/sdk)](https://github.com/gamerelay/sdk/blob/main/LICENSE)

Multiplayer for browser games, without writing a server. You declare what exists in your game
and who owns it; the SDK sends it, smooths it for everyone else, gives it to players who join
late, and hands the host's share to another player when the host leaves. Rooms, quick match,
invite links, parties, chat, saved player data and leaderboards come with it. Zero dependencies,
fully typed, about 28 KB gzipped.

**Docs:** [gamerelay.io/docs](https://gamerelay.io/docs) · **Guide for AI tools:**
[gamerelay.io/llms.txt](https://gamerelay.io/llms.txt) (also in this package as `llms.txt`) ·
**Demo:** [gamerelay.io/demo](https://gamerelay.io/demo/)

> **Alpha.** The API may still change between `0.x` releases.

## Install

```sh
npm i @gamerelay/sdk
```

Or without a build step:

```html
<script src="https://gamerelay.io/sdk/gamerelay.js"></script>
<!-- exposes window.GameRelay -->
```

Get a public key (`gr_pub_…`) by signing in at [gamerelay.io](https://gamerelay.io/app) and
creating an instance for your game. It's safe to ship in client code.

## Quick start

```js
import { GameRelay } from '@gamerelay/sdk';

const relay = await GameRelay.connect({ publicKey: 'gr_pub_…', playerName: 'ada' });
const room = await relay.quickMatch({ maxPlayers: 4 }); // or createRoom() / joinRoom('K7QM')

// Anything that moves is an entity. You write yours; everyone sees everyone's, smoothed.
const ships = room.define('ship', { x: 'number', y: 'number' });
const me = ships.spawn({ x: 100, y: 100 });

relay.tick(60, (dt) => {
  me.x += input.x * 200 * dt; // just write fields: the SDK sends the changes
  me.y += input.y * 200 * dt;
});
(function draw() {
  for (const s of ships.all()) drawShip(s.x, s.y, s.mine);
  requestAnimationFrame(draw);
})();

room.emit('wave', { x: me.x, y: me.y });       // a moment everyone sees, you included
room.on('wave', ({ x, y }) => ripple(x, y));
if (room.isHost) room.setState({ round: 1 }); // facts: one shared document, written by the host
```

Open your game in two tabs to test: each tab is its own player.

One player's browser is the **host**. Entities spawned with `{ owner: 'host' }` (a ball,
enemies, pickups), `room.state` and timers belong to the host role, so when the host leaves,
the next one carries on from where it was. Most games fit one of three shapes: **players own
avatars** (shooters, racers), **host simulates** (ball games, anything that must be fair), or
**mixed** (players move themselves, the host owns the world). llms.txt has a complete,
single-file starter for each.

In TypeScript, `room.define` types each entity from its fields, so a misspelled or undeclared
field doesn't compile.

## Invite links

To play with friends, put the room in the page URL and send the link:

```js
const room = (await relay.joinInvite().catch(() => null)) ?? (await relay.createRoom({ maxPlayers: 4 }));
history.replaceState(null, '', room.inviteUrl()); // the address bar is now the invite link
```

`room.shareInvite()` opens the share sheet on phones and copies the link elsewhere. It shares
the room's short link, `https://gamerelay.io/<game>/<link>` once the game has a slug (set in the
dashboard), which previews with the room's name and the game's cover image; `joinInvite()` joins
it (`?join=`). `createRoom({ linkOnly: true })` makes a room that only its link gets into.

## Everything else

Events, requests to the host, claims, inputs, timers, teams, lobbies and parties, host controls
(lock, resize, name and kick), chat,
leaderboards, signed-in players, webhooks, moderation, allowed origins, testing on a bad network
and limits are in the [docs](https://gamerelay.io/docs). While developing, pass `debug: true` to
`connect()` for an overlay; the SDK also warns in the console, once each, about common mistakes
and names the fix.

Two things worth knowing before you build a lobby: a kick's ban is per player id, and an
anonymous player in a private window gets a new one, so lock the room
(`room.setAccess({ locked: true })`) to keep strangers out. A room's `name` and `meta` come from a
player (the host): render them as text, never as HTML.

## License

MIT
