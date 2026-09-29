# Changelog

Every release of `@gamerelay/sdk`, newest first. The notes under a version's heading become its
GitHub release. Until 1.0, a minor version (0.x.0) may change the API; each break is listed
here with what to change.

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
