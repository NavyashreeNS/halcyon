import type { Clock } from '../clock.js';

export const RolloutPhase = {
  Idle: 'idle',
  Progressing: 'progressing',
  /** Held at the current step: metrics are inconclusive, not yet bad enough to roll back. */
  Paused: 'paused',
  Promoted: 'promoted',
  RolledBack: 'rolled_back',
} as const;
export type RolloutPhase = (typeof RolloutPhase)[keyof typeof RolloutPhase];

/** Metrics for one variant over the current analysis window. */
export interface VariantMetrics {
  requests: number;
  errors: number;
  p95LatencyMs: number;
}

export interface CanaryPolicy {
  /** Traffic percentages the canary steps through. Must be ascending and end at 100. */
  steps: number[];
  /** Consecutive healthy analyses required before advancing a step. */
  healthyChecksToAdvance: number;
  /** Consecutive unhealthy analyses tolerated before rolling back. */
  unhealthyChecksToRollback: number;
  /** Minimum canary requests in a window before its metrics are trusted at all. */
  minimumRequests: number;
  /** Canary p95 may exceed baseline p95 by at most this factor. */
  latencyToleranceFactor: number;
  /** Canary error rate may exceed baseline error rate by at most this factor... */
  errorRateToleranceFactor: number;
  /** ...but is always allowed at least this absolute rate, so a 0% baseline is not a trap. */
  errorRateAbsoluteFloor: number;
  /** Hard ceiling on total rollout duration; exceeding it rolls back. */
  maxDurationMs: number;
}

export const DEFAULT_CANARY_POLICY: CanaryPolicy = {
  steps: [1, 5, 25, 50, 100],
  healthyChecksToAdvance: 3,
  unhealthyChecksToRollback: 2,
  minimumRequests: 100,
  latencyToleranceFactor: 1.2,
  errorRateToleranceFactor: 1.5,
  errorRateAbsoluteFloor: 0.005,
  maxDurationMs: 60 * 60 * 1000,
};

export type AnalysisVerdict =
  | { decision: 'advance'; toPercent: number }
  | { decision: 'promote' }
  | { decision: 'hold'; reason: 'insufficient_data' | 'awaiting_confirmation' }
  | { decision: 'rollback'; reason: 'error_rate' | 'latency' | 'timeout' };

export interface RolloutState {
  phase: RolloutPhase;
  baselineVersion: string;
  canaryVersion: string;
  canaryPercent: number;
  stepIndex: number;
  healthyStreak: number;
  unhealthyStreak: number;
  startedAt: number;
  lastAnalysedAt: number;
  history: AnalysisRecord[];
}

export interface AnalysisRecord {
  at: number;
  canaryPercent: number;
  verdict: AnalysisVerdict;
  baseline: VariantMetrics;
  canary: VariantMetrics;
}

/**
 * SLO-gated progressive rollout controller.
 *
 * Deploying a new model version is riskier than deploying new code. Code either works or
 * throws; a model can be perfectly healthy by every infrastructure metric while being
 * meaningfully worse at its job, and the damage is proportional to how much traffic saw it.
 * So the goal is not to avoid bad versions — it is to bound the blast radius of one.
 *
 * This controller ramps traffic through a step schedule, and at each step compares the
 * canary against the baseline *running concurrently on the same fleet*. Comparing against a
 * historical baseline is the classic mistake: it confounds the version change with time of
 * day, traffic mix, and neighbouring load. A concurrent baseline holds all of that constant.
 *
 * Three guards prevent the two ways this goes wrong in practice:
 *
 *  - **A minimum request count.** At 1% traffic a canary might see eight requests in a
 *    window; two unlucky failures read as a 25% error rate. Below `minimumRequests` the
 *    controller holds rather than acting on noise.
 *  - **Relative *and* absolute error tolerance.** Pure ratios are unusable against a healthy
 *    baseline, where any error at all is an infinite regression.
 *  - **Consecutive-observation streaks.** A single bad window is a blip; `n` in a row is a
 *    trend. Requiring streaks in both directions makes the controller hard to flip with one
 *    unlucky sample, in either direction.
 *
 * Rollback is always immediate and always to 0% — there is no partial retreat, because a
 * version suspected of harming users should stop reaching them at once.
 */
