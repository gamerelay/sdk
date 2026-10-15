import { describe, expect, jest, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerInfo, RoomInfo } from '@gamerelay/protocol/types';
import { Room, type GameRelay } from '../src/index';
import { CREATE, control, linkOf } from '../src/internal';
import type { BotLogLine } from '@gamerelay/protocol/types';
import { BrainTimeout, ViewError, type Brain, type BrainStep } from '../src/sync/brainWorker';
import { Bots, type BotAdapter } from '../src/sync/bots';
import { LIMITS } from '@gamerelay/protocol/limits';
import { advance, answerRoom, connectFake, roomInfo, settle } from './fakeRelay';

function setup() {
  let now = 0;
  let online = true;
  const logs: { bot: string; lines: BotLogLine[] }[] = [];
  const brains: { src: string; loads: number; closed: boolean; next: () => Promise<BrainStep> }[] = [];
  const bots = new Bots({
    now: () => now,
    sendLog: (bot, lines) => online && (logs.push({ bot, lines }), true),
    brain: (): Brain => {
      const b = { src: '', loads: 0, closed: false, next: async (): Promise<BrainStep> => ({ action: { steer: 1 }, lines: [], ms: 1 }) };
      brains.push(b);
      return { load: async (src) => ((b.src = src), b.loads++, null), step: () => b.next(), close: () => void (b.closed = true) };
    },
  });
  const seen: string[] = [];
  const adapter: BotAdapter = {
    join: (b) => seen.push(`join ${b.id}`),
    leave: (b) => seen.push(`leave ${b.id}`),
    observe: (b) => ({ id: b.id }),
    drive: (b, a) => seen.push(`drive ${b.id} ${JSON.stringify(a)}`),
  };
  return { bots, logs, brains, seen, adapter, advance: (ms: number) => (now += ms), setOnline: (on: boolean) => (online = on) };
}
const spec = (id: string, brain = '() => ({})', rev = 0) => ({ id, name: `Bot ${id}`, brain, rev });
const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('Bots', () => {
  test('nothing runs until it is host, has an adapter and bots', async () => {
    const s = setup();
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.bots.setAdapter(s.adapter);
    await s.bots.tick();
    expect(s.seen).toEqual([]);
    s.bots.setHost(true);
    await s.bots.tick();
    expect(s.seen).toEqual(['join b1', 'drive b1 {"steer":1}']);
  });

  test('losing the host role: leave for each, brains closed', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1'), spec('b2')]);
    await s.bots.tick();
    s.bots.setHost(false);
    expect(s.seen.filter((x) => x.startsWith('leave'))).toEqual(['leave b1', 'leave b2']);
    expect(s.brains.every((b) => b.closed)).toBe(true);
  });

  test('losing the host role forgets the list: regained with no new bots message, nothing runs', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.bots.setHost(false);
    s.bots.setHost(true);
    await s.bots.tick();
    await s.bots.tick();
    expect(s.seen).toEqual(['join b1', 'drive b1 {"steer":1}', 'leave b1']);
    s.bots.setList([spec('b2')]); // the server's list for the new host
    await s.bots.tick();
    expect(s.seen.slice(3)).toEqual(['join b2', 'drive b2 {"steer":1}']);
  });

  test('a bot that joins writes an info line "started"', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.bots.flushLogs();
    expect(s.logs).toEqual([{ bot: 'b1', lines: [{ level: 'info', text: 'started' }] }]);
  });

  test('join returning false: a warn line instead of "started", and the bot sits out (no observe, no drive)', async () => {
    const s = setup();
    const seen: string[] = [];
    s.bots.setAdapter({ join: (b) => (seen.push(`join ${b.id}`), false), leave: (b) => seen.push(`leave ${b.id}`), observe: () => (seen.push('observe'), null), drive: () => seen.push('drive') });
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    await s.bots.tick();
    s.bots.flushLogs();
    expect(seen).toEqual(['join b1']);
    expect(s.logs).toEqual([{ bot: 'b1', lines: [{ level: 'warn', text: 'no room for this bot in the game' }] }]);
    s.bots.setList([]);
    expect(seen).toEqual(['join b1']); // it never joined: nothing to leave
  });

  test('a halted bot restarts on update_bot even with the same source: memory starts over, it joins again', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.brains[0]!.next = () => Promise.reject(new BrainTimeout('the brain took over 250 ms: stopped'));
    await s.bots.tick();
    expect(s.seen).toEqual(['join b1', 'drive b1 {"steer":1}', 'leave b1']);
    s.brains[0]!.next = async () => ({ action: 3, lines: [], ms: 1 });
    s.bots.setList([spec('b1', undefined, 1)]); // update_bot with the same source: a new rev
    await s.bots.tick();
    expect(s.seen.slice(3)).toEqual(['join b1', 'drive b1 3']);
    expect(s.brains[0]!.loads).toBe(2);
    s.bots.setList([spec('b1', undefined, 1)]); // the same rev (another bot changed, a host resume): nothing
    expect(s.brains[0]!.loads).toBe(2);
    s.bots.setList([spec('b1', undefined, 2)]); // update_bot on a running bot: memory starts over too
    expect(s.brains[0]!.loads).toBe(3);
    expect(s.seen.filter((x) => x.startsWith('join')).length).toBe(2); // still in the game: no join again
  });

  test('a halted bot stays halted when other bots change (the same rev): no reload, no new halt line', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.brains[0]!.next = () => Promise.reject(new BrainTimeout('the brain took over 250 ms: stopped'));
    await s.bots.tick();
    s.bots.flushLogs();
    s.logs.length = 0;
    s.bots.setList([spec('b1'), spec('b2')]); // add_bot: the server sends the whole list
    s.bots.setList([spec('b1'), spec('b2', '() => 1', 1)]); // update_bot for b2
    s.bots.setList([spec('b1')]); // remove_bot for b2
    for (let k = 0; k < 3; k++) await s.bots.tick();
    s.bots.flushLogs();
    expect(s.brains[0]!.loads).toBe(1);
    expect(s.seen.filter((x) => x === 'join b1').length).toBe(1);
    expect(s.logs.filter((l) => l.bot === 'b1')).toEqual([]);
  });

  test('a bot sitting out (join said no room) is not asked again when other bots change', async () => {
    const s = setup();
    const joins: string[] = [];
    s.bots.setAdapter({ join: (b) => (joins.push(b.id), b.id !== 'b1'), observe: () => null, drive: () => {} });
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.bots.setList([spec('b1'), spec('b2')]);
    await s.bots.tick();
    await s.bots.tick();
    expect(joins).toEqual(['b1', 'b2']);
    s.bots.setList([spec('b1', undefined, 1), spec('b2')]); // update_bot: it tries again
    await s.bots.tick();
    expect(joins).toEqual(['b1', 'b2', 'b1']);
  });

  test('a new adapter: the bots leave the old one and join the new one', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    const other: string[] = [];
    s.bots.setAdapter({ join: (b) => other.push(`join ${b.id}`), observe: () => null, drive: (b) => other.push(`drive ${b.id}`) });
    await s.bots.tick();
    expect(s.seen).toEqual(['join b1', 'drive b1 {"steer":1}', 'leave b1']);
    expect(other).toEqual(['join b1', 'drive b1']);
  });

  test('a new list: removed bots leave, changed brains reload, the rest keep running', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1'), spec('b2')]);
    await s.bots.tick();
    s.bots.setList([spec('b1', '() => ({ x: 1 })', 1)]);
    await s.bots.tick();
    expect(s.seen).toContain('leave b2');
    expect(s.brains.filter((b) => !b.closed).map((b) => b.src)).toEqual(['() => ({ x: 1 })']);
  });

  test('a brain that times out: one warn line, the bot leaves, the others go on', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1'), spec('b2')]);
    await s.bots.tick();
    s.bots.flushLogs();
    s.logs.length = 0; // the "started" lines
    s.brains[0]!.next = () => Promise.reject(new BrainTimeout('the brain took over 250 ms: stopped'));
    s.advance(1000);
    await s.bots.tick();
    await s.bots.tick();
    s.bots.flushLogs();
    expect(s.logs).toEqual([{ bot: 'b1', lines: [{ level: 'warn', text: 'the brain took over 250 ms: stopped. Fix it with update_bot.' }] }]);
    expect(s.seen).toContain('leave b1');
    expect(s.seen.filter((x) => x.startsWith('drive b2')).length).toBe(3);
  });

  test('a halted bot comes back (join again) when a new brain arrives, on the same Brain', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.brains[0]!.next = () => Promise.reject(new BrainTimeout('the brain failed: boom'));
    await s.bots.tick();
    expect(s.seen).toEqual(['join b1', 'drive b1 {"steer":1}', 'leave b1']);
    s.brains[0]!.next = async () => ({ action: 2, lines: [], ms: 1 });
    s.bots.setList([spec('b1', '() => 2', 1)]);
    await s.bots.tick();
    expect(s.seen.slice(3)).toEqual(['join b1', 'drive b1 2']);
    expect(s.brains.length).toBe(1);
    expect(s.brains[0]!.loads).toBe(2);
  });

  test('a view the brain cannot be sent: the bot plays on, one warn line about observe, one console warning', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = setup();
      s.bots.setAdapter(s.adapter);
      s.bots.setHost(true);
      s.bots.setList([spec('b1')]);
      await s.bots.tick();
      s.bots.flushLogs();
      s.logs.length = 0;
      s.brains[0]!.next = () => Promise.reject(new ViewError('observe() returned something that cannot be sent'));
      for (let k = 0; k < 3; k++) await s.bots.tick();
      s.brains[0]!.next = async () => ({ action: 7, lines: [], ms: 1 });
      await s.bots.tick();
      s.bots.flushLogs();
      expect(s.seen).not.toContain('leave b1');
      expect(s.seen.at(-1)).toBe('drive b1 7');
      expect(s.logs.flatMap((l) => l.lines.map((x) => x.text))).toEqual([
        "the game's observe() returned something a brain can't be sent (plain data only: no functions or class instances). Fix observe, not the brain.",
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('a brain that does not load: a warn line, and the bot never joins', async () => {
    const s = setup();
    const bots = new Bots({
      now: () => 0,
      sendLog: (bot, lines) => s.logs.push({ bot, lines }),
      brain: () => ({ load: async () => 'it must be one function', step: async () => ({ lines: [], ms: 0 }), close: () => {} }),
    });
    bots.setAdapter(s.adapter);
    bots.setHost(true);
    bots.setList([spec('b1', '42')]);
    await bots.tick();
    await bots.tick();
    bots.flushLogs();
    expect(s.seen).toEqual([]);
    expect(s.logs).toEqual([{ bot: 'b1', lines: [{ level: 'warn', text: "the brain didn't load: it must be one function" }] }]);
  });

  test('a load that rejects fast raises nothing unhandled, and halts the bot before it joins', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const s = setup();
      const bots = new Bots({
        now: () => 0,
        sendLog: (bot, lines) => s.logs.push({ bot, lines }),
        brain: () => ({ load: () => Promise.reject(new BrainTimeout('no Worker here')), step: async () => ({ lines: [], ms: 0 }), close: () => {} }),
      });
      bots.setAdapter(s.adapter);
      bots.setHost(true);
      bots.setList([spec('b1')]);
      await bots.tick();
      await new Promise((r) => setTimeout(r, 0));
      bots.flushLogs();
      expect(unhandled).toEqual([]);
      expect(s.seen).toEqual([]);
      expect(s.logs[0]!.lines[0]!.text).toBe('no Worker here. Fix it with update_bot.');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a new brain while a step is pending: that step\'s rejection does not halt the bot', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.bots.flushLogs();
    s.logs.length = 0; // the "started" lines
    let reject!: (e: Error) => void;
    s.brains[0]!.next = () => new Promise((_, no) => (reject = no));
    const pending = s.bots.tick();
    await settle();
    s.bots.setList([spec('b1', '() => 3', 1)]); // a real Brain rejects the in-flight step now
    reject(new BrainTimeout('the brain was replaced'));
    await pending;
    s.brains[0]!.next = async () => ({ action: 3, lines: [], ms: 1 });
    await s.bots.tick();
    s.bots.flushLogs();
    expect(s.logs).toEqual([]);
    expect(s.seen).toEqual(['join b1', 'drive b1 {"steer":1}', 'drive b1 3']);
  });

  test('a removed bot\'s pending step that then fails says nothing and does not leave twice', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.bots.flushLogs();
    s.logs.length = 0; // the "started" lines
    let reject!: (e: Error) => void;
    s.brains[0]!.next = () => new Promise((_, no) => (reject = no));
    const pending = s.bots.tick();
    await settle();
    s.bots.setList([]);
    reject(new BrainTimeout('the brain was stopped'));
    await pending;
    s.bots.flushLogs();
    expect(s.logs).toEqual([]);
    expect(s.seen.filter((x) => x === 'leave b1').length).toBe(1);
  });

  test('lines are cut to the server\'s 200 characters: a long failure and a long load error', async () => {
    const long = 'x'.repeat(300);
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.bots.flushLogs();
    s.logs.length = 0; // the "started" lines
    s.brains[0]!.next = () => Promise.reject(new BrainTimeout(`the brain failed: ${long}`));
    await s.bots.tick();
    const bots = new Bots({
      now: () => 0,
      sendLog: (bot, lines) => s.logs.push({ bot, lines }),
      brain: () => ({ load: async () => long, step: async () => ({ lines: [], ms: 0 }), close: () => {} }),
    });
    bots.setAdapter(s.adapter);
    bots.setHost(true);
    bots.setList([spec('b2')]);
    await bots.tick();
    s.bots.flushLogs();
    bots.flushLogs();
    const lines = s.logs.flatMap((l) => l.lines);
    expect(lines.map((l) => l.text.slice(0, 22))).toEqual(['the brain failed: xxxx', "the brain didn't load:"]);
    for (const l of lines) expect(l.text.length).toBe(200);
  });

  test('an adapter that throws: said once per message, the other bots and the logs go on', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = setup();
      const adapter: BotAdapter = {
        ...s.adapter,
        observe: (b) => {
          if (b.id === 'b1') throw new Error('no car for b1');
          return null;
        },
      };
      s.bots.setAdapter(adapter);
      s.bots.setHost(true);
      s.bots.setList([spec('b1'), spec('b2')]);
      await s.bots.tick();
      s.bots.flushLogs();
      s.logs.length = 0; // the "started" lines
      s.brains[1]!.next = async () => ({ action: 1, lines: [{ level: 'info', text: 'b2 here' }], ms: 1 });
      s.advance(1000);
      for (let k = 0; k < 5; k++) await s.bots.tick(); // none rejects
      expect(warn.mock.calls.map((c) => c[0])).toEqual(['[gamerelay] bots: no car for b1']);
      expect(s.seen.filter((x) => x.startsWith('drive b2')).length).toBe(6);
      expect(s.logs).toEqual([{ bot: 'b2', lines: [{ level: 'info', text: 'b2 here' }] }]); // flushed by the tick
    } finally {
      warn.mockRestore();
    }
  });

  test('logs: batched once a second, at most 20 lines a second per bot', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    s.brains.length = 0;
    await s.bots.tick(); // makes the brain
    s.brains[0]!.next = async () => ({ action: 1, lines: [{ level: 'info', text: 'hi' }], ms: 1 });
    for (let k = 0; k < 30; k++) await s.bots.tick();
    s.bots.flushLogs();
    expect(s.logs.reduce((n, l) => n + l.lines.length, 0)).toBe(20);
  });

  test('lines that could not go out wait for the next flush, at most 20 of them', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.setOnline(false); // offline, or the send budget is spent
    let k = 0;
    s.brains[0]!.next = async () => ({ action: 1, lines: [{ level: 'info', text: `line ${k++}` }], ms: 1 });
    for (let t = 0; t < 3; t++) {
      for (let i = 0; i < 25; i++) await s.bots.tick();
      s.advance(1000);
      s.bots.flushLogs();
    }
    expect(s.logs).toEqual([]);
    s.setOnline(true);
    s.bots.flushLogs();
    const lines = s.logs.flatMap((l) => l.lines.map((x) => x.text));
    expect(lines.length).toBe(20);
    expect(lines[0]).toBe('started'); // the oldest are kept: they say what happened first
  });

  test('a line keeps no control characters or lone surrogates: a full message stays under the server\'s byte limit', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.bots.flushLogs();
    s.logs.length = 0;
    s.advance(1000);
    const nasty = ['\u0001', '\uD800', '\uDC00', '\n', '"', '\\', '\u{1F600}', '€'];
    let k = 0;
    s.brains[0]!.next = async () => ({ action: 1, lines: [{ level: 'warn', text: nasty[k++ % nasty.length]!.repeat(300) }], ms: 1 });
    for (let i = 0; i < 25; i++) await s.bots.tick();
    s.bots.flushLogs();
    const lines = s.logs.flatMap((l) => l.lines);
    expect(lines.length).toBe(20);
    expect(lines[0]!.text).toBe(`${' '.repeat(LIMITS.maxBotLogLineLength - 1)}…`);
    expect(lines[1]!.text.startsWith('\uFFFD')).toBe(true);
    const loneOrControl = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u001F]/;
    expect(lines.filter((l) => loneOrControl.test(l.text))).toEqual([]);
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, t: 'bot_log', bot: 'bot_123456789012', lines })).length;
    expect(bytes).toBeLessThan(LIMITS.maxMessageBytes);
  });

  test('a slow brain (over 5 ms) gets one warn line every 5 seconds, not every tick', async () => {
    const s = setup();
    s.bots.setAdapter(s.adapter);
    s.bots.setHost(true);
    s.bots.setList([spec('b1')]);
    await s.bots.tick();
    s.bots.flushLogs();
    s.logs.length = 0; // the "started" lines
    s.brains[0]!.next = async () => ({ action: 1, lines: [], ms: 9 });
    for (let k = 0; k < 10; k++) await s.bots.tick();
    s.bots.flushLogs();
    expect(s.logs.flatMap((l) => l.lines)).toEqual([{ level: 'warn', text: 'the brain took 9 ms (keep it under 5 ms a call)' }]);
  });
});

