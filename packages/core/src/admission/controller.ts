import type { Clock } from '../clock.js';
import {
  AdaptiveLimiter,
  type AdaptiveLimitOptions,
  type AdaptiveLimitSnapshot,
} from './adaptive-limit.js';
import { TokenBucket } from './token-bucket.js';

export interface TenantQuota {
  readonly tenantId: string;
  /** Burst capacity, in work units. */
  readonly burst: number;
  /** Sustained rate, in work units per second. */
  readonly ratePerSecond: number;
  /**
   * Share of scarce capacity this tenant retains during overload, in [0, 1]. A tenant with
   * a higher priority keeps admitting requests after lower-priority tenants are shed.
   */
  readonly priority: number;
}

export type AdmissionOutcome =
  | { admitted: true; concurrencySlot: true }
  | { admitted: false; reason: 'quota_exceeded'; retryAfterMs: number }
  | { admitted: false; reason: 'overloaded'; retryAfterMs: number }
  | { admitted: false; reason: 'unknown_tenant'; retryAfterMs: number };

export interface AdmissionControllerOptions {
  clock: Clock;
  quotas?: TenantQuota[];
  limiter?: AdaptiveLimitOptions;
  /** Quota applied to tenants that have no explicit entry. Omit to reject them outright. */
  defaultQuota?: Omit<TenantQuota, 'tenantId'>;
}

/**
 * Two-stage admission control.
 *
 * Stage one is **fairness**: a per-tenant token bucket ensures one customer's runaway
 * retry loop cannot consume the capacity another customer is paying for. This is a
 * business-policy decision and is enforced regardless of how healthy the fleet is.
 *
 * Stage two is **self-preservation**: a single fleet-wide adaptive limiter that sheds load
 * when the system itself is in trouble, independent of whose traffic it is. During overload
 * it sheds in priority order, so a `priority: 0.9` tenant survives well past the point where
 * a `priority: 0.1` tenant starts seeing 429s.
 *
 * The ordering matters. Checking the fleet limit first would let a single abusive tenant
 * trigger fleet-wide shedding that penalises well-behaved tenants — the quota check must
 * come first so abuse is attributed to its source.
 */
export class AdmissionController {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly quotas = new Map<string, TenantQuota>();
  private readonly limiter: AdaptiveLimiter;
  private readonly clock: Clock;
  private readonly defaultQuota: Omit<TenantQuota, 'tenantId'> | undefined;

  private admittedCount = 0;
  private readonly rejections: Record<string, number> = {};

  constructor(options: AdmissionControllerOptions) {
    this.clock = options.clock;
    this.limiter = new AdaptiveLimiter(options.limiter);
    this.defaultQuota = options.defaultQuota;
    for (const quota of options.quotas ?? []) this.setQuota(quota);
  }

  setQuota(quota: TenantQuota): void {
    this.quotas.set(quota.tenantId, quota);
    this.buckets.set(
      quota.tenantId,
      new TokenBucket(quota.burst, quota.ratePerSecond, this.clock.now()),
    );
  }

  removeQuota(tenantId: string): void {
    this.quotas.delete(tenantId);
    this.buckets.delete(tenantId);
  }

  private resolve(tenantId: string): { quota: TenantQuota; bucket: TokenBucket } | null {
    const existing = this.quotas.get(tenantId);
    const bucket = this.buckets.get(tenantId);
    if (existing && bucket) return { quota: existing, bucket };
    if (!this.defaultQuota) return null;
    const quota: TenantQuota = { tenantId, ...this.defaultQuota };
    this.setQuota(quota);
    return { quota, bucket: this.buckets.get(tenantId)! };
  }

  /**
   * Decides whether to accept a request costing `cost` work units.
   *
   * On `admitted: true` a concurrency slot has been reserved and the caller **must**
   * eventually call {@link release}, or the fleet limit leaks.
   */
  admit(tenantId: string, cost = 1): AdmissionOutcome {
    const now = this.clock.now();
    const resolved = this.resolve(tenantId);
    if (!resolved) {
      this.rejections['unknown_tenant'] = (this.rejections['unknown_tenant'] ?? 0) + 1;
      return { admitted: false, reason: 'unknown_tenant', retryAfterMs: 0 };
    }

    const { quota, bucket } = resolved;
    if (!bucket.tryConsume(cost, now)) {
      this.rejections['quota_exceeded'] = (this.rejections['quota_exceeded'] ?? 0) + 1;
      const retryAfterMs = bucket.retryAfterMs(cost, now);
      return {
        admitted: false,
        reason: 'quota_exceeded',
        retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 60_000,
      };
    }

    // Priority-graded shedding: a tenant may only occupy up to `priority` of the fleet
    // limit once the system is under pressure. High-priority traffic keeps its access to
    // the full limit; low-priority traffic is squeezed out first.
    const effectiveCeiling = Math.max(
      1,
      Math.floor(this.limiter.currentLimit * clamp01(quota.priority)),
    );
    const underPressure = this.limiter.currentInflight >= effectiveCeiling;
    if (underPressure || !this.limiter.acquire()) {
      this.rejections['overloaded'] = (this.rejections['overloaded'] ?? 0) + 1;
      // Suggest a retry roughly one service time out — long enough to matter, short enough
      // that a legitimate client is not parked for seconds during a transient blip.
      const retryAfterMs = Math.max(10, Math.round(this.limiter.snapshot(now).shortRttMs));
      return { admitted: false, reason: 'overloaded', retryAfterMs };
    }

    this.admittedCount++;
    return { admitted: true, concurrencySlot: true };
  }

  /** Releases the concurrency slot reserved by a successful {@link admit}. */
  release(latencyMs: number, ok = true): void {
    this.limiter.release(latencyMs, this.clock.now(), ok);
  }

  get concurrencyLimit(): number {
    return this.limiter.currentLimit;
  }

  get inflight(): number {
    return this.limiter.currentInflight;
  }

  snapshot(): AdmissionSnapshot {
    return {
      admitted: this.admittedCount,
      rejections: { ...this.rejections },
      tenants: this.quotas.size,
      limiter: this.limiter.snapshot(this.clock.now()),
    };
  }
}

export interface AdmissionSnapshot {
  admitted: number;
  rejections: Record<string, number>;
  tenants: number;
  limiter: AdaptiveLimitSnapshot;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
