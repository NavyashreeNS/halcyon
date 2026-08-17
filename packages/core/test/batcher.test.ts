import { beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { BatchCostModel } from '../src/batching/cost-model.js';
import {
  ContinuousBatcher,
  Lane,
  type BatchFlush,
  type BatcherOptions,
} from '../src/batching/batcher.js';

const T0 = 1_000;

function makeBatcher(overrides: Partial<BatcherOptions<string>> = {}) {
  const clock = new ManualClock(T0);
  const flushes: BatchFlush<string>[] = [];
  const batcher = new ContinuousBatcher<string>({
    maxBatchSize: 4,
    maxBatchTokens: 10_000,
    maxQueueDepth: 16,
    lingerMs: 20,
    safetyMarginMs: 2,
    starvationGuardMs: 50,
    clock,
    onFlush: (b) => flushes.push(b),
    ...overrides,
  });
  return { clock, flushes, batcher };
}

/** Default cost model prior: 8ms fixed + 0.05ms/token. A 10-token item costs 8.5ms. */
const soloCost = (tokens: number) => 8 + 0.05 * tokens;

function item(
  id: string,
  opts: { tokens?: number; deadlineIn?: number; lane?: Lane; at?: number } = {},
) {
  const at = opts.at ?? T0;
  return {
    id,
    payload: id,
    tokens: opts.tokens ?? 10,
    lane: opts.lane ?? Lane.Interactive,
    deadlineAt: at + (opts.deadlineIn ?? 1_000),
    enqueuedAt: at,
  };
}

describe('ContinuousBatcher', () => {
  let ctx: ReturnType<typeof makeBatcher>;
  beforeEach(() => {
    ctx = makeBatcher();
  });

  it('flushes as soon as the batch saturates', () => {
    for (let i = 0; i < 4; i++) {
      expect(ctx.batcher.enqueue(item(`r${i}`)).accepted).toBe(true);
    }
    expect(ctx.flushes).toHaveLength(1);
    expect(ctx.flushes[0]!.reason).toBe('saturated');
    expect(ctx.flushes[0]!.items).toHaveLength(4);
    expect(ctx.batcher.depth).toBe(0);
  });

  it('respects the token ceiling independently of the size ceiling', () => {
    const local = makeBatcher({ maxBatchSize: 100, maxBatchTokens: 250 });
    for (let i = 0; i < 3; i++) local.batcher.enqueue(item(`r${i}`, { tokens: 100 }));
    expect(local.flushes).toHaveLength(1);
    // Only two 100-token items fit under a 250-token ceiling.
    expect(local.flushes[0]!.items).toHaveLength(2);
    expect(local.flushes[0]!.totalTokens).toBe(200);
    expect(local.batcher.depth).toBe(1);
  });

  it('waits up to the linger ceiling when deadlines are generous', () => {
    ctx.batcher.enqueue(item('r0', { deadlineIn: 10_000 }));
    ctx.clock.advance(19);
    expect(ctx.flushes).toHaveLength(0);
    ctx.clock.advance(1);
    expect(ctx.flushes).toHaveLength(1);
    expect(ctx.flushes[0]!.reason).toBe('linger');
  });

  it('flushes early — below the linger ceiling — when a tight deadline demands it', () => {
    // Slack is deadline(15) - cost(8.5) - safety(2) = 4.5ms, well under the 20ms linger.
    ctx.batcher.enqueue(item('urgent', { deadlineIn: 15 }));
    ctx.clock.advance(4);
    expect(ctx.flushes).toHaveLength(0);
    ctx.clock.advance(1);
    expect(ctx.flushes).toHaveLength(1);
    expect(ctx.flushes[0]!.reason).toBe('deadline');
    expect(ctx.flushes[0]!.items).toHaveLength(1);
  });

  it('sheds a request whose deadline is unreachable even on an idle system', () => {
    const result = ctx.batcher.enqueue(item('doomed', { deadlineIn: soloCost(10) - 1 }));
    expect(result).toEqual({ accepted: false, reason: 'deadline_unreachable', queueDepth: 0 });
    expect(ctx.batcher.depth).toBe(0);
  });

  it('applies backpressure once the queue is full', () => {
    const local = makeBatcher({ maxBatchSize: 100, maxQueueDepth: 3, lingerMs: 10_000 });
    for (let i = 0; i < 3; i++) {
      expect(local.batcher.enqueue(item(`r${i}`, { deadlineIn: 100_000 })).accepted).toBe(true);
    }
    const rejected = local.batcher.enqueue(item('overflow', { deadlineIn: 100_000 }));
    expect(rejected).toEqual({ accepted: false, reason: 'queue_full', queueDepth: 3 });
  });

  it('orders a batch earliest-deadline-first regardless of arrival order', () => {
    ctx.batcher.enqueue(item('late', { deadlineIn: 900 }));
    ctx.batcher.enqueue(item('early', { deadlineIn: 300 }));
    ctx.batcher.enqueue(item('middle', { deadlineIn: 600 }));
    ctx.batcher.drain();
    expect(ctx.flushes[0]!.items.map((i) => i.id)).toEqual(['early', 'middle', 'late']);
  });

  it('serves interactive work ahead of bulk work', () => {
    const local = makeBatcher({ maxBatchSize: 2, lingerMs: 5_000 });
    local.batcher.enqueue(item('bulk', { lane: Lane.Bulk, deadlineIn: 10_000 }));
    local.batcher.enqueue(item('interactive', { deadlineIn: 10_000 }));
    expect(local.flushes[0]!.items.map((i) => i.id)).toEqual(['interactive', 'bulk']);
  });

  it('promotes bulk work that has waited past the starvation guard', () => {
    const local = makeBatcher({ maxBatchSize: 2, lingerMs: 5_000, starvationGuardMs: 50 });
    local.batcher.enqueue(item('bulk', { lane: Lane.Bulk, deadlineIn: 10_000 }));
    local.clock.advance(60);
    local.batcher.enqueue(item('interactive', { at: T0 + 60, deadlineIn: 10_000 }));
    expect(local.flushes[0]!.items.map((i) => i.id)).toEqual(['bulk', 'interactive']);
  });

  it('chunks an oversized queue into max-size batches on drain', () => {
    const local = makeBatcher({ maxBatchSize: 2, maxQueueDepth: 16, lingerMs: 10_000 });
    for (let i = 0; i < 5; i++) local.batcher.enqueue(item(`r${i}`, { deadlineIn: 100_000 }));
    local.batcher.drain();
    const total = local.flushes.reduce((n, f) => n + f.items.length, 0);
    expect(total).toBe(5);
    expect(local.flushes.every((f) => f.items.length <= 2)).toBe(true);
    expect(local.batcher.depth).toBe(0);
  });

  it('cancels its timer once the queue empties, leaving nothing pending', () => {
    ctx.batcher.enqueue(item('r0', { deadlineIn: 10_000 }));
    expect(ctx.clock.pendingTimers).toBe(1);
    ctx.batcher.drain();
    expect(ctx.clock.pendingTimers).toBe(0);
  });

  it('rejects everything after close', () => {
    ctx.batcher.close();
    expect(ctx.batcher.enqueue(item('r0')).accepted).toBe(false);
  });

  it('adapts batching behaviour as the cost model learns the device is slow', () => {
    const costModel = new BatchCostModel();
    const local = makeBatcher({ costModel, lingerMs: 10_000 });
    // Teach the model that this device has a 200ms fixed cost.
    for (let i = 0; i < 20; i++) costModel.observe(10 * (i % 5), 200 + 0.5 * 10 * (i % 5));

    expect(costModel.predict(10)).toBeGreaterThan(150);
    // A 100ms deadline that looked comfortable under the prior is now provably unreachable.
    const result = local.batcher.enqueue(item('r0', { deadlineIn: 100 }));
    expect(result.accepted).toBe(false);
    expect(result.accepted === false && result.reason).toBe('deadline_unreachable');
  });

  it('reports coherent telemetry', () => {
    for (let i = 0; i < 4; i++) ctx.batcher.enqueue(item(`r${i}`));
    const snap = ctx.batcher.snapshot();
    expect(snap.batchesFlushed).toBe(1);
    expect(snap.itemsFlushed).toBe(4);
    expect(snap.meanBatchSize).toBe(4);
    expect(snap.flushReasons.saturated).toBe(1);
    expect(snap.queueDepth).toBe(0);
    expect(snap.queuedTokens).toBe(0);
  });

  it('never arms a sub-millisecond timer, however tight the remaining slack', () => {
    // Slack here is deadline(11) - cost(8.5) - safety(2) = 0.5ms: positive, but far too
    // small to schedule. Without the quantum floor the scheduler would arm a 0.5ms timer,
    // wake, recompute an equally tiny slack and re-arm forever — a busy-spin that appears
    // only near saturation, which is the worst possible time to burn the event loop.
    const local = makeBatcher({ lingerMs: 10_000 });
    local.batcher.enqueue(item('tight', { deadlineIn: 11 }));
    expect(local.flushes).toHaveLength(1);
    expect(local.flushes[0]!.reason).toBe('deadline');
    expect(local.clock.pendingTimers).toBe(0);
  });

  it('holds a fixed number of timers under sustained saturating load', () => {
    const local = makeBatcher({ maxBatchSize: 8, lingerMs: 25, maxQueueDepth: 4_096 });
    // Deadlines chosen to sit just above the solo cost, so slack is always small-positive.
    for (let tick = 0; tick < 500; tick++) {
      local.batcher.enqueue(item(`r${tick}`, { at: T0 + tick, deadlineIn: 12, tokens: 20 }));
      local.clock.advance(1);
      expect(local.clock.pendingTimers).toBeLessThanOrEqual(1);
    }
    expect(local.flushes.length).toBeGreaterThan(0);
  });

  it('holds the batch while downstream is busy, and dispatches the moment it frees up', () => {
    let deviceBusy = true;
    const local = makeBatcher({ canFlush: () => !deviceBusy, lingerMs: 5 });
    local.batcher.enqueue(item('r0', { deadlineIn: 10_000 }));
    local.clock.advance(50);
    expect(local.flushes).toHaveLength(0);

    deviceBusy = false;
    local.batcher.signalCapacity();
    expect(local.flushes).toHaveLength(1);
  });

  it('expires a queued item whose deadline passes while downstream is unavailable', () => {
    // Without expiry, a queue with no downstream capacity holds its contents forever and the
    // caller waits on an answer that can no longer be useful.
    const expired: string[] = [];
    const local = makeBatcher({
      canFlush: () => false,
      lingerMs: 10_000,
      onExpire: (item) => expired.push(item.id),
    });
    local.batcher.enqueue(item('doomed', { deadlineIn: 100 }));
    expect(local.batcher.depth).toBe(1);

    local.clock.advance(150);
    expect(expired).toEqual(['doomed']);
    expect(local.batcher.depth).toBe(0);
    expect(local.flushes).toHaveLength(0);
    expect(local.batcher.snapshot().itemsExpired).toBe(1);
  });

  it('expires only the overdue prefix, leaving live work queued', () => {
    const expired: string[] = [];
    const local = makeBatcher({
      canFlush: () => false,
      lingerMs: 10_000,
      onExpire: (item) => expired.push(item.id),
    });
    local.batcher.enqueue(item('soon', { deadlineIn: 100 }));
    local.batcher.enqueue(item('later', { deadlineIn: 5_000 }));

    local.clock.advance(150);
    expect(expired).toEqual(['soon']);
    expect(local.batcher.depth).toBe(1);
  });

  it('stops polling once an emptied queue has nothing left to wait for', () => {
    const local = makeBatcher({ canFlush: () => false, lingerMs: 10_000, onExpire: () => {} });
    local.batcher.enqueue(item('doomed', { deadlineIn: 100 }));
    local.clock.advance(200);
    expect(local.batcher.depth).toBe(0);
    expect(local.clock.pendingTimers).toBe(0);
  });

  it('counts work already dispatched when judging feasibility', () => {
    let inFlightMs = 0;
    const local = makeBatcher({ pendingWorkMs: () => inFlightMs, lingerMs: 10_000 });

    // 60ms deadline, 8.5ms solo cost, 2ms margin — comfortably feasible on an idle device.
    expect(local.batcher.enqueue(item('idle-ok', { deadlineIn: 60 })).accepted).toBe(true);

    // The same request is infeasible when the accelerator is already 100ms deep in a batch.
    inFlightMs = 100;
    const result = local.batcher.enqueue(item('busy-no', { deadlineIn: 60 }));
    expect(result.accepted).toBe(false);
    expect(result.accepted === false && result.reason).toBe('deadline_unreachable');
  });

  it('sheds against queued work ahead of it, not just its own cost', () => {
    // The gate stays shut so work accumulates instead of draining, and the queue ceiling is
    // set far above what we enqueue — so any rejection must come from the deadline test
    // rather than from running out of queue slots.
    const local = makeBatcher({
      maxBatchSize: 64,
      maxBatchTokens: 100_000,
      maxQueueDepth: 4_096,
      lingerMs: 10_000,
      canFlush: () => false,
    });

    let accepted = 0;
    let rejectionReason: string | null = null;
    for (let i = 0; i < 600; i++) {
      const result = local.batcher.enqueue(item(`q${i}`, { tokens: 500, deadlineIn: 5_000 }));
      if (result.accepted) {
        accepted += 1;
        continue;
      }
      rejectionReason = result.reason;
      break;
    }

    // Every request here shares a 5s deadline, so under EDF each new arrival queues behind
    // all of its predecessors. There is a depth past which the next one provably cannot be
    // served in time, and the scheduler must find it rather than accepting work blindly.
    expect(rejectionReason).toBe('deadline_unreachable');
    expect(accepted).toBeGreaterThan(20);
    expect(accepted).toBeLessThan(600);
    expect(local.batcher.depth).toBe(accepted);
  });

  it('rejects nonsensical configuration at construction time', () => {
    expect(() => makeBatcher({ maxBatchSize: 0 })).toThrow(RangeError);
    expect(() => makeBatcher({ maxBatchTokens: 0 })).toThrow(RangeError);
    expect(() => makeBatcher({ maxQueueDepth: 0 })).toThrow(RangeError);
  });
});

describe('BatchCostModel', () => {
  it('recovers the parameters of a known affine cost function', () => {
    const model = new BatchCostModel();
    // Ground truth: 25ms fixed + 0.4ms per token.
    for (let i = 0; i < 200; i++) {
      const tokens = 50 + ((i * 37) % 500);
      model.observe(tokens, 25 + 0.4 * tokens);
    }
    expect(model.isFitted).toBe(true);
    expect(model.slope).toBeCloseTo(0.4, 2);
    expect(model.intercept).toBeCloseTo(25, 0);
    expect(model.predict(100)).toBeCloseTo(65, 0);
  });

  it('stays on the prior while the fit would be ill-conditioned', () => {
    const model = new BatchCostModel(8, 0.05);
    model.observe(100, 500);
    expect(model.isFitted).toBe(false);
    expect(model.predict(100)).toBe(8 + 0.05 * 100);
  });

  it('forgets old behaviour after the device characteristics change', () => {
    const model = new BatchCostModel(8, 0.05, 0.9);
    for (let i = 0; i < 100; i++) model.observe(100 + (i % 50), 10 + 0.1 * (100 + (i % 50)));
    const before = model.predict(100);
    // The device is swapped for one that is five times slower.
    for (let i = 0; i < 100; i++) model.observe(100 + (i % 50), 50 + 0.5 * (100 + (i % 50)));
    expect(model.predict(100)).toBeGreaterThan(before * 2);
  });

  it('does not inflate the intercept when the fitted slope is negative', () => {
    // Regression test for a bug that shed thousands of servable requests in a live run.
    //
    // Noisy data can easily produce a *negative* fitted slope. Because the parameters are
    // coupled through `intercept = mean(y) - slope*mean(x)`, that pushes the intercept up
    // by |slope|*mean(x) — with batches of ~200 tokens, into the seconds. Clamping the
    // slope to zero afterwards leaves the inflated intercept behind, and the scheduler then
    // believes every deadline is unreachable and rejects all traffic.
    const model = new BatchCostModel();
    // Larger batches finishing *faster* — physically impossible, but a real measurement
    // artefact when a fast replica happens to receive the big batches.
    const samples: [number, number][] = [
      [100, 90],
      [200, 70],
      [300, 50],
      [400, 30],
      [500, 25],
      [600, 20],
    ];
    for (const [tokens, duration] of samples) model.observe(tokens, duration);

    expect(model.slope).toBeGreaterThanOrEqual(0);
    expect(model.intercept).toBeGreaterThanOrEqual(0);
    // The prediction must stay in the neighbourhood of the observations it was fitted on,
    // not orders of magnitude above them.
    const observedMax = Math.max(...samples.map(([, d]) => d));
    expect(model.predict(300)).toBeLessThanOrEqual(observedMax * 2);
  });

  it('stays on the prior when every batch has been the same size', () => {
    // With no spread in x the normal equations are ill-conditioned; any slope fitted through
    // a single cluster extrapolates wildly outside it.
    const model = new BatchCostModel(8, 0.05);
    for (let i = 0; i < 50; i++) model.observe(256, 40 + (i % 3));
    expect(model.predict(256)).toBeLessThan(200);
    expect(model.predict(4_096)).toBeLessThan(1_000);
  });

  it('never predicts a negative duration', () => {
    const model = new BatchCostModel();
    for (let i = 0; i < 50; i++) model.observe(1_000 - i * 10, i);
    expect(model.predict(0)).toBeGreaterThanOrEqual(0);
    expect(model.predict(10_000)).toBeGreaterThanOrEqual(0);
  });

  it('rejects an out-of-range forgetting factor', () => {
    expect(() => new BatchCostModel(8, 0.05, 0)).toThrow(RangeError);
    expect(() => new BatchCostModel(8, 0.05, 1.5)).toThrow(RangeError);
  });
});