describe('room.bots() through the relay', () => {
  const caps = (url: string) => new URL(url).searchParams.get('caps')!.split(',');

  test('the SDK declares the bots cap only as a bot host, and room.bots() gets the server\'s bots', async () => {
    const plain = await connectFake('pa');
    try {
      expect(caps(plain.socket().url)).not.toContain('bots');
    } finally {
      plain.done();
    }
    const f = await connectFake('pa', { botHost: true });
    try {
      expect(caps(f.socket().url)).toContain('bots');
      const entering = f.relay.createRoom();
      await settle();
      answerRoom(f.socket(), 'create_room', 'pa');
      const room = await entering;
      jest.useRealTimers(); // the brain runs in a real Worker from here on
      const seen: string[] = [];
      room.bots({
        join: (b) => seen.push(`join ${b.id}`),
        leave: (b) => seen.push(`leave ${b.id}`),
        observe: () => ({}),
        drive: (b, a) => seen.push(`drive ${b.id} ${JSON.stringify(a)}`),
      });
      f.socket().deliver({ t: 'bots', bots: [spec('b1', '() => ({ steer: 1 })')] });
      await until(() => seen.some((x) => x.startsWith('drive')));
      expect(seen.slice(0, 2)).toEqual(['join b1', 'drive b1 {"steer":1}']);
      f.socket().deliver({ t: 'player_joined', player: { id: 'pb', name: 'pb', avatar: null, joinedAt: 0, connected: true, slot: 1 } });
      f.socket().deliver({ t: 'host_changed', hostId: 'pb', previousHostId: 'pa' });
      expect(seen.at(-1)).toBe('leave b1');
    } finally {
      f.done();
    }
  });

  test('a brain\'s lines reach the server as a bot_log frame of their own', async () => {
    const f = await connectFake('pa', { botHost: true });
    try {
      const entering = f.relay.createRoom();
      await settle();
      answerRoom(f.socket(), 'create_room', 'pa');
      const room = await entering;
      jest.useRealTimers();
      room.bots({ observe: () => ({}), drive: () => {} });
      f.socket().deliver({ t: 'bots', bots: [spec('b1', '() => { log("hello"); return 1; }')] });
      await until(() => f.socket().frames.some((m) => m.t === 'bot_log'), 4000);
      const frame = f.socket().frames.find((m) => m.t === 'bot_log')!;
      expect(frame).toEqual({ v: 1, t: 'bot_log', bot: 'b1', lines: expect.arrayContaining([{ level: 'info', text: 'hello' }]) });
      expect((frame.lines as unknown[]).length).toBeLessThanOrEqual(20);
    } finally {
      f.done();
    }
  });

  test('leaving the room: what the bots logged since the last flush goes out before leave_room', async () => {
    const f = await connectFake('pa', { botHost: true });
    try {
      const entering = f.relay.createRoom();
      await settle();
      answerRoom(f.socket(), 'create_room', 'pa');
      const room = await entering;
      jest.useRealTimers();
      let drives = 0;
      room.bots({ observe: () => ({}), drive: () => void drives++ });
      f.socket().deliver({ t: 'bots', bots: [spec('b1', '() => { log("hello"); return 1; }')] });
      await until(() => f.socket().sentOf('bot_log').length > 0, 4000);
      const at = drives;
      await until(() => drives >= at + 3); // well under a second: these lines wait for the next flush
      const logs = f.socket().sentOf('bot_log').length;
      void room.leave();
      await settle();
      const sent = f.socket().attempts.map((m) => m.t);
      expect(f.socket().sentOf('bot_log').length).toBe(logs + 1);
      expect(sent.lastIndexOf('bot_log')).toBeLessThan(sent.indexOf('leave_room'));
    } finally {
      f.done();
    }
  });

  test('kicked (or the room closed): no bot_log after the server dropped the seat, so no not_in_room error', async () => {
    const f = await connectFake('pa', { botHost: true });
    try {
      const entering = f.relay.createRoom();
      await settle();
      answerRoom(f.socket(), 'create_room', 'pa');
      const room = await entering;
      jest.useRealTimers();
      let drives = 0;
      room.bots({ observe: () => ({}), drive: () => void drives++ });
      f.socket().deliver({ t: 'bots', bots: [spec('b1', '() => { log("hello"); return 1; }')] });
      await until(() => f.socket().sentOf('bot_log').length > 0, 4000);
      const at = drives;
      await until(() => drives >= at + 3); // lines waiting for the next flush
      const before = f.socket().attempts.filter((m) => m.t === 'bot_log').length;
      f.socket().deliver({ t: 'removed', roomId: room.id, reason: 'kicked' });
      await settle();
      expect(f.socket().attempts.filter((m) => m.t === 'bot_log').length).toBe(before);
    } finally {
      f.done();
    }
  });

  test('post: a bot_log waits (false) while the send budget is spent, so the server never drops one', async () => {
    const f = await connectFake('pa', { botHost: true });
    try {
      const entering = f.relay.createRoom();
      await settle();
      answerRoom(f.socket(), 'create_room', 'pa');
      await entering;
      const link = linkOf(f.relay);
      for (let i = 0; i < 300; i++) link.queue({ t: 'send', d: i });
      await advance(20); // the outbox goes out, as much as the budget pays for
      const posted = Array.from({ length: 50 }, () => link.post({ t: 'bot_log', bot: 'b1', lines: [{ level: 'info', text: 'hi' }] }));
      expect(posted.filter(Boolean).length).toBeLessThan(5); // only what the budget refilled meanwhile
      expect(f.socket().dropped).toEqual([]);
    } finally {
      f.done();
    }
  });

  test('bots sent between the room snapshot and the join\'s reply reach the new Room', async () => {
    const f = await connectFake('pa', { botHost: true });
    try {
      const entering = f.relay.joinRoom('ABCD');
      await settle();
      const req = f.socket().sentOf('join_room').at(-1)!;
      // As the server does it for a joiner who becomes host of a room with bots: room, bots, reply.
      f.socket().deliver({ t: 'room', room: roomInfo('pa'), you: 'pa' });
      f.socket().deliver({ t: 'bots', bots: [spec('b1', '() => 5')] });
      f.socket().deliver({ t: 'reply', rid: req.rid, data: { roomId: 'r1' } });
      const room = await entering;
      jest.useRealTimers();
      const seen: string[] = [];
      room.bots({ observe: () => ({}), drive: (b, a) => seen.push(`drive ${b.id} ${JSON.stringify(a)}`) });
      await until(() => seen.length > 0);
      expect(seen[0]).toBe('drive b1 5');
    } finally {
      f.done();
    }
  });
});

