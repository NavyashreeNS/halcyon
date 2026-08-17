import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { AdaptiveLimiter } from '../src/admission/adaptive-limit.js';
import { AdmissionController } from '../src/admission/controller.js';
import { TokenBucket } from '../src/admission/token-bucket.js';

describe('TokenBucket', () => {
  it('permits a burst up to capacity then refuses', () => {
    const b = new TokenBucket(10, 1, 0);
    for (let i = 0; i < 10; i++) expect(b.tryConsume(1, 0)).toBe(true);
    expect(b.tryConsume(1, 0)).toBe(false);
  });

  it('refills lazily at the configured rate', () => {
    const b = new TokenBucket(10, 5, 0);
    expect(b.tryConsume(10, 0)).toBe(true);
    expect(b.tryConsume(1, 0)).toBe(false);
    // 5 tokens/sec => 1 token after 200ms.
    expect(b.tryConsume(1, 200)).toBe(true);
  });

  it('never accrues beyond capacity however long it idles', () => {
    const b = new TokenBucket(10, 100, 0);
    expect(b.available(60_000)).toBe(10);
  });

  it('reports an actionable retry delay', () => {
    const b = new TokenBucket(10, 10, 0);
    b.tryConsume(10, 0);
    expect(b.retryAfterMs(5, 0)).toBe(500);
    expect(b.retryAfterMs(1, 0)).toBe(100);
  });

  it('reports an infinite retry delay for a request larger than capacity', () => {
    const b = new TokenBucket(10, 10, 0);
    expect(b.retryAfterMs(11, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('spends nothing on a refused request', () => {
    const b = new TokenBucket(10, 1, 0);
    b.tryConsume(9, 0);
    expect(b.tryConsume(5, 0)).toBe(false);
    expect(b.available(0)).toBeCloseTo(1, 5);
  });

  it('rejects invalid configuration', () => {
    expect(() => new TokenBucket(0, 1)).toThrow(RangeError);
    expect(() => new TokenBucket(1, 0)).toThrow(RangeError);
  });
});

describe('AdaptiveLimiter', () => {
  it('grows the limit while latency stays flat', () => {
    const l = new AdaptiveLimiter({ initialLimit: 10, minLimit: 4, maxLimit: 1_000 });
    const start = l.currentLimit;
    let t = 0;
    for (let i = 0; i < 200; i++) {
      l.acquire();
      t += 10;
      l.release(20, t);
    }
    expect(l.currentLimit).toBeGreaterThan(start);
  });

  it('contracts the limit when short-window latency rises above the baseline', () => {
    const l = new AdaptiveLimiter({ initialLimit: 50, minLimit: 4, maxLimit: 1_000 });
    let t = 0;
    for (let i = 0; i < 300; i++) {
      l.acquire();
      t += 10;
      l.release(20, t);
    }
    const healthy = l.currentLimit;

    // Latency jumps 20x — the signature of a queue building up.
    for (let i = 0; i < 100; i++) {
      l.acquire();
      t += 10;
      l.release(400, t);
    }
    expect(l.currentLimit).toBeLessThan(healthy);
    expect(l.gradient).toBeLessThan(1);
  });

  it('never falls below the floor or rises above the ceiling', () => {
    const l = new AdaptiveLimiter({ initialLimit: 10, minLimit: 5, maxLimit: 12 });
    let t = 0;
    for (let i = 0; i < 500; i++) {
      l.acquire();
      t += 5;
      l.release(i % 2 === 0 ? 5 : 5_000, t);
    }
    expect(l.currentLimit).toBeGreaterThanOrEqual(5);
    expect(l.currentLimit).toBeLessThanOrEqual(12);
  });

  it('refuses to acquire past the limit', () => {
    const l = new AdaptiveLimiter({ initialLimit: 3, minLimit: 1 });
    expect(l.acquire()).toBe(true);
    expect(l.acquire()).toBe(true);
    expect(l.acquire()).toBe(true);
    expect(l.acquire()).toBe(false);
    expect(l.currentInflight).toBe(3);
  });

  it('ignores failed requests when estimating latency', () => {
    const l = new AdaptiveLimiter({ initialLimit: 20, warmupSamples: 5 });
    let t = 0;
    for (let i = 0; i < 100; i++) {
      l.acquire();
      t += 10;
      l.release(50, t);
    }
    const before = l.currentLimit;
    // A burst of instant failures must not read as "the system got faster".
    for (let i = 0; i < 50; i++) {
      l.acquire();
      t += 10;
      l.release(0.1, t, false);
    }
    expect(l.currentLimit).toBe(before);
    expect(l.currentInflight).toBe(0);
  });

  it('rejects contradictory bounds', () => {
    expect(() => new AdaptiveLimiter({ minLimit: 0 })).toThrow(RangeError);
    expect(() => new AdaptiveLimiter({ minLimit: 10, maxLimit: 5 })).toThrow(RangeError);
  });
});

describe('AdmissionController', () => {
  const quota = (tenantId: string, priority = 1) => ({
    tenantId,
    burst: 10,
    ratePerSecond: 10,
    priority,
  });

  it('rejects an unknown tenant when no default quota is configured', () => {
    const clock = new ManualClock(0);
    const c = new AdmissionController({ clock });
    expect(c.admit('nobody')).toEqual({
      admitted: false,
      reason: 'unknown_tenant',
      retryAfterMs: 0,
    });
  });

  it('auto-provisions from the default quota when one is configured', () => {
    const clock = new ManualClock(0);
    const c = new AdmissionController({
      clock,
      defaultQuota: { burst: 5, ratePerSecond: 5, priority: 0.5 },
    });
    expect(c.admit('newcomer').admitted).toBe(true);
    expect(c.snapshot().tenants).toBe(1);
  });

  it('isolates tenants: one tenant exhausting its quota does not affect another', () => {
    const clock = new ManualClock(0);
    const c = new AdmissionController({ clock, quotas: [quota('noisy'), quota('quiet')] });

    for (let i = 0; i < 10; i++) expect(c.admit('noisy').admitted).toBe(true);
    const rejected = c.admit('noisy');
    expect(rejected.admitted).toBe(false);
    expect(rejected.admitted === false && rejected.reason).toBe('quota_exceeded');
    expect(rejected.admitted === false && rejected.retryAfterMs).toBeGreaterThan(0);

    // The well-behaved tenant is untouched.
    expect(c.admit('quiet').admitted).toBe(true);
  });

  it('restores a tenant after its bucket refills', () => {
    const clock = new ManualClock(0);
    const c = new AdmissionController({ clock, quotas: [quota('t')] });
    for (let i = 0; i < 10; i++) c.admit('t');
    expect(c.admit('t').admitted).toBe(false);
    clock.advance(1_000);
    expect(c.admit('t').admitted).toBe(true);
  });

  it('sheds low-priority traffic before high-priority traffic under pressure', () => {
    const clock = new ManualClock(0);
    const c = new AdmissionController({
      clock,
      quotas: [
        { tenantId: 'premium', burst: 10_000, ratePerSecond: 10_000, priority: 1 },
        { tenantId: 'free', burst: 10_000, ratePerSecond: 10_000, priority: 0.2 },
      ],
      limiter: { initialLimit: 10, minLimit: 10, maxLimit: 10 },
    });

    // Fill the fleet to 20% of its limit — past the free tier's ceiling of 10 * 0.2 = 2.
    for (let i = 0; i < 2; i++) expect(c.admit('premium').admitted).toBe(true);

    const free = c.admit('free');
    expect(free.admitted).toBe(false);
    expect(free.admitted === false && free.reason).toBe('overloaded');

    // Premium still has headroom all the way to the full limit.
    expect(c.admit('premium').admitted).toBe(true);
  });

  it('releases concurrency slots so admission recovers', () => {
    const clock = new ManualClock(0);
    const c = new AdmissionController({
      clock,
      defaultQuota: { burst: 10_000, ratePerSecond: 10_000, priority: 1 },
      limiter: { initialLimit: 2, minLimit: 2, maxLimit: 2 },
    });
    expect(c.admit('t').admitted).toBe(true);
    expect(c.admit('t').admitted).toBe(true);
    expect(c.admit('t').admitted).toBe(false);

    c.release(20);
    expect(c.admit('t').admitted).toBe(true);
  });

  it('accounts every decision in its snapshot', () => {
    const clock = new ManualClock(0);
    const c = new AdmissionController({ clock, quotas: [quota('t')] });
    for (let i = 0; i < 12; i++) c.admit('t');
    const snap = c.snapshot();
    expect(snap.admitted).toBe(10);
    expect(snap.rejections['quota_exceeded']).toBe(2);
  });
});
