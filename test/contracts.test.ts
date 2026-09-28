/**
 * The seams between modules: what each one promises the others. If a module is swapped or
 * rewritten (a new codec, a different transport, another scheduler), these must still hold.
 */
import { describe, expect, test } from 'bun:test';
import type { Json, PlayerInfo } from '@gamerelay/protocol/types';
import { SampleBuffer, type BufferField } from '../src/core/buffer';
import { DelayEstimator } from '../src/core/clock';
import { compileSchema, decodeChanges, encodeChanges, roundTo, type FieldInput, type FieldType } from '../src/core/codec';
import { seededRandom } from '../src/index';
import { EntityStore } from '../src/sync/entities';
import { Messages } from '../src/sync/messages';
import type { SyncTransport } from '../src/sync/transport';
import { FakeNet } from './fakeNet';

const FRAME = 1000 / 60;

/** A transport that records which members are used and fails on anything outside the contract. */
function strictTransport(): { t: SyncTransport; used: Set<string> } {
  const used = new Set<string>();
  const allowed = new Set(['me', 'send', 'now', 'player', 'ready', 'writeTime']);
  const player: PlayerInfo = { id: 'pb', name: 'bo', avatar: null, joinedAt: 0, connected: true, slot: 1 };
  const base: SyncTransport = { me: 'pa', send: () => {}, now: () => 1000, player: () => player, ready: () => true };
  const t = new Proxy(base, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (!allowed.has(key)) throw new Error(`transport.${key} is outside the SyncTransport contract`);
      used.add(key);
      return Reflect.get(target, key);
    },
  });
  return { t, used };
}

describe('SyncTransport is the only way out', () => {
  test('EntityStore uses only me, send, now, writeTime, player and ready', () => {
    const { t, used } = strictTransport();
    const store = new EntityStore(t);
    store.define('ship', { x: 'number', alive: 'flag' });
    const mine = store.spawn('ship', { x: 1, alive: true });
    mine.x = 2;
    store.tick();
    store.receive({ $gr: 'u', t: 1000, e: [] }, 'pb', 1000);
    store.playerJoined('pb');
    store.playerLeft('pb');
    store.all('ship');
    expect([...used].every((k) => ['me', 'send', 'now', 'writeTime', 'player', 'ready'].includes(k))).toBe(true);
  });

  test('Messages uses only me, send and now', () => {
    const { t, used } = strictTransport();
    const m = new Messages(t, () => {});
    m.emit('fire', { x: 1 });
    m.receive({ $gr: 'e', n: 'fire', d: 1 }, 'pb', 1000);
    expect([...used].sort()).toEqual(['me', 'now', 'send']);
  });

  test('a transport without ready() counts as always ready', () => {
    const net = new FakeNet();
    const bare = net.join('pa', 'ada', () => {}); // FakeNet's transport has no ready()
    expect('ready' in bare).toBe(false);
    const store = new EntityStore(bare);
    store.define('ship', { x: 'number' });
    store.spawn('ship', { x: 1 });
    store.tick();
    expect(net.updates('pa').length).toBe(1);
  });
});

describe('entity and event channels never cross', () => {
  const t: SyncTransport = { me: 'pa', send: () => {}, now: () => 0, player: () => undefined };
  const entities = new EntityStore(t);
  const got: string[] = [];
  const messages = new Messages(t, (type) => got.push(type));

  test('each channel claims only its own messages', () => {
    expect(entities.receive({ $gr: 'e', n: 'fire', d: 1 }, 'pb', 0)).toBe(false);
    expect(messages.receive({ $gr: 'u', t: 0, e: [] }, 'pb', 0)).toBe(false);
    expect(entities.receive({ $gr: 'u', t: 0, e: [] }, 'pb', 0)).toBe(true);
    expect(messages.receive({ $gr: 'e', n: 'fire', d: 1 }, 'pb', 0)).toBe(true);
  });

  test('neither throws on anything a peer could send, and game messages pass through untouched', () => {
    const rand = seededRandom(42);
    const junk: unknown[] = [null, 0, 'x', [], {}, { $gr: 'u' }, { $gr: 'u', e: [[1, 2, 3]] }, { $gr: 'u', e: [['ship:a:1', 'x', {}]] }, { $gr: 'e' }, { $gr: 'e', n: 5 }, { $gr: 'zz' }];
    for (let i = 0; i < 200; i++) {
      const x = rand();
      junk.push(x < 0.3 ? { $gr: 'u', t: rand() * 1e6, e: [[`k${i}:s:${i}`, Math.floor(rand() * 16), [0, rand()], 'h']] } : x < 0.6 ? { $gr: 'e', n: `e${i}`, d: { v: rand() } } : { v: rand() });
    }
    for (const d of junk) {
      expect(() => entities.receive(d, 'pb', 0)).not.toThrow();
      expect(() => messages.receive(d, 'pb', 0)).not.toThrow();
    }
    expect(entities.receive({ score: 3 }, 'pb', 0)).toBe(false);
    expect(messages.receive({ score: 3 }, 'pb', 0)).toBe(false);
  });
});

