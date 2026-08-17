import { Ewma } from '../stats/ewma.js';

/**
 * Adaptive concurrency limiter (a Gradient2-style controller).
 *
 * A static concurrency cap is always wrong. Set it from a load test and it is stale the
 * moment the model changes, the hardware is swapped, or a noisy neighbour lands on the
 * device. Too high and queues build until every request times out; too low and the fleet
 * sits idle while clients get 429s.
 *
 * The insight is that you do not need to know the right limit — you only need to detect
 * *queueing*, and queueing has an unmistakable signature: short-window latency rising above
 * long-window latency. Little's Law says `L = λW`, so with arrival rate fixed, any increase
 * in `W` beyond service time is queue depth. The gradient
 *
 *     g = clamp(longRTT / shortRTT, 0.5, 1.0)
 *
 * is therefore < 1 exactly when a queue is forming, and the limit contracts multiplicatively
 * — fast, because queue collapse is urgent. When no queue is forming `g == 1` and the limit
 * grows by the headroom term `√limit`, which is deliberately sublinear so recovery probes
 * upward gently instead of immediately re-saturating the system it just rescued.
 *
 * This is the same family of controller as TCP congestion control, and for the same reason:
 * neither endpoint can observe the bottleneck directly, so both infer it from delay.
 */
export interface AdaptiveLimitOptions {
  initialLimit?: number;
  minLimit?: number;
  maxLimit?: number;
  /** Time constant of the fast RTT estimate — reacts to the current burst. */
  shortTauMs?: number;
  /** Time constant of the slow RTT estimate — the system's "healthy" baseline. */
  longTauMs?: number;
  /** Fraction of the new limit blended in per update; damps oscillation. */
  smoothing?: number;
  /** Updates are skipped until the limiter has seen this many completions. */
  warmupSamples?: number;
}

export class AdaptiveLimiter {
  private limit: number;
  private readonly minLimit: number;
  private readonly maxLimit: number;
  private readonly smoothing: number;
  private readonly warmupSamples: number;

  private readonly shortRtt: Ewma;
  private readonly longRtt: Ewma;
  private samples = 0;
  private inflight = 0;
  private lastGradient = 1;

  constructor(options: AdaptiveLimitOptions = {}) {
    this.limit = options.initialLimit ?? 20;
    this.minLimit = options.minLimit ?? 4;
    this.maxLimit = options.maxLimit ?? 2_000;
    this.smoothing = options.smoothing ?? 0.2;
    this.warmupSamples = options.warmupSamples ?? 10;
    this.shortRtt = new Ewma(options.shortTauMs ?? 1_000);
    this.longRtt = new Ewma(options.longTauMs ?? 30_000);
    if (this.minLimit < 1) throw new RangeError('AdaptiveLimiter: minLimit must be >= 1');
    if (this.maxLimit < this.minLimit) {
      throw new RangeError('AdaptiveLimiter: maxLimit must be >= minLimit');
    }
    this.limit = clamp(this.limit, this.minLimit, this.maxLimit);
  }

  /** True if there is room under the current limit. Does not reserve. */
  hasCapacity(): boolean {
    return this.inflight < this.limit;
  }

  /** Reserves a slot. Returns false when the limit is already saturated. */
  acquire(): boolean {
    if (this.inflight >= this.limit) return false;
    this.inflight++;
    return true;
  }

  /**
   * Releases a slot and folds the observed round-trip time into the controller.
   *
   * Failed requests still release the slot but are excluded from the RTT estimates: a fast
   * failure would otherwise look like an improvement in latency and cause the limiter to
   * *raise* the limit on a system that is actively falling over.
   */
  release(rttMs: number, now: number, ok = true): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (!ok) return;

    const rtt = Math.max(rttMs, 0.001);
    this.shortRtt.observe(rtt, now);
    this.longRtt.observe(rtt, now);
    this.samples++;
    if (this.samples < this.warmupSamples) return;

    const shortValue = this.shortRtt.get(now);
    const longValue = this.longRtt.get(now);
    if (shortValue <= 0 || longValue <= 0) return;

    // g < 1 => the short window is slower than the baseline => a queue is forming.
    // The 0.5 floor stops a single latency spike from halving the limit more than once.
    const gradient = clamp(longValue / shortValue, 0.5, 1.0);
    this.lastGradient = gradient;

    const headroom = Math.sqrt(this.limit);
    const target = this.limit * gradient + headroom;
    this.limit = clamp(
      this.limit * (1 - this.smoothing) + target * this.smoothing,
      this.minLimit,
      this.maxLimit,
    );
  }

  get currentLimit(): number {
    return Math.floor(this.limit);
  }
  get currentInflight(): number {
    return this.inflight;
  }
  get gradient(): number {
    return this.lastGradient;
  }

  snapshot(now: number): AdaptiveLimitSnapshot {
    return {
      limit: this.currentLimit,
      inflight: this.inflight,
      gradient: Number(this.lastGradient.toFixed(4)),
      shortRttMs: Number(this.shortRtt.get(now).toFixed(2)),
      longRttMs: Number(this.longRtt.get(now).toFixed(2)),
      samples: this.samples,
    };
  }
}

export interface AdaptiveLimitSnapshot {
  limit: number;
  inflight: number;
  gradient: number;
  shortRttMs: number;
  longRttMs: number;
  samples: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
