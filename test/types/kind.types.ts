// Compiled by kind.test.ts with tsc: each @ts-expect-error must be an error, everything else must compile.
import type { Kind, Room } from '../../src/index';

declare const room: Room;
const ships = room.define('ship', { x: 'number', y: { type: 'number', precision: 1 }, h: 'angle', alive: 'flag', name: 'text', gear: 'value' });
const me = ships.spawn({ x: 0, y: 0, h: 0, alive: true, name: 'ada', gear: { guns: 2 } });
me.x += 1; // numbers are numbers
me.alive = !me.alive;
const n: string = me.name;
const id: string = me.id;
const mine: boolean = me.mine;
me.teleport();
for (const s of ships.all()) s.y.toFixed(1);
ships.get('ship:a:1')?.h.toFixed(2);
ships.on('spawn', (s) => s.x.toFixed(0));
ships.on('remove', (s, reason) => `${s.name} ${reason}`);
const k: Kind<{ x: 'number' }> = room.define('dot', { x: 'number' });
void [n, id, mine, k];

// @ts-expect-error: not a declared field
me.vx = 1;
// @ts-expect-error: wrong type
me.x = 'far';
// @ts-expect-error: every field needs a starting value
ships.spawn({ x: 0 });
// @ts-expect-error: id is read-only
me.id = 'other';
