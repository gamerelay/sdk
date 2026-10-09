# Changelog

Every release of `@gamerelay/sdk`, newest first. The notes under a version's heading become its
GitHub release. Until 1.0, a minor version (0.x.0) may change the API; each break is listed
here with what to change.

## 0.1.0-alpha.7 (2026-10-09)

- **Fix:** messages the server sent right after a join's answer, in the same frame (a state
  change, a new host, entity updates), were lost, or went to the room you were leaving. They reach
  the new room now. Their events fire before `await relay.joinRoom()` returns, like anything that
  happened before you joined; `room.state`, `room.players` and entities are right.
- **Change:** a room that's closed (left, kicked, lost, or replaced by joining it again) sends
  nothing, instead of reaching the room you're in now. `send`, `emit`, `setState`, `chat`,
  `reseed`, `assignTeams`, `timer`, `clearTimer`, `input` and `release` on it are dropped with a
  console warning that says why it closed, host or not. `request`, `shareLink` and the host
  controls reject with `disconnected`, as a request still waiting at the close does. `claim`
  resolves `false` (with the warning), and `spawn` (a kind's too) throws `disconnected`. What the
  old room sends while a `joinRoom`, `createRoom` or `quickMatch` waits for its answer is held: it's
  dropped if you get in, and sent to the room you're still in if the join fails. Moving to another
  room (yours or your party leader's) fires the old room's `closed` once the server's message is
  handled, so a handler there may enter a room; `party_room` and `room` fire after it. Stop a
  room's loop on `room.on('closed')`.
- **Fix:** a field's `precision` that isn't a power of ten keeps its own steps: `precision: 0.25`
  sends quarters (it sent tenths: 0.25 went out as 0.3).
- **Change:** `precision` must be a finite number above 0. A string such as `'0.1'` (which worked
  by accident) or `Infinity` now throws at `room.define`; pass a number.

- **Fix:** `simulate: { latency, jitter }` could send two messages out of order, and the server
  drops a message that arrives after a later one: a call such as `quickMatch()` then got no answer
  (`timeout`), and enough of them closed the connection. The simulated network keeps order now.
  Without `simulate`, nothing changes.

## 0.1.0-alpha.6 (2026-10-07)

- **Versions:** `https://gamerelay.io/sdk/v0/gamerelay.js` (and `.mjs`) is the `v0` line, which only
  changes in ways that keep games working (a rename keeps the old name as a deprecated alias for at
  least 30 days); `/sdk/gamerelay.js` stays on `v0` forever. Pin an exact version through jsDelivr
  (`https://cdn.jsdelivr.net/npm/@gamerelay/sdk@<version>/gamerelay.js`).
  `GameRelay.version` is the SDK's version. llms.txt: "Versions".
- **The SDK tells the server what it is** (`sdk=js/<version>`, `caps=` on the socket URL), and shows
  the server's notices once in the console (e.g. "this SDK version is old"). A version the server
  no longer accepts makes `connect()` reject with `upgrade_required`, and the SDK stops retrying.
- **Where to connect comes from the server:** the token response's `wsUrl`, and a restart notice
  can move players to another host (same token, same seat). Only GameRelay hosts, or your own
  server's site, are followed.
- **`getToken` may return the whole `POST /v1/auth/token` response** (`{ token, expiresAt, wsUrl }`)
  instead of just the token.
- **Experimental:** `relay.serverInfo` (the server's version, for debugging).
- **Docs:** rooms' short links are on their own host now, `https://play.gamerelay.io/<game>/<link>`
  (alpha.5's notes said `gamerelay.io/<game>/<link>`). Nothing to change in a game: the URL comes
  from the server.
- **Break missed in alpha.5's notes:** `room.shareInvite()` shares the short link, so a friend
  arrives with `?join=<link>`, not `?room=CODE`. A game that reads `?room=` itself needs
  `relay.joinInvite()` (it reads both) to get them in.
- **Fix:** `room.shareInvite()` in a link-only room rejects when it can't get the room's link,
  instead of sharing the code's link (`inviteUrl()`), which gets nobody in.
- **API freeze** (what `v0` promises; SDK_PLAN.md §5):
  - **`relay.close()` closes everything:** the room gets `closed` (`'left'`), `room.request()` and
    `room.claim()` still waiting settle, and no timer or listener is left. `replaced` and a refused
    SDK version stop the same way (the room's `closed` says `'lost'`). `relay.tick()` on a closed
    relay throws.
  - **Every rejection is a `GameRelayError`** with a `code` (exported type `GameRelayErrorCode`):
    offline, `connect()` rejects `disconnected` (was a `TypeError` with no code); no answer in 15 s,
    `timeout`; `shareInvite()` without a clipboard, `unsupported`.
  - **Reconnecting says why it can't:** `relay.on('error')` gets `at_capacity` / `quota_exceeded`
    (it keeps trying) or `unauthorized` (a rotated key, a deleted game: it stops, and the room
    closes `'lost'`). A server error mid-deploy (a 502) is retried quietly, no longer treated as
    `unauthorized`.
  - **A secret key (`gr_sk_`) as `publicKey` is refused** before anything is sent.
  - **`return room.reject('why')`** from an `onRequest` handler refuses, like `throw` (it resolved
    the caller with `{ reason }`).
  - **Read-only fields:** `relay.playerId/room/party/features` and `room.hostId/players/state/seed/
    maxPlayers/chatHistory` are getters (assigning throws, and `players`/`chatHistory` can't be
    changed in place). Writing `room.state.x = …` warns (by the next frame): it changes only your
    copy; the host uses `room.setState`.
  - **Internals are out of reach:** `relay.request/queue/warn`, `room.handle/sync/closeLocal/
    debugInfo` and the rest are gone from the objects; `new GameRelay()` and `new Room()` throw
    (use `GameRelay.connect`); the `GameRelayRoom` global and the `setDefaultUrl` export are gone.
  - **`GameRelay.seededRandom`** works in the npm build too (it was script-tag only).
  - **One invite link:** `room.inviteUrl()` of a link-only room is `?join=<link>`, which gets in
    (it was `?room=CODE`, which doesn't). The link is asked for as you enter (`joinLink` knows it
    already); until it arrives, `inviteUrl()` warns: `await room.shareLink()` first.
  - **Names:** `room.holder(key)` (was `claimed(key)`, which still works); the relay event
    `party_room` (`room` still fires); `relay.listRooms({ tag, includeFull })` beside the
    positional form; non-host `room.timer`/`clearTimer` throw `not_host` (was `bad_request`);
    `access` and `listing` are reserved event names; `relay.on('player_joined')` and other
    unknown relay events warn. New types: `CreateRoomOptions`, `LeaveReason`, `PartyMember`.
  - **Experimental, outside the promise:** player to player (`p2p`, the new name of `lan`, which
    still works; `room.p2pPeers/p2pRoute`), `relay.joinOrCreate({ maxPlayers, tag, private,
    updateUrl })`, `relay.features`, `relay.serverInfo`, a field's `smooth`.
  - **Soft-deprecated (JSDoc only, no warning):** `room.spawn/all/get` and `room.on('spawn' |
    'remove', kind, …)`; use the kind handle from `room.define`.
  - **Size:** about 32 KB gzipped (was 30).

## 0.1.0-alpha.5 (2026-10-01)

- **Short links:** `room.shareLink()` is the room's link, the same for its life:
  `https://gamerelay.io/<game>/<link>` once the game's owner sets a slug and a play URL (dashboard
  → instance → Short links), which previews in chat apps with the room's name and the game's cover
  image and sends players to the play URL with `?join=<link>`. Without a slug it's the page's URL
  with `?join=<link>`. `relay.joinLink(link)` joins by a link's id, and `relay.joinInvite()` now
  reads `?join=` as well as `?room=`. `room.shareInvite()` shares the short link (falling back to
  the `?room=` one on an older server).
- **Link-only rooms:** `createRoom({ linkOnly: true })` and `room.setAccess({ linkOnly })` make a
  room that its code doesn't get into (`room_not_found`, as for a wrong code), so nobody joins by
  guessing one; a player with a seat in it still comes back by code. `room.linkOnly`, and
  `linkOnly` in the `access` event.

## 0.1.0-alpha.4 (2026-09-30)

- **Host controls:** the room's host can run it like a game server. `room.kick(playerId, { ban?,
  message? })` removes a player the way the owner's kick does (banned from the room by default).
  `room.setAccess({ locked?, public?, maxPlayers? })` locks the room to newcomers (joins fail with
  the new `locked` code; players in it can still reconnect), lists or unlists it, and changes its
  size, never below the players in it. `room.setListing({ name?, meta? })` sets what room lists
  show: a name of up to 48 characters and up to 512 bytes of JSON. `room.transferHost(playerId)`
  hands the host role over. All four are host only (`not_host` for anyone else) and return
  promises. Everyone gets the new `access` and `listing` events, and `room.locked`,
  `room.isPublic`, `room.name` and `room.meta` stay current (`room.maxPlayers` too, which is no
  longer read-only).
- **Server browser:** `relay.listRooms(tag, { includeFull: true })` also lists full and locked
  rooms, and every listing now has `name`, `meta`, `locked` and `hostName`.
  `relay.online()` says how many players the game has online.
- **Kicked while offline:** a player kicked while their connection was down now gets
  `closed('kicked', message)` when the SDK reconnects, instead of `closed('lost')` or, without a
  ban, quietly getting a fresh seat back (the reconnect asks to resume, and the server says why
  it can't).
- **Refused joins stay put:** joining a room that refuses you (locked, banned, full) no longer
  takes you, or your party, out of the room you're in. A party moves only if every member can.
- **A party leader keeps its room over a reconnect:** a leader whose connection drops gets its
  own seat back even if a party member can't come in (kicked, or outside a room since locked or
  filled), and nobody is pulled along; a reconnect also no longer hands the party's lead away.
  This is the server's doing, so it applies to every SDK version.
- These need a server with host controls (gamerelay.io has them). Older SDKs in the same room
  are unaffected: they ignore the new events.

## 0.1.0-alpha.3 (2026-09-29)

- **Smaller messages:** the SDK asks the server for relayed messages in a short form (the
  sender's room slot instead of its id), about 18% fewer bytes per message and per metered
  byte. gamerelay.io serves it; an older server just sends the long form.
- **Player to player uses less upload:** a player whose copies reach you after the server's
  (common on a relayed route near the game server) is told so, and then sends you only every
  10th copy for 30 s, which keeps checking whether the route got faster.

## 0.1.0-alpha.2 (2026-09-29)

- **Player to player, on by default (experimental):** broadcasts also go straight between
  players, directly on the same network or else through GameRelay's nearest relay, racing the
  server's copy, which still goes to everyone. `connect({ lan: false })` turns it off. Party
  members can also connect directly over the internet with `lan: { direct: 'party' }`, if the
  game's dashboard allows it (off by default). Players on older SDKs in the same room are
  unaffected. See the docs page, "Experimental: player to player".
- **Player to player, more reliable:** a relayed connection no longer drops every hour when its
  relay credentials expire (the 20-minute refresh now reaches open connections, with an ICE
  restart that keeps the channel open). After a network change (Wi-Fi to cellular), the route is
  restarted after 3 s instead of sitting dead for ~30 s. With relays, a connection that didn't open
  is tried again after 5 s, 30 s and 2 min. Copies over 2 KB go by the server only, since the lossy
  channel mostly lost them. Connection setup sends far fewer server messages, and the debug overlay
  shows each channel's round trip.
- **Security:** another player can no longer learn your IP address through the player-to-player
  shortcut (a fake relay candidate, or candidates inside an offer or answer), take over another
  player's entity ids before a newcomer sees them, or grow your memory with made-up entity kinds
  or input keys. A peer's copies get the server's size and rate limits, only a server copy starts
  a sender's session, and a peer can make us reconnect at most once every 2 s. State patches can't
  set `__proto__`. Entity ids now end in a short tag of their creator, 7 characters longer.
- **Reliability:** a connection that died without closing (switching from Wi-Fi to cellular, a
  laptop waking) is noticed within about 9 s, or at once when the page is shown again or comes
  back online, and the player rejoins before their seat is given up. Calls to the server, and
  claims, no longer wait forever: calls fail with `timeout` after 10 s, and a claim is retried and
  then settles. `relay.now()` no longer jumps when the device's clock changes, and follows the
  server after a reconnect. The SDK no longer sends a burst the server's rate limit would drop
  whole: position updates give way and everything else waits its turn (a full offline queue
  also keeps your messages over heartbeats), with a warning when your entity rates can't fit.
  Reconnects after a server restart are spread out, keyframes after a reconnect too, and sends
  from `relay.tick` go out without waiting for the next frame.
- **New error, `too_many_rooms`:** `createRoom` and `quickMatch` reject with it when a player
  already has 4 rooms nobody else is in, or the game is at its plan's room limit. Reuse a room for
  the next round instead of creating one each time.
- **Types:** the published `gamerelay.d.ts` no longer lists the SDK's internal plumbing
  (`relay.request`, `relay.warn`, `debugInfo` and the like), so autocomplete shows only the
  public API. `new Room()` is still not allowed; rooms come from `relay.createRoom`,
  `joinRoom` and `quickMatch`.
- **Docs:** `kind.mine()` says what really happens when you write an entity you don't own: the
  write is skipped, with a console warning. `llms.txt` lists the module build
  (`https://gamerelay.io/sdk/gamerelay.mjs`) and says `relay.features` flags are reserved.
- **Also on JSR** as `@gamerelay/sdk`, and each release has notes on GitHub.

## 0.1.0-alpha.1 (2026-09-28)

- The npm page carries the new README (entities first, the real size) and description.
- Ownership warnings name the kind handle to use (`blocks.mine()`).

## 0.1.0-alpha.0 (2026-09-28)

The first release on npm, with provenance, from [gamerelay/sdk](https://github.com/gamerelay/sdk).

- Rooms, quick match, parties, host migration, chat, saves and leaderboards.
- The sync layer: entities with smoothing (`room.define`, `kind.spawn`, `kind.all`,
  `kind.mine`), events, `relay.tick`, host entities, timers, requests, claims, inputs and teams.
- Console warnings written for the LLM that reads them, each naming the `llms.txt` section with
  the fix. A bad entity write is skipped with one warning instead of throwing every frame.
