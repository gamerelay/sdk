/** Every warning the SDK can print, and the llms.txt section that explains its fix. */
export const SECTIONS = {
  worker: 'relay.tick: the game loop',
  rate_limited: 'Rules and limits',
  kind: 'Entities',
  fields: 'Entities',
  jump: 'Entities',
  room_full: 'Entities',
  write: 'Entities',
  send_positions: 'Entities',
  emit: 'Events',
  event_name: 'Room reference',
  request: 'Requests to the host',
  claims: 'Claims: take something exactly once',
  set_state: 'State and timers',
} as const satisfies Record<string, string>;
export type WarningKind = keyof typeof SECTIONS;

/** Console warnings written for the LLM that will read them: each key prints once, then counts. */
export class Warnings {
  readonly #seen = new Map<string, { message: string; count: number }>();

  warn(kind: WarningKind, key: string, message: string): void {
    const seen = this.#seen.get(key);
    if (seen) {
      seen.count++;
      return;
    }
    this.#seen.set(key, { message, count: 1 });
    console.warn(`[gamerelay] ${message} (llms.txt: "## ${SECTIONS[kind]}", https://gamerelay.io/llms.txt)`);
  }

  list(): { message: string; count: number }[] {
    return [...this.#seen.values()].map((w) => ({ ...w }));
  }
}

/** The hook sync modules print warnings through (the relay's `Warnings`, or a test fake). */
export type Warn = (kind: WarningKind, key: string, message: string) => void;
