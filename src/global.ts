/** `<script src=".../sdk/gamerelay.js">` entry: exposes `window.GameRelay`. */
import { GameRelay, GameRelayError, Room, seededRandom, setDefaultUrl } from './index';

// Loaded from a GameRelay server (`/sdk/gamerelay.js`): talk to that server. From a CDN (npm
// package), keep the default, https://gamerelay.io.
const script = typeof document !== 'undefined' ? document.currentScript : null;
if (script instanceof HTMLScriptElement && script.src) {
  const src = new URL(script.src);
  if (src.pathname === '/sdk/gamerelay.js') setDefaultUrl(src.origin);
}

Object.assign(globalThis, { GameRelay, GameRelayError, GameRelayRoom: Room });
// Script-tag games get the helper as GameRelay.seededRandom(seed).
Object.assign(GameRelay, { seededRandom });
