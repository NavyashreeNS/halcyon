/**
 * Lazily-refilled token bucket.
 *
 * There is no background timer: the bucket computes how many tokens *would* have accrued
 * since it was last touched, at the moment it is asked. That matters at gateway scale —
 * a timer per tenant across 100k tenants is 100k wakeups the event loop does not need.
 *
 * `capacity` sets how large a burst is tolerated; `refillPerSecond` sets the sustained rate.
 * Keeping them independent is the point: an interactive tenant can be allowed a burst of
 * 100 with a sustained rate of 10/s, which absorbs a page load without permitting a
 * sustained flood.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    startedAt = 0,
    initialTokens?: number,
  ) {
    if (capacity <= 0) throw new RangeError('TokenBucket: capacity must be > 0');
    if (refillPerSecond <= 0) throw new RangeError('TokenBucket: refillPerSecond must be > 0');
    this.tokens = initialTokens ?? capacity;
    this.lastRefill = startedAt;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Attempts to spend `cost` tokens. Returns false and spends nothing if short. */
  tryConsume(cost: number, now: number): boolean {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /**
   * Milliseconds until `cost` tokens are available. Drives the `Retry-After` header, which
   * is what turns a 429 from a dead end into an actionable instruction for the client.
   */
  retryAfterMs(cost: number, now: number): number {
    this.refill(now);
    if (this.tokens >= cost) return 0;
    if (cost > this.capacity) return Number.POSITIVE_INFINITY;
    return Math.ceil(((cost - this.tokens) / this.refillPerSecond) * 1000);
  }

  available(now: number): number {
    this.refill(now);
    return this.tokens;
  }
}
