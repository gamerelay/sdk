/** `<script src=".../sdk/gamerelay.js">` entry: exposes `window.GameRelay`. */
import { GameRelay, GameRelayError } from './index';
import { defaults } from './internal';

// Loaded from a GameRelay server (`/sdk/gamerelay.js`, `/sdk/v0/gamerelay.js`): talk to that
// server. From a CDN (npm package), keep the default, https://gamerelay.io.
const script = typeof document !== 'undefined' ? document.currentScript : null;
if (script instanceof HTMLScriptElement && script.src) {
  const src = new URL(script.src);
  if (/^\/sdk\/(v\d+\/)?gamerelay\.js$/.test(src.pathname)) defaults.url = src.origin;
}

Object.assign(globalThis, { GameRelay, GameRelayError });