describe('codec round trip (property, seeded random schemas)', () => {
  const TYPES: FieldType[] = ['number', 'angle', 'flag', 'text', 'value'];
  const rand = seededRandom(7);
  const valueOf = (type: FieldType): unknown => {
    switch (type) {
      case 'number':
        return (rand() - 0.5) * 10 ** Math.floor(rand() * 8);
      case 'angle':
        return (rand() - 0.5) * 20;
      case 'flag':
        return rand() < 0.5;
      case 'text':
        return 'é😀x'.repeat(Math.floor(rand() * 5));
      case 'value':
        return { n: Math.floor(rand() * 100), list: [rand() < 0.5, 'a'] };
    }
  };

  test('decode(encode(values)) equals the values at their precision, for 200 random schemas', () => {
    for (let n = 0; n < 200; n++) {
      const count = 1 + Math.floor(rand() * 8);
      const fields: Record<string, FieldInput> = {};
      let valueFields = 0;
      for (let i = 0; i < count; i++) {
        let type = TYPES[Math.floor(rand() * TYPES.length)]!;
        if (type === 'value' && ++valueFields > 2) type = 'number'; // more could pass the per-entity size limit

        fields[`f${i}`] = rand() < 0.3 && (type === 'number' || type === 'angle') ? { type, precision: 0.5 } : type;
      }
      const schema = compileSchema('k', fields);
      const values = schema.fields.map((f) => valueOf(f.type));
      const sent: unknown[] = [];
      const { pairs } = encodeChanges(schema, values, sent, true);
      const back = decodeChanges(schema, JSON.parse(JSON.stringify(pairs)));
      expect(back).not.toBeNull();
      schema.fields.forEach((f, i) => {
        const want = f.type === 'number' || f.type === 'angle' ? roundTo(values[i] as number, f.precision) : values[i];
        expect(back![i]).toEqual(want as never);
      });
      // Changing one field sends exactly that field.
      const j = Math.floor(rand() * schema.fields.length);
      values[j] = valueOf(schema.fields[j]!.type);
      const { pairs: delta } = encodeChanges(schema, values, sent, false);
      const idx = delta.filter((_, k) => k % 2 === 0);
      expect(idx.every((i) => i === j)).toBe(true);
    }
  });

  test('the schema hash is the same on every player for the same define, whatever the key order of options', () => {
    const a = compileSchema('ship', { x: { type: 'number', precision: 1 }, h: 'angle' });
    const b = compileSchema('ship', { x: { precision: 1, type: 'number' }, h: 'angle' });
    expect(a.hash).toBe(b.hash);
  });
});

describe('sample buffer contract', () => {
  const F: BufferField[] = [{ kind: 'linear' }, { kind: 'angle' }, { kind: 'step' }];

  test('reads are pure: the same time gives the same values, and moving forward matches a fresh buffer', () => {
    const rand = seededRandom(11);
    const samples: [number, unknown[]][] = [];
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += 20 + rand() * 60;
      samples.push([t, [rand() * 100, (rand() - 0.5) * 6, rand() < 0.5]]);
    }
    const a = new SampleBuffer(F, { capacity: 64 });
    for (const [st, v] of samples) a.push(st, v);
    for (let rt = 0; rt < t + 400; rt += 7) {
      const b = new SampleBuffer(F, { capacity: 64 });
      for (const [st, v] of samples) b.push(st, v);
      const first = a.read(rt);
      expect(a.read(rt)).toEqual(first);
      expect(b.read(rt)).toEqual(first);
    }
  });

  test('every read returns one value per field', () => {
    const b = new SampleBuffer(F);
    expect(b.read(0)).toEqual([]);
    b.push(0, [1, 1, true]);
    expect(b.read(0).length).toBe(3);
    expect(b.read(1e9).length).toBe(3);
  });
});

