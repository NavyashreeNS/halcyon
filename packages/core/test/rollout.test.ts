import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { CanaryController, RolloutPhase, type VariantMetrics } from '../src/rollout/canary.js';
import { TrafficSplitter, hashToUnitInterval } from '../src/rollout/traffic-split.js';

const healthy = (requests = 1_000): VariantMetrics => ({ requests, errors: 2, p95LatencyMs: 100 });
const baseline = (): VariantMetrics => ({ requests: 10_000, errors: 20, p95LatencyMs: 100 });

describe('TrafficSplitter', () => {
  it('is deterministic — the same key always resolves to the same version', () => {
    const s = new TrafficSplitter([
      { version: 'v1', weight: 70 },
      { version: 'v2', weight: 30 },
    ]);
    const first = s.select('session-abc');
    for (let i = 0; i < 100; i++) expect(s.select('session-abc')).toBe(first);
  });

  it('honours the configured weights across a large key space', () => {
    const s = new TrafficSplitter([
      { version: 'v1', weight: 90 },
      { version: 'v2', weight: 10 },
    ]);
    let canary = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) if (s.select(`user-${i}`) === 'v2') canary++;
    const observed = (canary / n) * 100;
    expect(observed).toBeGreaterThan(9);
    expect(observed).toBeLessThan(11);
  });

  it('keeps users on the canary as the ramp progresses — assignment only ever adds', () => {
    const at10 = new TrafficSplitter([
      { version: 'v1', weight: 90 },
      { version: 'v2', weight: 10 },
    ]);
    const at50 = new TrafficSplitter([
      { version: 'v1', weight: 50 },
      { version: 'v2', weight: 50 },
    ]);
    for (let i = 0; i < 5_000; i++) {
      const key = `user-${i}`;
      if (at10.select(key) === 'v2') {
        // Anyone already on the canary at 10% must still be on it at 50%.
        expect(at50.select(key)).toBe('v2');
      }
    }
  });

  it('decorrelates independent rollouts via the salt', () => {
    const variants = [
      { version: 'v1', weight: 95 },
      { version: 'v2', weight: 5 },
    ];
    const a = new TrafficSplitter(variants, 'rollout-a');
    const b = new TrafficSplitter(variants, 'rollout-b');
    let agree = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      if (a.select(`user-${i}`) === 'v2' && b.select(`user-${i}`) === 'v2') agree++;
    }
    // If the splits were correlated, ~5% of keys would be canary in both. Independent
    // assignment puts the overlap near 5% * 5% = 0.25%.
    expect(agree / n).toBeLessThan(0.01);
  });

  it('normalises weights that do not sum to 100', () => {
    const s = new TrafficSplitter([
      { version: 'v1', weight: 1 },
      { version: 'v2', weight: 1 },
    ]);
    expect(s.current.map((v) => v.weight)).toEqual([50, 50]);
  });

  it('drops zero-weight variants and throws only when nothing is left', () => {
    const s = new TrafficSplitter([{ version: 'v1', weight: 0 }]);
    expect(() => s.select('anything')).toThrow(/no variants/);
  });

  it('produces a well-distributed hash', () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      buckets[Math.floor(hashToUnitInterval(`key-${i}`) * 10)]!++;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(9_000);
      expect(count).toBeLessThan(11_000);
    }
  });
});

