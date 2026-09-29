/**
 * Entity ids: `<kind>:<session>:<n>`. The session tag is random per page load, so ids from a reload,
 * a reconnect or a new host never collide with live ones. The owner is never parsed from an id
 * (player ids can be any string); it comes from the server-stamped sender.
 *
 * The session also ends in a hash of the minting player's id (`ownerTag`), so a receiver can tell
 * whether the sender could have minted an id: without it, whoever sent an id first would own it,
 * and a player could take another's ids at a newcomer before the real owner's updates got there.
 */
export function createIdAllocator(random: () => number = Math.random): (kind: string, owner?: string) => string {
  const session = Math.floor(random() * 36 ** 8)
    .toString(36)
    .padStart(8, '0');
  let n = 0;
  return (kind, owner) => `${kind}:${session}${owner === undefined ? '' : ownerTag(owner)}:${(++n).toString(36)}`;
}

/** The kind an id belongs to (`''` if it isn't an entity id). */
export function kindOf(id: string): string {
  const i = id.indexOf(':');
  return i > 0 ? id.slice(0, i) : '';
}

/** A player id's tag in its sessions: FNV-1a, 32 bits, as 7 base-36 digits. */
export function ownerTag(player: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < player.length; i++) {
    h ^= player.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}

/** A session with an owner tag: 8 random digits, then 7 of tag. */
const TAGGED = /^[0-9a-z]{15}$/;

/**
 * Whether `sender` may have minted ids in `session`: `true` or `false` for a tagged session,
 * `undefined` for an untagged one (an older SDK's), which only arrival order can speak for.
 */
export function mintedBy(session: string, sender: string): boolean | undefined {
  return TAGGED.test(session) ? session.slice(8) === ownerTag(sender) : undefined;
}
