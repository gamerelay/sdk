import { describe, expect, test } from 'bun:test';
import type { Json } from '@gamerelay/protocol/types';
import { Messages } from '../src/sync/messages';
import type { SyncTransport } from '../src/sync/transport';

function setup() {
  let now = 1000;
  const sent: { data: Json; to?: string; reliable: boolean }[] = [];
  const got: [string, Json, string][] = [];
  const warns: string[] = [];
  const t: SyncTransport = { me: 'pa', now: () => now, player: () => undefined, send: (data, o) => sent.push({ data, ...o }) };
  const m = new Messages(t, (type, data, from) => got.push([type, data, from]), (_kind, key) => warns.push(key));
  return { m, sent, got, warns, tick: (ms: number) => (now += ms) };
}

describe('Messages', () => {
  test('emit sends reliably to everyone and echoes to you at once', () => {
    const { m, sent, got } = setup();
    m.emit('fire', { x: 1, skip: undefined } as unknown as Json);
    expect(sent).toEqual([{ data: { $gr: 'e', n: 'fire', d: { x: 1, skip: undefined } }, to: undefined, reliable: true }]);
    expect(got).toEqual([['fire', { x: 1 }, 'pa']]);
  });

  test('echo: false, and sends to one player', () => {
    const { m, sent, got } = setup();
    m.emit('fire', 1, { echo: false });
    m.emit('whisper', 'hi', { to: 'pb' });
    expect(got).toEqual([]);
    expect(sent.map((s) => s.to)).toEqual([undefined, 'pb']);
  });

  test('to yourself: delivered locally, nothing sent', () => {
    const { m, sent, got } = setup();
    m.emit('note', 1, { to: 'pa' });
    expect(sent).toEqual([]);
    expect(got).toEqual([['note', 1, 'pa']]);
  });

  test('bad names, reserved names, non-JSON and oversized data throw', () => {
    const { m } = setup();
    expect(() => m.emit('', 1)).toThrow(/isn't a valid event name/);
    expect(() => m.emit('player_joined', 1)).toThrow(/reserved/);
    expect(() => m.emit('spawn', 1)).toThrow(/reserved/);
    expect(() => m.emit('fn', (() => 1) as unknown as Json)).toThrow(/must be JSON/);
    expect(() => m.emit('big', 'x'.repeat(20_000))).toThrow(/room.define \+ room.spawn/);
  });

  test('more than 30 of one event per second warns once', () => {
    const { m, warns, tick } = setup();
    for (let i = 0; i < 40; i++) {
      m.emit('hit', i, { echo: false });
      tick(10);
    }
    expect(warns).toEqual(['emit:hit']);
  });

  test('receive delivers SDK events with the sender and time, ignores the rest', () => {
    const { m, got } = setup();
    expect(m.receive({ $gr: 'e', n: 'fire', d: { x: 2 } }, 'pb', 5)).toBe(true);
    expect(m.receive({ $gr: 'e', n: 'closed', d: 1 }, 'pb', 5)).toBe(true);
    expect(m.receive({ x: 1 }, 'pb', 5)).toBe(false);
    expect(got).toEqual([['fire', { x: 2 }, 'pb']]);
  });
});