describe('delay estimator contract', () => {
  test('stays within its bounds for any input', () => {
    const rand = seededRandom(3);
    const d = new DelayEstimator();
    for (let i = 0; i < 5000; i++) {
      d.observe(rand() < 0.01 ? 1e7 : rand() * 800 - 100, 1 + rand() * 999);
      expect(d.ms).toBeGreaterThanOrEqual(60);
      expect(d.ms).toBeLessThanOrEqual(500);
    }
  });
});

describe('the store does not depend on how it is ticked', () => {
  test('irregular ticks (5–45 ms apart) still send about 20 updates a second and render smoothly', () => {
    const net = new FakeNet({ latency: 60, jitter: 10, seed: 4 });
    const rand = seededRandom(5);
    let owner!: EntityStore;
    let viewer!: EntityStore;
    owner = new EntityStore(net.join('pa', 'ada', (d, f, at) => owner.receive(d, f, at)));
    viewer = new EntityStore(net.join('pb', 'bo', (d, f, at) => viewer.receive(d, f, at)));
    owner.define('ship', { x: 'number' });
    viewer.define('ship', { x: 'number' });
    const mine = owner.spawn('ship', { x: 0 });
    let nextOwnerTick = 0;
    const xs: number[] = [];
    for (let t = 0; t < 4000; t += FRAME) {
      net.advanceTo(t);
      mine.x = t * 0.3;
      if (t >= nextOwnerTick) {
        owner.tick();
        nextOwnerTick = t + 5 + rand() * 40;
      }
      viewer.tick();
      const e = viewer.get(mine.id);
      if (e && t > 1000) xs.push(e.x as number);
    }
    const sends = net.updates('pa').length / 4;
    expect(sends).toBeGreaterThan(15);
    expect(sends).toBeLessThan(23);
    const steps = xs.slice(1).map((x, i) => x - xs[i]!);
    expect(Math.max(...steps)).toBeLessThan(15);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0); // never goes backwards
  });
});

describe('entity object contract', () => {
  test('yours and theirs have the same shape; spread, keys, in, JSON and Object.assign behave', () => {
    const net = new FakeNet();
    let a!: EntityStore;
    let b!: EntityStore;
    a = new EntityStore(net.join('pa', 'ada', (d, f, at) => a.receive(d, f, at)));
    b = new EntityStore(net.join('pb', 'bo', (d, f, at) => b.receive(d, f, at)));
    a.define('ship', { x: 'number', alive: 'flag' });
    b.define('ship', { x: 'number', alive: 'flag' });
    const mine = a.spawn('ship', { x: 3, alive: true });
    for (let t = 0; t < 300; t += FRAME) {
      net.advanceTo(net.now + FRAME);
      a.tick();
      b.tick();
    }
    const theirs = b.get(mine.id)!;
    expect(Object.keys(mine)).toEqual(Object.keys(theirs));
    expect(Object.keys(mine)).toEqual(['id', 'kind', 'owner', 'mine', 'x', 'alive']);
    expect('x' in theirs && 'owner' in theirs && !('vx' in theirs)).toBe(true);
    expect(JSON.parse(JSON.stringify(theirs))).toMatchObject({ id: mine.id, kind: 'ship', mine: false, x: 3, alive: true });
    Object.assign(mine, { x: 9 });
    expect(mine.x).toBe(9);
    expect({ ...theirs }.x).toBe(3);
    expect(b.all('ship')[0]).toBe(b.all('ship')[0]); // stable identity across calls
  });
});

describe('echo contract', () => {
  test('your echo is a JSON copy: the same shape others get, and mutating it can’t touch your object', () => {
    const t: SyncTransport = { me: 'pa', send: () => {}, now: () => 0, player: () => undefined };
    const box: { echoed?: Json } = {};
    const m = new Messages(t, (_type, data) => (box.echoed = data));
    const shot = { x: 1, skip: undefined, nested: { y: 2 } };
    m.emit('shot', shot as unknown as Json);
    expect(box.echoed).toEqual({ x: 1, nested: { y: 2 } });
    (box.echoed as { nested: { y: number } }).nested.y = 99;
    expect(shot.nested.y).toBe(2);
  });
});
