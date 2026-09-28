/**
 * Entity ids: `<kind>:<session>:<n>`. The session tag is random per page load, so ids from a reload,
 * a reconnect or a new host never collide with live ones. The owner is never parsed from an id
 * (player ids can be any string); it comes from the server-stamped sender.
 */
export function createIdAllocator(random: () => number = Math.random): (kind: string) => string {
  const session = Math.floor(random() * 36 ** 8)
    .toString(36)
    .padStart(8, '0');
  let n = 0;
  return (kind) => `${kind}:${session}:${(++n).toString(36)}`;
}

/** The kind an id belongs to (`''` if it isn't an entity id). */
export function kindOf(id: string): string {
  const i = id.indexOf(':');
  return i > 0 ? id.slice(0, i) : '';
}
