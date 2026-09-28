# @gamerelay/sdk

[![CI](https://github.com/gamerelay/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/gamerelay/sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@gamerelay/sdk)](https://www.npmjs.com/package/@gamerelay/sdk)
[![gzip size](https://img.shields.io/bundlejs/size/@gamerelay/sdk)](https://bundlejs.com/?q=@gamerelay/sdk)
[![types](https://img.shields.io/npm/types/@gamerelay/sdk)](https://www.npmjs.com/package/@gamerelay/sdk)
[![license](https://img.shields.io/npm/l/@gamerelay/sdk)](https://github.com/gamerelay/sdk/blob/main/LICENSE)

Multiplayer for browser games, without writing a server. Rooms, quick match, parties, host
migration, chat, saved player data and leaderboards in a ~5 KB (gzipped), zero-dependency SDK.

**Docs:** [gamerelay.io/docs](https://gamerelay.io/docs) · **Guide for AI tools:**
[gamerelay.io/llms.txt](https://gamerelay.io/llms.txt) (also in this package as `llms.txt`) ·
**Demo:** [gamerelay.io/demo](https://gamerelay.io/demo/)

## Install

```sh
npm i @gamerelay/sdk
```

Or without a build step:

```html
<script src="https://gamerelay.io/sdk/gamerelay.js"></script>
<!-- exposes window.GameRelay -->
```

Get a public key (`gr_pub_…`) by signing in at [gamerelay.io](https://gamerelay.io) and creating
a game. It's safe to ship in client code.

## Quick start

```js
import { GameRelay } from '@gamerelay/sdk';

const relay = await GameRelay.connect({ publicKey: 'gr_pub_…', playerName: 'ada' });
const room = await relay.quickMatch({ maxPlayers: 4 }); // or createRoom() / joinRoom('K7QM')

room.on('message', (data, from) => console.log(from, data));
room.send({ x: 10, y: 20 }, { reliable: false }); // positions every tick
if (room.isHost) room.setState({ score: [0, 0] }); // durable, shared state
```

One player's browser is the **host** and runs the game; the others send it their inputs.
GameRelay relays messages between them and picks a new host if the host leaves. Open your game
in two tabs to test: each tab is its own player.

To play with friends, send an invite link: `room.inviteUrl()` is the page URL with
`?room=CODE`, `room.shareInvite()` shares or copies it, and `relay.joinInvite()` joins the room
in the link (or resolves `null` when there isn't one).

```js
const room = (await relay.joinInvite().catch(() => null)) ?? (await relay.createRoom({ maxPlayers: 4 }));
history.replaceState(null, '', room.inviteUrl()); // the address bar is now the invite link
```

Everything else (lobbies and parties, chat, leaderboards, signed-in players, webhooks,
moderation, allowed origins, testing on a bad network, limits) is in the
[docs](https://gamerelay.io/docs).

## License

MIT