describe('CanaryController', () => {
  const makeController = (policy = {}) => {
    const clock = new ManualClock(0);
    const c = new CanaryController('v1', 'v2', clock, {
      steps: [1, 5, 25, 50, 100],
      healthyChecksToAdvance: 2,
      unhealthyChecksToRollback: 2,
      minimumRequests: 100,
      ...policy,
    });
    return { clock, controller: c };
  };

  it('starts at the first step', () => {
    const { controller } = makeController();
    const state = controller.start();
    expect(state.phase).toBe(RolloutPhase.Progressing);
    expect(state.canaryPercent).toBe(1);
  });

  it('requires a streak of healthy windows before advancing', () => {
    const { controller } = makeController();
    controller.start();
    expect(controller.analyse(baseline(), healthy())).toEqual({
      decision: 'hold',
      reason: 'awaiting_confirmation',
    });
    expect(controller.snapshot().canaryPercent).toBe(1);
    expect(controller.analyse(baseline(), healthy())).toEqual({
      decision: 'advance',
      toPercent: 5,
    });
    expect(controller.snapshot().canaryPercent).toBe(5);
  });

  it('walks the full step schedule and promotes at the end', () => {
    const { controller } = makeController();
    controller.start();
    for (let step = 0; step < 4; step++) {
      controller.analyse(baseline(), healthy());
      controller.analyse(baseline(), healthy());
    }
    controller.analyse(baseline(), healthy());
    const verdict = controller.analyse(baseline(), healthy());
    expect(verdict).toEqual({ decision: 'promote' });
    expect(controller.snapshot().phase).toBe(RolloutPhase.Promoted);
    expect(controller.split).toEqual([{ version: 'v2', weight: 100 }]);
  });

  it('rolls back on a sustained error-rate regression', () => {
    const { controller } = makeController();
    controller.start();
    const bad: VariantMetrics = { requests: 1_000, errors: 200, p95LatencyMs: 100 };
    expect(controller.analyse(baseline(), bad)).toEqual({
      decision: 'hold',
      reason: 'awaiting_confirmation',
    });
    expect(controller.analyse(baseline(), bad)).toEqual({
      decision: 'rollback',
      reason: 'error_rate',
    });
    expect(controller.snapshot().canaryPercent).toBe(0);
    expect(controller.split).toEqual([{ version: 'v1', weight: 100 }]);
  });

  it('rolls back on a sustained latency regression', () => {
    const { controller } = makeController();
    controller.start();
    const slow: VariantMetrics = { requests: 1_000, errors: 2, p95LatencyMs: 400 };
    controller.analyse(baseline(), slow);
    expect(controller.analyse(baseline(), slow)).toEqual({
      decision: 'rollback',
      reason: 'latency',
    });
  });

  it('tolerates a regression inside the configured budget', () => {
    const { controller } = makeController({ latencyToleranceFactor: 1.5 });
    controller.start();
    // 140ms against a 100ms baseline is within a 1.5x budget.
    const slightlySlower: VariantMetrics = { requests: 1_000, errors: 2, p95LatencyMs: 140 };
    controller.analyse(baseline(), slightlySlower);
    expect(controller.analyse(baseline(), slightlySlower)).toEqual({
      decision: 'advance',
      toPercent: 5,
    });
  });

  it('permits the absolute error floor against a flawless baseline', () => {
    const { controller } = makeController({ errorRateAbsoluteFloor: 0.01 });
    controller.start();
    const flawless: VariantMetrics = { requests: 10_000, errors: 0, p95LatencyMs: 100 };
    // 0.5% errors against a 0% baseline: infinite relative regression, but under the floor.
    const canary: VariantMetrics = { requests: 1_000, errors: 5, p95LatencyMs: 100 };
    controller.analyse(flawless, canary);
    expect(controller.analyse(flawless, canary)).toEqual({ decision: 'advance', toPercent: 5 });
  });

  it('does not act on a window with too few canary requests', () => {
    const { controller } = makeController();
    controller.start();
    const sparse: VariantMetrics = { requests: 8, errors: 4, p95LatencyMs: 9_000 };
    expect(controller.analyse(baseline(), sparse)).toEqual({
      decision: 'hold',
      reason: 'insufficient_data',
    });
    expect(controller.snapshot().phase).toBe(RolloutPhase.Paused);
    expect(controller.snapshot().canaryPercent).toBe(1);
  });

  it('preserves the healthy streak across a data-sparse window', () => {
    const { controller } = makeController({ healthyChecksToAdvance: 2 });
    controller.start();
    controller.analyse(baseline(), healthy());
    // A quiet window in the middle must not reset progress...
    controller.analyse(baseline(), { requests: 3, errors: 0, p95LatencyMs: 100 });
    // ...so the next healthy window still advances.
    expect(controller.analyse(baseline(), healthy())).toEqual({
      decision: 'advance',
      toPercent: 5,
    });
  });

  it('holds when the baseline itself has no traffic to compare against', () => {
    const { controller } = makeController();
    controller.start();
    const noBaseline: VariantMetrics = { requests: 0, errors: 0, p95LatencyMs: 0 };
    expect(controller.analyse(noBaseline, healthy())).toEqual({
      decision: 'hold',
      reason: 'insufficient_data',
    });
  });

  it('rolls back a rollout that overruns its deadline', () => {
    const { controller, clock } = makeController({ maxDurationMs: 1_000 });
    controller.start();
    clock.advance(1_001);
    expect(controller.analyse(baseline(), healthy())).toEqual({
      decision: 'rollback',
      reason: 'timeout',
    });
  });

  it('ignores further analyses once terminal', () => {
    const { controller } = makeController();
    controller.start();
    controller.abort();
    expect(controller.analyse(baseline(), healthy())).toEqual({
      decision: 'hold',
      reason: 'awaiting_confirmation',
    });
    expect(controller.snapshot().phase).toBe(RolloutPhase.RolledBack);
  });

  it('supports an operator forcing promotion', () => {
    const { controller } = makeController();
    controller.start();
    const state = controller.forcePromote();
    expect(state.phase).toBe(RolloutPhase.Promoted);
    expect(controller.split).toEqual([{ version: 'v2', weight: 100 }]);
  });

  it('exposes a split that always sums to 100', () => {
    const { controller } = makeController();
    controller.start();
    const split = controller.split;
    expect(split.reduce((sum, v) => sum + v.weight, 0)).toBe(100);
    expect(split).toEqual([
      { version: 'v1', weight: 99 },
      { version: 'v2', weight: 1 },
    ]);
  });

  it('records an audit trail attributed to the traffic level it was measured at', () => {
    const { controller } = makeController();
    controller.start();
    controller.analyse(baseline(), healthy());
    controller.analyse(baseline(), healthy());
    const history = controller.snapshot().history;
    expect(history).toHaveLength(2);
    // Both windows were observed while the canary was still at 1%.
    expect(history.map((h) => h.canaryPercent)).toEqual([1, 1]);
    expect(history[1]!.verdict).toEqual({ decision: 'advance', toPercent: 5 });
  });

  it('rejects a non-ascending step schedule', () => {
    const clock = new ManualClock(0);
    expect(() => new CanaryController('v1', 'v2', clock, { steps: [10, 5] })).toThrow(/ascending/);
    expect(() => new CanaryController('v1', 'v2', clock, { steps: [] })).toThrow(/not be empty/);
  });
});
