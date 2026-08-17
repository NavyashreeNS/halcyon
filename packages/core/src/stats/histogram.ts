/**
 * A log-linear (HDR-style) latency histogram.
 *
 * Computing p99 by keeping every sample and sorting is O(n log n) in time and O(n) in
 * memory — untenable on a hot path that sees millions of requests. Reservoir sampling is
 * cheap but gives you a *random* subset, which is exactly the wrong trade when the tail is
 * the thing you care about.
 *
 * This structure instead pre-allocates a fixed set of buckets whose widths grow with the
 * magnitude of the value, giving constant relative error across the entire range. Recording
 * is O(1) with no allocation; quantiles are O(buckets). At the default 8 bits of precision
 * the worst-case relative error is 2^-7 ≈ 0.78%, and the whole thing fits in 2,048 slots
 * (8 KiB) regardless of how many samples it has absorbed.
 *
 * Because buckets are structurally identical across instances, histograms are trivially
 * mergeable — which is how per-replica histograms roll up into a fleet-wide view.
 */
export class LatencyHistogram {
  private readonly precisionBits: number;
  private readonly subBucketCount: number;
  private readonly subBucketHalfCount: number;
  private readonly counts: Uint32Array;

  private totalCount = 0;
  private sum = 0;
  private minValue = Number.POSITIVE_INFINITY;
  private maxValue = 0;

  /**
   * @param precisionBits Bits of precision; relative error is `2^-(precisionBits-1)`.
   * @param highestTrackable Largest value recorded without saturating, in the same unit
   *   as the samples (milliseconds, by convention, throughout Halcyon).
   */
  constructor(precisionBits = 8, highestTrackable = 3_600_000) {
    if (precisionBits < 2 || precisionBits > 16) {
      throw new RangeError('LatencyHistogram: precisionBits must be in [2, 16]');
    }
    this.precisionBits = precisionBits;
    this.subBucketCount = 1 << precisionBits;
    this.subBucketHalfCount = this.subBucketCount >>> 1;

    const topExponent = Math.max(
      precisionBits,
      Math.ceil(Math.log2(Math.max(2, highestTrackable))),
    );
    const shiftCount = topExponent - precisionBits + 1;
    this.counts = new Uint32Array(this.subBucketCount + shiftCount * this.subBucketHalfCount);
  }

  /** Maps a value onto its bucket. Small values are tracked exactly; large ones logarithmically. */
  private indexOf(value: number): number {
    const v = Math.floor(value);
    if (v < this.subBucketCount) return v;
    const exponent = 31 - Math.clz32(v);
    const shift = exponent - this.precisionBits + 1;
    const sub = (v >>> shift) - this.subBucketHalfCount;
    const idx = this.subBucketCount + (shift - 1) * this.subBucketHalfCount + sub;
    return Math.min(idx, this.counts.length - 1);
  }

  /** Representative value for a bucket: its midpoint, which minimises expected error. */
  private valueAt(index: number): number {
    if (index < this.subBucketCount) return index;
    const offset = index - this.subBucketCount;
    const shift = Math.floor(offset / this.subBucketHalfCount) + 1;
    const sub = offset % this.subBucketHalfCount;
    const low = (sub + this.subBucketHalfCount) * Math.pow(2, shift);
    const width = Math.pow(2, shift);
    return low + width / 2;
  }

  record(value: number, count = 1): void {
    const v = value < 0 ? 0 : value;
    const index = this.indexOf(v);
    this.counts[index] = (this.counts[index] ?? 0) + count;
    this.totalCount += count;
    this.sum += v * count;
    if (v < this.minValue) this.minValue = v;
    if (v > this.maxValue) this.maxValue = v;
  }

  /**
   * Value at the given quantile, `q` in [0, 1]. Returns 0 for an empty histogram so callers
   * on a cold path do not have to special-case `NaN` in their scoring arithmetic.
   */
  quantile(q: number): number {
    if (this.totalCount === 0) return 0;
    const clamped = Math.min(1, Math.max(0, q));
    // `ceil` makes p100 land on the last populated bucket rather than one short of it.
    const target = Math.max(1, Math.ceil(clamped * this.totalCount));
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const c = this.counts[i] ?? 0;
      if (c === 0) continue;
      seen += c;
      if (seen >= target) return this.valueAt(i);
    }
    return this.maxValue;
  }

  get p50(): number {
    return this.quantile(0.5);
  }
  get p95(): number {
    return this.quantile(0.95);
  }
  get p99(): number {
    return this.quantile(0.99);
  }
  get count(): number {
    return this.totalCount;
  }
  get mean(): number {
    return this.totalCount === 0 ? 0 : this.sum / this.totalCount;
  }
  get min(): number {
    return this.totalCount === 0 ? 0 : this.minValue;
  }
  get max(): number {
    return this.maxValue;
  }

  /** Folds `other` into this histogram. Both must share the same bucket layout. */
  merge(other: LatencyHistogram): void {
    if (other.counts.length !== this.counts.length) {
      throw new Error('LatencyHistogram: cannot merge histograms with differing layouts');
    }
    for (let i = 0; i < this.counts.length; i++) {
      this.counts[i] = (this.counts[i] ?? 0) + (other.counts[i] ?? 0);
    }
    this.totalCount += other.totalCount;
    this.sum += other.sum;
    if (other.totalCount > 0) {
      this.minValue = Math.min(this.minValue, other.minValue);
      this.maxValue = Math.max(this.maxValue, other.maxValue);
    }
  }

  reset(): void {
    this.counts.fill(0);
    this.totalCount = 0;
    this.sum = 0;
    this.minValue = Number.POSITIVE_INFINITY;
    this.maxValue = 0;
  }

  /** Compact wire form for the metrics endpoint. */
  snapshot(): HistogramSnapshot {
    return {
      count: this.totalCount,
      mean: Number(this.mean.toFixed(3)),
      min: this.min,
      max: this.max,
      p50: this.p50,
      p95: this.p95,
      p99: this.p99,
    };
  }
}

export interface HistogramSnapshot {
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}