describe('the bots\' code, loaded on demand', () => {
  /** A Room on a stand-in bot-host relay whose bots' code comes from `load`. */
  function botRoom(load: () => Promise<typeof import('../src/sync/bots')>) {
    const me: PlayerInfo = { id: 'pa', name: 'pa', avatar: null, joinedAt: 0, connected: true, slot: 0 };
    const relay = {
      connected: true, serverReady: true, botHost: true, loadBots: load,
      queue: () => {}, post: () => {}, request: async () => undefined, now: () => 0, writeTime: () => 0,
      tick: () => () => {}, warn: () => {}, newEntityId: (kind: string) => `${kind}:t:1`, lanWithinRate: () => true, left: () => {},
    } as unknown as GameRelay;
    const info: RoomInfo = { id: 'r', code: 'ABCD', mode: 'relay', maxPlayers: 8, hostId: 'pa', players: [me], state: {}, stateSeq: 0, chat: [], seed: 1, claims: {} };
    return new Room(CREATE, relay as never, info, 'pa');
  }

  test('a chunk that fails to load: one console warning for the page, no bots, the room goes on', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const seen: string[] = [];
      const adapter: BotAdapter = { join: (b) => seen.push(`join ${b.id}`), observe: () => null, drive: () => seen.push('drive') };
      for (let k = 0; k < 2; k++) {
        const room = botRoom(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
        control(room).handle({ v: 1, t: 'bots', bots: [spec('b1')] });
        room.bots(adapter);
        await settle();
        expect(room.isHost).toBe(true);
        control(room).close('left');
      }
      expect(seen).toEqual([]);
      expect(warn.mock.calls.map((c) => c[0])).toEqual(["[gamerelay] bots are off: their code didn't load (Failed to fetch dynamically imported module)"]);
    } finally {
      warn.mockRestore();
    }
  });

  test('loaded once, by the first room.bots(); a list sent before it arrives is kept', async () => {
    let loads = 0;
    const room = botRoom(async () => (loads++, import('../src/sync/bots')));
    control(room).handle({ v: 1, t: 'bots', bots: [spec('b1')] });
    expect(loads).toBe(0); // not before the game asks
    const seen: string[] = [];
    const adapter: BotAdapter = { join: (b) => seen.push(`join ${b.id}`), leave: (b) => seen.push(`leave ${b.id}`), observe: () => null, drive: () => {} };
    room.bots(adapter);
    room.bots(adapter);
    await until(() => seen.length > 0);
    expect(loads).toBe(1);
    expect(seen).toEqual(['join b1']);
    control(room).close('left');
    expect(seen).toEqual(['join b1', 'leave b1']);
  });

  test('the host role moves away while the chunk loads: no join or drive once it arrives', async () => {
    let arrive!: () => void;
    const room = botRoom(() => new Promise((ok) => (arrive = () => ok(import('../src/sync/bots')))));
    control(room).handle({ v: 1, t: 'bots', bots: [spec('b1')] });
    const seen: string[] = [];
    room.bots({ join: (b) => seen.push(`join ${b.id}`), observe: () => null, drive: () => seen.push('drive') });
    control(room).handle({ v: 1, t: 'host_changed', hostId: 'pb', previousHostId: 'pa' });
    expect(room.isHost).toBe(false);
    arrive();
    await new Promise((r) => setTimeout(r, 150)); // several 33 ms rounds
    expect(seen).toEqual([]);
    control(room).close('left');
  });

  test('the host role leaves and comes back with no bots message: the old list does not run again', async () => {
    const room = botRoom(async () => import('../src/sync/bots'));
    control(room).handle({ v: 1, t: 'bots', bots: [spec('b1')] });
    const seen: string[] = [];
    room.bots({ join: (b) => seen.push(`join ${b.id}`), leave: (b) => seen.push(`leave ${b.id}`), observe: () => null, drive: () => {} });
    await until(() => seen.length > 0);
    control(room).handle({ v: 1, t: 'host_changed', hostId: 'pb', previousHostId: 'pa' });
    control(room).handle({ v: 1, t: 'host_changed', hostId: 'pa', previousHostId: 'pb' });
    await new Promise((r) => setTimeout(r, 150)); // several 33 ms rounds
    expect(seen).toEqual(['join b1', 'leave b1']);
    control(room).close('left');
  });

  test('the host role leaves before the chunk arrives: the list it had is not run once it comes back', async () => {
    let arrive!: () => void;
    const room = botRoom(() => new Promise((ok) => (arrive = () => ok(import('../src/sync/bots')))));
    control(room).handle({ v: 1, t: 'bots', bots: [spec('b1')] });
    const seen: string[] = [];
    room.bots({ join: (b) => seen.push(`join ${b.id}`), observe: () => null, drive: () => {} });
    control(room).handle({ v: 1, t: 'host_changed', hostId: 'pb', previousHostId: 'pa' });
    control(room).handle({ v: 1, t: 'host_changed', hostId: 'pa', previousHostId: 'pb' });
    arrive();
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toEqual([]);
    control(room).close('left');
  });

  test('the builds: the bots\' code only in its chunk, which is named by its contents and stands alone', async () => {
    // A separate process, as in p2pLoad.test.ts.
    const dir = mkdtempSync(join(tmpdir(), 'gamerelay-sdk-'));
    try {
      const out = Bun.spawnSync(['bun', 'scripts/build.ts', '--out', dir], { cwd: new URL('..', import.meta.url).pathname });
      expect(out.exitCode).toBe(0);
      const chunks = readdirSync(dir).filter((f) => f.startsWith('gamerelay-bots.'));
      expect(chunks).toHaveLength(1);
      const name = chunks[0]!;
      const chunk = await Bun.file(join(dir, name)).text();
      expect(name).toBe(`gamerelay-bots.${new Bun.CryptoHasher('sha256').update(chunk).digest('hex').slice(0, 12)}.mjs`);
      expect(chunk).toContain('Fix it with update_bot');
      expect(chunk).toContain('importScripts'); // the brain Worker's source came with it
      expect(new Bun.Transpiler({ loader: 'js' }).scanImports(chunk)).toEqual([]);
      const esm = await Bun.file(join(dir, 'gamerelay.mjs')).text();
      const iife = await Bun.file(join(dir, 'gamerelay.js')).text();
      for (const main of [esm, iife]) {
        expect(main).not.toContain('Fix it with update_bot');
        expect(main).not.toContain('importScripts');
      }
      expect(esm).toContain(`import("./${name}")`);
      expect(iife).toContain(`"${name}"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
