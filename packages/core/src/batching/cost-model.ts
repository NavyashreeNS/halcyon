/**
 * Online estimator for how long a batch will take to execute.
 *
 * Batching only pays off because GPU service time is *affine*, not linear, in batch size:
 * a fixed kernel-launch and weight-load cost is amortised across the batch, and only the
 * per-token arithmetic scales. So we model
 *
 *     serviceTimeMs ≈ intercept + slope × batchTokens
 *
 * and fit it by recursive least squares with exponential forgetting. Forgetting matters:
 * the same model behaves differently after a hardware change, a driver upgrade, or a
 * co-tenant landing on the same device, and a fit with unbounded memory would take hours
 * to notice. With `forgetting = 0.98` the estimator's effective window is ~50 batches.
 *
 * The scheduler uses `predict()` to answer the only question that matters when deciding
 * whether to keep waiting: *if I admit one more request, do I still make everyone's SLO?*
 */
export class BatchCostModel {
  // Exponentially-decayed sufficient statistics for ordinary least squares.
  private n = 0;
  private sumX = 0;
  private sumY = 0;
  private sumXX = 0;
  private sumXY = 0;

  private cachedSlope: number;
  private cachedIntercept: number;

  constructor(
    priorInterceptMs = 8,
    priorSlopeMsPerToken = 0.05,
    private readonly forgetting = 0.98,
  ) {
    if (forgetting <= 0 || forgetting > 1) {
      throw new RangeError('BatchCostModel: forgetting must be in (0, 1]');
    }
    this.cachedSlope = priorSlopeMsPerToken;
    this.cachedIntercept = priorInterceptMs;
  }

  /** Records an executed batch: `tokens` units of work took `durationMs`. */
  observe(tokens: number, durationMs: number): void {
    const g = this.forgetting;
    this.n = this.n * g + 1;
    this.sumX = this.sumX * g + tokens;
    this.sumY = this.sumY * g + durationMs;
    this.sumXX = this.sumXX * g + tokens * tokens;
    this.sumXY = this.sumXY * g + tokens * durationMs;
    this.refit();
  }

  private refit(): void {
    if (this.n < 4) return;

    // Guard against an ill-conditioned fit. `denominator` is n² times the variance of the
    // batch sizes seen, so comparing it against the *scale* of those sizes asks the right
    // question: has this estimator actually observed a spread of shapes, or has every batch
    // been the same size? Fitting a slope through a single cluster of x-values extrapolates
    // wildly, and a scheduler that believes the extrapolation will shed traffic it could
    // easily have served.
    const denominator = this.n * this.sumXX - this.sumX * this.sumX;
    const meanX = this.sumX / this.n;
    const conditioning = 1e-3 * this.n * this.n * Math.max(1, meanX * meanX);
    if (denominator < conditioning) return;

    let slope = (this.n * this.sumXY - this.sumX * this.sumY) / denominator;
    let intercept = (this.sumY - slope * this.sumX) / this.n;

    // Both parameters are physically constrained to be non-negative: work cannot take
    // negative time, and a larger batch cannot be cheaper than a smaller one.
    //
    // Clamping them *independently* is a trap, and an expensive one. The two are coupled
    // through `intercept = mean(y) - slope * mean(x)`, so a spuriously negative slope
    // inflates the intercept by exactly `|slope| * mean(x)` — with realistic batch sizes,
    // an intercept in the seconds. Truncating the slope to zero afterwards leaves that
    // inflated intercept in place, and the scheduler concludes every deadline is
    // unreachable. The correct treatment is to re-solve with the violated constraint held
    // active, which is what constrained least squares does.
    if (slope < 0) {
      slope = 0;
      intercept = this.sumY / this.n;
    }
    if (intercept < 0) {
      intercept = 0;
      slope = this.sumXX > 0 ? this.sumXY / this.sumXX : 0;
    }

    this.cachedSlope = slope;
    this.cachedIntercept = intercept;
  }

  /** Predicted wall-clock milliseconds to execute a batch of `tokens` units. */
  predict(tokens: number): number {
    return this.cachedIntercept + this.cachedSlope * Math.max(0, tokens);
  }

  /** Marginal cost of admitting `deltaTokens` more work into the current batch. */
  marginalCost(deltaTokens: number): number {
    return this.cachedSlope * Math.max(0, deltaTokens);
  }

  get slope(): number {
    return this.cachedSlope;
  }
  get intercept(): number {
    return this.cachedIntercept;
  }
  /** Effective (decayed) number of observations backing the current fit. */
  get sampleWeight(): number {
    return this.n;
  }
  get isFitted(): boolean {
    return this.n >= 4;
  }

  snapshot(): { interceptMs: number; slopeMsPerToken: number; sampleWeight: number } {
    return {
      interceptMs: Number(this.cachedIntercept.toFixed(4)),
      slopeMsPerToken: Number(this.cachedSlope.toFixed(6)),
      sampleWeight: Number(this.n.toFixed(2)),
    };
  }
}
