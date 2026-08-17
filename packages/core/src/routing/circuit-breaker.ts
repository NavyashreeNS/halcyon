/**
 * Per-replica circuit breaker with a sliding outcome window and exponential re-open backoff.
 *
 * A GPU replica that has started OOM-ing or thermal-throttling will happily keep accepting
 * requests and failing them milliseconds later. Because it fails *fast*, a naive
 * latency-based load balancer will actually route it *more* traffic — the classic
 * black-hole failure mode. The breaker exists to take such a replica out of rotation on
 * the basis of outcomes rather than timing, and to probe it back in cautiously.
 */
export const BreakerState = {
  /** Normal operation. All requests pass. */
  Closed: 'closed',
  /** Replica is shunned. Requests are rejected without being dispatched. */
  Open: 'open',
  /** A limited number of probes are allowed through to test for recovery. */
  HalfOpen: 'half_open',
} as const;
export type BreakerState = (typeof BreakerState)[keyof typeof BreakerState];

export interface CircuitBreakerOptions {
  /** Size of the sliding window of recent outcomes. */
  windowSize: number;
  /** Failure ratio in [0, 1] that trips the breaker. */
  failureThreshold: number;
  /** Minimum observations before the ratio is trusted — protects against a 1/1 trip. */
  minimumVolume: number;
  /** How long the breaker stays open before the first recovery probe. */
  openDurationMs: number;
  /** Each consecutive failed recovery multiplies the open duration by this factor. */
  backoffMultiplier: number;
  /** Ceiling on the backed-off open duration. */
  maxOpenDurationMs: number;
  /** Concurrent probes permitted while half-open. */
  halfOpenMaxProbes: number;
  /** Consecutive probe successes required to close the breaker. */
  halfOpenSuccessesToClose: number;
}

export const DEFAULT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  windowSize: 50,
  failureThreshold: 0.5,
  minimumVolume: 10,
  openDurationMs: 5_000,
  backoffMultiplier: 2,
  maxOpenDurationMs: 60_000,
  halfOpenMaxProbes: 2,
  halfOpenSuccessesToClose: 3,
};

export class CircuitBreaker {
  private readonly options: CircuitBreakerOptions;
  /** Ring buffer of outcomes: 1 = failure, 0 = success. */
  private readonly window: Uint8Array;
  private cursor = 0;
  private filled = 0;
  private failures = 0;

  private state: BreakerState = BreakerState.Closed;
  private openedAt = 0;
  private currentOpenDuration: number;
  private consecutiveTrips = 0;
  private probesInFlight = 0;
  private halfOpenSuccesses = 0;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_BREAKER_OPTIONS, ...options };
    this.window = new Uint8Array(this.options.windowSize);
    this.currentOpenDuration = this.options.openDurationMs;
  }

  /**
   * Whether a request may be dispatched right now. Has side effects: it performs the
   * open -> half-open transition and reserves a probe slot, so callers must pair every
   * `true` with a subsequent `onSuccess`/`onFailure`.
   */
  tryAcquire(now: number): boolean {
    if (this.state === BreakerState.Open) {
      if (now - this.openedAt < this.currentOpenDuration) return false;
      this.state = BreakerState.HalfOpen;
      this.probesInFlight = 0;
      this.halfOpenSuccesses = 0;
    }
    if (this.state === BreakerState.HalfOpen) {
      if (this.probesInFlight >= this.options.halfOpenMaxProbes) return false;
      this.probesInFlight++;
      return true;
    }
    return true;
  }

  onSuccess(now: number): void {
    if (this.state === BreakerState.HalfOpen) {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.options.halfOpenSuccessesToClose) {
        this.close();
      }
      return;
    }
    this.record(0);
    this.evaluate(now);
  }

  onFailure(now: number): void {
    if (this.state === BreakerState.HalfOpen) {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      // A failed probe means the replica is still sick — back off harder before retrying.
      this.trip(now);
      return;
    }
    this.record(1);
    this.evaluate(now);
  }

  private record(outcome: 0 | 1): void {
    const previous = this.window[this.cursor] ?? 0;
    if (this.filled === this.options.windowSize) {
      this.failures -= previous;
    } else {
      this.filled++;
    }
    this.window[this.cursor] = outcome;
    this.failures += outcome;
    this.cursor = (this.cursor + 1) % this.options.windowSize;
  }

  private evaluate(now: number): void {
    if (this.state !== BreakerState.Closed) return;
    if (this.filled < this.options.minimumVolume) return;
    if (this.failures / this.filled >= this.options.failureThreshold) {
      this.trip(now);
    }
  }

  private trip(now: number): void {
    this.state = BreakerState.Open;
    this.openedAt = now;
    this.probesInFlight = 0;
    this.halfOpenSuccesses = 0;
    this.currentOpenDuration = Math.min(
      this.options.maxOpenDurationMs,
      this.options.openDurationMs * Math.pow(this.options.backoffMultiplier, this.consecutiveTrips),
    );
    this.consecutiveTrips++;
  }

  private close(): void {
    this.state = BreakerState.Closed;
    this.consecutiveTrips = 0;
    this.currentOpenDuration = this.options.openDurationMs;
    this.probesInFlight = 0;
    this.halfOpenSuccesses = 0;
    this.window.fill(0);
    this.cursor = 0;
    this.filled = 0;
    this.failures = 0;
  }

  /** Read-only view of the current state, applying the open -> half-open deadline. */
  peek(now: number): BreakerState {
    if (this.state === BreakerState.Open && now - this.openedAt >= this.currentOpenDuration) {
      return BreakerState.HalfOpen;
    }
    return this.state;
  }

  get failureRate(): number {
    return this.filled === 0 ? 0 : this.failures / this.filled;
  }

  snapshot(now: number): BreakerSnapshot {
    return {
      state: this.peek(now),
      failureRate: Number(this.failureRate.toFixed(4)),
      observations: this.filled,
      consecutiveTrips: this.consecutiveTrips,
      openDurationMs: this.currentOpenDuration,
    };
  }
}

export interface BreakerSnapshot {
  state: BreakerState;
  failureRate: number;
  observations: number;
  consecutiveTrips: number;
  openDurationMs: number;
}