export class CanaryController {
  private readonly policy: CanaryPolicy;
  private state: RolloutState;

  constructor(
    baselineVersion: string,
    canaryVersion: string,
    private readonly clock: Clock,
    policy: Partial<CanaryPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_CANARY_POLICY, ...policy };
    if (this.policy.steps.length === 0) {
      throw new Error('CanaryController: policy.steps must not be empty');
    }
    for (let i = 1; i < this.policy.steps.length; i++) {
      if (this.policy.steps[i]! <= this.policy.steps[i - 1]!) {
        throw new Error('CanaryController: policy.steps must be strictly ascending');
      }
    }
    this.state = {
      phase: RolloutPhase.Idle,
      baselineVersion,
      canaryVersion,
      canaryPercent: 0,
      stepIndex: -1,
      healthyStreak: 0,
      unhealthyStreak: 0,
      startedAt: 0,
      lastAnalysedAt: 0,
      history: [],
    };
  }

  start(): RolloutState {
    const now = this.clock.now();
    this.state = {
      ...this.state,
      phase: RolloutPhase.Progressing,
      stepIndex: 0,
      canaryPercent: this.policy.steps[0]!,
      healthyStreak: 0,
      unhealthyStreak: 0,
      startedAt: now,
      lastAnalysedAt: now,
      history: [],
    };
    return this.snapshot();
  }

  /**
   * Evaluates one analysis window and advances the state machine.
   *
   * Call this on a fixed cadence (Halcyon's control loop uses 30s) with metrics collected
   * over the interval since the previous call.
   */
  analyse(baseline: VariantMetrics, canary: VariantMetrics): AnalysisVerdict {
    const now = this.clock.now();
    if (this.state.phase !== RolloutPhase.Progressing && this.state.phase !== RolloutPhase.Paused) {
      return { decision: 'hold', reason: 'awaiting_confirmation' };
    }

    // The percent the window was *measured* at — recorded before any advance mutates it,
    // so the history reads as "at 5% traffic we saw X" rather than attributing the
    // observation to the step it triggered.
    const measuredAt = this.state.canaryPercent;
    const verdict = this.decide(this.assess(baseline, canary, now));
    this.state.lastAnalysedAt = now;
    this.state.history.push({
      at: now,
      canaryPercent: measuredAt,
      verdict,
      baseline: { ...baseline },
      canary: { ...canary },
    });
    // The history is a debugging aid on the dashboard, not a metrics store — keep it bounded.
    if (this.state.history.length > 200) this.state.history.shift();
    return verdict;
  }

  /**
   * Classifies a single analysis window. Deliberately separated from the state machine:
   * judging a window is a statistical question, deciding what to do about it is a policy
   * question, and conflating the two is how streak-counting bugs get in.
   */
  private assess(baseline: VariantMetrics, canary: VariantMetrics, now: number): WindowAssessment {
    if (now - this.state.startedAt > this.policy.maxDurationMs) {
      return { kind: 'timeout' };
    }
    if (canary.requests < this.policy.minimumRequests) {
      return { kind: 'insufficient' };
    }
    // A baseline p95 of 0 means the baseline served no traffic this window. There is nothing
    // to compare against, so this is missing data — not a passing grade.
    if (baseline.p95LatencyMs <= 0 || baseline.requests <= 0) {
      return { kind: 'insufficient' };
    }

    const errorBudget = Math.max(
      this.policy.errorRateAbsoluteFloor,
      safeRate(baseline.errors, baseline.requests) * this.policy.errorRateToleranceFactor,
    );
    if (safeRate(canary.errors, canary.requests) > errorBudget) {
      return { kind: 'unhealthy', reason: 'error_rate' };
    }

    if (canary.p95LatencyMs > baseline.p95LatencyMs * this.policy.latencyToleranceFactor) {
      return { kind: 'unhealthy', reason: 'latency' };
    }

    return { kind: 'healthy' };
  }

  /** Advances the state machine from a window assessment and returns the resulting verdict. */
  private decide(assessment: WindowAssessment): AnalysisVerdict {
    switch (assessment.kind) {
      case 'timeout':
        this.state.phase = RolloutPhase.RolledBack;
        this.state.canaryPercent = 0;
        return { decision: 'rollback', reason: 'timeout' };

      case 'insufficient':
        // Neither streak moves. A window with too little data is not evidence of health or
        // of sickness, and letting it reset the healthy streak would stall a low-traffic
        // rollout forever while letting it reset the unhealthy streak would mask a real
        // regression behind intermittent quiet periods.
        this.state.phase = RolloutPhase.Paused;
        return { decision: 'hold', reason: 'insufficient_data' };

      case 'unhealthy':
        this.state.unhealthyStreak += 1;
        this.state.healthyStreak = 0;
        if (this.state.unhealthyStreak >= this.policy.unhealthyChecksToRollback) {
          this.state.phase = RolloutPhase.RolledBack;
          this.state.canaryPercent = 0;
          return { decision: 'rollback', reason: assessment.reason };
        }
        this.state.phase = RolloutPhase.Progressing;
        return { decision: 'hold', reason: 'awaiting_confirmation' };

      case 'healthy': {
        this.state.healthyStreak += 1;
        this.state.unhealthyStreak = 0;
        this.state.phase = RolloutPhase.Progressing;
        if (this.state.healthyStreak < this.policy.healthyChecksToAdvance) {
          return { decision: 'hold', reason: 'awaiting_confirmation' };
        }
        const nextIndex = this.state.stepIndex + 1;
        if (nextIndex >= this.policy.steps.length) {
          this.state.phase = RolloutPhase.Promoted;
          this.state.canaryPercent = 100;
          this.state.healthyStreak = 0;
          return { decision: 'promote' };
        }
        this.state.stepIndex = nextIndex;
        this.state.canaryPercent = this.policy.steps[nextIndex]!;
        this.state.healthyStreak = 0;
        return { decision: 'advance', toPercent: this.state.canaryPercent };
      }
    }
  }

  /** Manual override: operators can always stop a rollout. */
  abort(): RolloutState {
    this.state.phase = RolloutPhase.RolledBack;
    this.state.canaryPercent = 0;
    return this.snapshot();
  }

  /** Manual override: skip the remaining steps and take the canary to 100%. */
  forcePromote(): RolloutState {
    this.state.phase = RolloutPhase.Promoted;
    this.state.canaryPercent = 100;
    return this.snapshot();
  }

  /** Current traffic split, ready to hand to a {@link TrafficSplitter}. */
  get split(): { version: string; weight: number }[] {
    const canary = this.state.canaryPercent;
    if (this.state.phase === RolloutPhase.Promoted) {
      return [{ version: this.state.canaryVersion, weight: 100 }];
    }
    if (canary <= 0) return [{ version: this.state.baselineVersion, weight: 100 }];
    return [
      { version: this.state.baselineVersion, weight: 100 - canary },
      { version: this.state.canaryVersion, weight: canary },
    ];
  }

  snapshot(): RolloutState {
    return { ...this.state, history: [...this.state.history] };
  }
}

type WindowAssessment =
  | { kind: 'timeout' }
  | { kind: 'insufficient' }
  | { kind: 'unhealthy'; reason: 'error_rate' | 'latency' }
  | { kind: 'healthy' };

const safeRate = (numerator: number, denominator: number): number =>
  denominator <= 0 ? 0 : numerator / denominator;
