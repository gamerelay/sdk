import type { Json } from '@gamerelay/protocol/types';
import type { FieldInput } from '../core/codec';
import { GameRelayError } from '../errors';
import type { Entity, EntityBase, RemoveReason, SpawnOptions } from './entities';

/** A field's value type from its declared type: 'number' | 'angle' → number, 'flag' → boolean, 'text' → string, 'value' → any JSON. */
type ValueOf<I> = I extends 'number' | 'angle' | { readonly type: 'number' | 'angle' }
  ? number
  : I extends 'flag' | { readonly type: 'flag' }
    ? boolean
    : I extends 'text' | { readonly type: 'text' }
      ? string
      : Json;

/** An entity's fields, typed from its `room.define` call. */
export type FieldValues<F> = { -readonly [K in keyof F]: ValueOf<F[K]> };
/** An entity of a kind: its declared fields (writable if it's yours), plus id, kind, owner, mine. */
export type KindEntity<F> = EntityBase & FieldValues<F>;

/**
 * What `room.define` returns: one kind of entity, named once. Everything here is typed from the
 * fields you declared.
 *
 *   const ships = room.define('ship', { x: 'number', y: 'number' });
 *   const me = ships.spawn({ x: 0, y: 0 });
 *   for (const s of ships.mine()) move(s);  // update the ones you write
 *   for (const s of ships.all()) draw(s);   // draw every one
 */
export interface Kind<F = Record<string, FieldInput>> {
  readonly name: string;
  /** Create one you own (or the host owns, with `{ owner: 'host' }`). Give every field a starting value. */
  spawn(initial: FieldValues<F>, options?: SpawnOptions): KindEntity<F>;
  /** Every one in the room: yours live, others' smoothed about 100 ms in the past. Draw these. */
  all(): KindEntity<F>[];
  /**
   * The ones you can write right now: yours, plus host entities while you're the host. Update
   * these (`for (const e of enemies.mine()) e.x += e.vx * dt`); writing any other one throws.
   */
  mine(): KindEntity<F>[];
  /** One by id, if it's this kind and in the room. */
  get(id: string): KindEntity<F> | undefined;
  /**
   * One appears (for others' entities: when the timeline reaches its spawn) or goes. Doesn't replay
   * the ones already here: loop over `all()` for those.
   */
  on(event: 'spawn', handler: (entity: KindEntity<F>) => void): () => void;
  on(event: 'remove', handler: (entity: KindEntity<F>, reason: RemoveReason) => void): () => void;
}

/** What a handle needs from its room. */
export interface KindHost {
  /** False once the room was left or replaced: the handle then throws. */
  live(): boolean;
  spawn(kind: string, initial: Record<string, unknown>, options?: SpawnOptions): Entity;
  all(kind: string): Entity[];
  get(id: string): Entity | undefined;
  on(event: 'spawn' | 'remove', kind: string, handler: (entity: Entity, reason: RemoveReason) => void): () => void;
}

export function makeKind<F>(name: string, host: KindHost): Kind<F> {
  const check = () => {
    if (!host.live()) {
      throw new GameRelayError('bad_request', `\`${name}\` belongs to a room you left; call room.define('${name}', …) again in the new room`);
    }
  };
  const kind = {
    name,
    spawn(initial: Record<string, unknown>, options?: SpawnOptions) {
      check();
      return host.spawn(name, initial, options);
    },
    all() {
      check();
      return host.all(name);
    },
    mine() {
      check();
      return host.all(name).filter((e) => e.mine);
    },
    get(id: string) {
      check();
      const e = host.get(id);
      return e?.kind === name ? e : undefined;
    },
    on(event: 'spawn' | 'remove', handler: (entity: Entity, reason: RemoveReason) => void) {
      check();
      if (event !== 'spawn' && event !== 'remove') {
        throw new GameRelayError('bad_request', `${name}.on('${String(event)}'): kinds have 'spawn' or 'remove' events; for anything else use room.on`);
      }
      return host.on(event, name, handler);
    },
  };
  return Object.freeze(kind) as unknown as Kind<F>;
}
