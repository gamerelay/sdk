export const LIMITS = {
  /** Max encoded size of one inbound frame. */
  maxMessageBytes: 16 * 1024,
  /** Max encoded size of a room's shared state. */
  maxStateBytes: 64 * 1024,
  maxBatchSize: 64,
  maxJsonDepth: 16,
  maxKvKeyLength: 128,
  maxLeaderboardNameLength: 32,
  /** Distinct leaderboards per game instance. */
  maxLeaderboards: 32,
  /** Most entries one `lb_top` call returns. */
  maxLeaderboardPage: 100,
  /** Characters (graphemes) per chat message. */
  maxChatLength: 120,
  /** Upper bound on the raw chat string before normalization (UTF-16 units). */
  maxChatRawLength: 1_000,
  /** Recent messages a room keeps and sends to players who join. */
  chatHistory: 20,
  /** Chat messages per player: `chatBurst` at once, refilling at `chatPerSecond`. */
  chatPerSecond: 1,
  chatBurst: 5,
  /** Moderator note sent with a kick or room close. */
  maxModerationMessageLength: 120,
  /** Avatar set by a developer backend (may be an image URL). */
  maxAvatarLength: 512,
  /** Avatar an anonymous player picks: a short id or emoji, never a URL. */
  maxAnonymousAvatarLength: 32,
  maxPlayersPerRoom: 64,
  /** Take-once claims a room holds at once (`room.claim`). */
  maxClaims: 1024,
  maxClaimKeyLength: 128,
  /** Sustained inbound messages/sec per connection (batch items count individually). */
  ratePerSecond: 120,
  /** Bucket size, i.e. the largest burst allowed after a quiet period. */
  rateBurst: 240,
  /** How long a disconnected player keeps their seat. */
  resumeGraceMs: 30_000,
} as const;

/**
 * Token bucket rate limiter. Pure and clock-injected so it works in any runtime.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  /** Try to spend `cost` tokens; returns false if the caller is over the limit. */
  take(now: number, cost = 1): boolean {
    if (this.left(now) < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** The tokens there are now (spends nothing). */
  left(now: number): number {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    return this.tokens;
  }
}
