import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { BreakerState, CircuitBreaker } from '../src/routing/circuit-breaker.js';
import { Router, type ReplicaSpec } from '../src/routing/router.js';

const replica = (id: string, weight = 1): ReplicaSpec => ({
  id,
  modelId: 'llama-3-8b',
  version: 'v1',
  address: `http://${id}:9000`,
  weight,
});

/**
 * Deterministic router: `random()` always returns 0, so the two-choices sample is always
 * (candidate[0], candidate[1]) and every assertion below is about *scoring*, not luck.
 */
function makeRouter(clock = new ManualClock(1_000)) {
  return {
    clock,
    router: new Router({ clock, random: () => 0, heartbeatTimeoutMs: 15_000 }),
  };
}

describe('CircuitBreaker', () => {
  it('stays closed below the minimum observation volume, however bad the ratio', () => {
    const b = new CircuitBreaker({ minimumVolume: 10, failureThreshold: 0.5, windowSize: 50 });
    for (let i = 0; i < 9; i++) b.onFailure(0);
    expect(b.peek(0)).toBe(BreakerState.Closed);
  });

  it('trips once the failure ratio crosses the threshold with enough volume', () => {
    const b = new CircuitBreaker({ minimumVolume: 10, failureThreshold: 0.5, windowSize: 50 });
    for (let i = 0; i < 10; i++) b.onFailure(0);
    expect(b.peek(0)).toBe(BreakerState.Open);
    expect(b.tryAcquire(0)).toBe(false);
  });

  it('admits a limited number of probes after the open duration elapses', () => {
    const b = new CircuitBreaker({
      minimumVolume: 4,
      failureThreshold: 0.5,
      openDurationMs: 1_000,
      halfOpenMaxProbes: 2,
    });
    for (let i = 0; i < 4; i++) b.onFailure(0);
    expect(b.tryAcquire(999)).toBe(false);
    expect(b.tryAcquire(1_000)).toBe(true);
    expect(b.tryAcquire(1_000)).toBe(true);
    // Probe budget exhausted.
    expect(b.tryAcquire(1_000)).toBe(false);
  });

  it('closes after enough consecutive probe successes', () => {
    const b = new CircuitBreaker({
      minimumVolume: 4,
      failureThreshold: 0.5,
      openDurationMs: 1_000,
      halfOpenMaxProbes: 3,
      halfOpenSuccessesToClose: 3,
    });
    for (let i = 0; i < 4; i++) b.onFailure(0);
    for (let i = 0; i < 3; i++) {
      expect(b.tryAcquire(1_000)).toBe(true);
      b.onSuccess(1_000);
    }
    expect(b.peek(1_000)).toBe(BreakerState.Closed);
  });

  it('backs off exponentially when recovery probes keep failing', () => {
    const b = new CircuitBreaker({
      minimumVolume: 4,
      failureThreshold: 0.5,
      openDurationMs: 1_000,
      backoffMultiplier: 2,
      maxOpenDurationMs: 60_000,
    });
    for (let i = 0; i < 4; i++) b.onFailure(0);
    expect(b.snapshot(0).openDurationMs).toBe(1_000);

    b.tryAcquire(1_000);
    b.onFailure(1_000);
    expect(b.snapshot(1_000).openDurationMs).toBe(2_000);

    b.tryAcquire(3_000);
    b.onFailure(3_000);
    expect(b.snapshot(3_000).openDurationMs).toBe(4_000);
  });

  it('caps the backed-off open duration', () => {
    const b = new CircuitBreaker({
      minimumVolume: 2,
      failureThreshold: 0.5,
      openDurationMs: 1_000,
      backoffMultiplier: 10,
      maxOpenDurationMs: 5_000,
    });
    for (let i = 0; i < 2; i++) b.onFailure(0);
    let t = 1_000;
    for (let i = 0; i < 5; i++) {
      b.tryAcquire(t);
      b.onFailure(t);
      t += 10_000;
    }
    expect(b.snapshot(t).openDurationMs).toBe(5_000);
  });
});

describe('Router', () => {
  it('reports when a model has no registered replicas', () => {
    const { router } = makeRouter();
    expect(router.pick('missing', 'v1')).toEqual({ ok: false, reason: 'no_replicas' });
  });

  it('prefers the replica with the lower estimated queueing delay', () => {
    const { router } = makeRouter();
    router.register(replica('slow'));
    router.register(replica('fast'));

    router.dispatchStarted('slow');
    router.dispatchCompleted('slow', 400, true);
    router.dispatchStarted('fast');
    router.dispatchCompleted('fast', 20, true);

    const result = router.pick('llama-3-8b', 'v1');
    expect(result.ok && result.replica.id).toBe('fast');
  });

  it('accounts for in-flight load, not just latency', () => {
    const { router } = makeRouter();
    router.register(replica('a'));
    router.register(replica('b'));
    // Identical latency profiles...
    for (const id of ['a', 'b']) {
      router.dispatchStarted(id);
      router.dispatchCompleted(id, 50, true);
    }
    // ...but `a` is now saturated with in-flight work.
    for (let i = 0; i < 5; i++) router.dispatchStarted('a');

    const result = router.pick('llama-3-8b', 'v1');
    expect(result.ok && result.replica.id).toBe('b');
  });

  it('normalises by weight so a bigger accelerator absorbs more traffic', () => {
    const { router } = makeRouter();
    router.register(replica('a10g', 1));
    router.register(replica('h100', 8));
    for (const id of ['a10g', 'h100']) {
      router.dispatchStarted(id);
      router.dispatchCompleted(id, 50, true);
    }
    // Four concurrent requests on the H100 still score better than one on the A10G.
    for (let i = 0; i < 4; i++) router.dispatchStarted('h100');
    router.dispatchStarted('a10g');

    const result = router.pick('llama-3-8b', 'v1');
    expect(result.ok && result.replica.id).toBe('h100');
  });

  it('takes a replica out of rotation when its breaker opens', () => {
    const { router } = makeRouter();
    router.register(replica('sick'));
    router.register(replica('healthy'));
    for (let i = 0; i < 30; i++) {
      router.dispatchStarted('sick');
      router.dispatchCompleted('sick', 5, false);
    }
    for (let i = 0; i < 10; i++) {
      const result = router.pick('llama-3-8b', 'v1');
      expect(result.ok && result.replica.id).toBe('healthy');
    }
  });

  it('does not leak half-open probe slots to replicas it declines to use', () => {
    const clock = new ManualClock(1_000);
    const router = new Router({
      clock,
      random: () => 0,
      breaker: {
        minimumVolume: 4,
        failureThreshold: 0.5,
        openDurationMs: 100,
        halfOpenMaxProbes: 1,
      },
    });
    router.register(replica('a'));
    router.register(replica('b'));
    for (const id of ['a', 'b']) {
      for (let i = 0; i < 4; i++) {
        router.dispatchStarted(id);
        router.dispatchCompleted(id, 5, false);
      }
    }
    clock.advance(200);

    // Both breakers are half-open with a single probe each. Two picks must succeed —
    // if the eligibility scan consumed probe budget, the second would fail.
    const first = router.pick('llama-3-8b', 'v1');
    const second = router.pick('llama-3-8b', 'v1');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.ok && second.ok && first.replica.id).not.toBe(second.ok && second.replica.id);

    // Budget is now genuinely exhausted.
    expect(router.pick('llama-3-8b', 'v1').ok).toBe(false);
  });

  it('treats a replica at its concurrency ceiling as ineligible, not merely unattractive', () => {
    const clock = new ManualClock(1_000);
    const router = new Router({ clock, random: () => 0, maxInflightPerReplica: 1 });
    router.register(replica('fast'));
    router.register(replica('slow'));
    // `slow` is genuinely slower, so scoring alone would keep favouring `fast`.
    router.dispatchStarted('fast');
    router.dispatchCompleted('fast', 10, true);
    router.dispatchStarted('slow');
    router.dispatchCompleted('slow', 500, true);

    const first = router.pick('llama-3-8b', 'v1');
    expect(first.ok && first.replica.id).toBe('fast');
    router.dispatchStarted('fast');

    // `fast` is now at its ceiling. Despite scoring far better, it must not be selected —
    // a replica that accepts one batch at a time would reject the dispatch on arrival.
    const second = router.pick('llama-3-8b', 'v1');
    expect(second.ok && second.replica.id).toBe('slow');
    router.dispatchStarted('slow');

    // Both are now full.
    expect(router.pick('llama-3-8b', 'v1')).toEqual({ ok: false, reason: 'all_unavailable' });

    router.dispatchCompleted('fast', 10, true);
    expect(router.pick('llama-3-8b', 'v1').ok).toBe(true);
  });

  it('excludes the primary replica when selecting a hedge target', () => {
    const { router } = makeRouter();
    router.register(replica('a'));
    router.register(replica('b'));
    const hedge = router.pick('llama-3-8b', 'v1', 'a');
    expect(hedge.ok && hedge.replica.id).toBe('b');
  });

  it('reports all_unavailable when the only replica is excluded', () => {
    const { router } = makeRouter();
    router.register(replica('a'));
    expect(router.pick('llama-3-8b', 'v1', 'a')).toEqual({ ok: false, reason: 'all_unavailable' });
  });

  it('stops routing to a replica whose heartbeats have lapsed', () => {
    const { router, clock } = makeRouter();
    router.register(replica('a'));
    clock.advance(20_000);
    expect(router.pick('llama-3-8b', 'v1').ok).toBe(false);
    router.heartbeat('a');
    expect(router.pick('llama-3-8b', 'v1').ok).toBe(true);
  });

  it('drains a replica without dropping it', () => {
    const { router } = makeRouter();
    router.register(replica('a'));
    router.register(replica('b'));
    router.drain('a');
    for (let i = 0; i < 5; i++) {
      const result = router.pick('llama-3-8b', 'v1');
      expect(result.ok && result.replica.id).toBe('b');
    }
    expect(router.size).toBe(2);
  });

  it('reaps replicas long past their heartbeat deadline', () => {
    const { router, clock } = makeRouter();
    router.register(replica('ghost'));
    clock.advance(40_000);
    expect(router.reapStale()).toEqual(['ghost']);
    expect(router.size).toBe(0);
  });

  it('withholds a hedge delay until it has enough latency samples', () => {
    const { router } = makeRouter();
    router.register(replica('a'));
    expect(router.hedgeDelayMs('llama-3-8b', 'v1')).toBeNull();
    for (let i = 0; i < 100; i++) {
      router.dispatchStarted('a');
      router.dispatchCompleted('a', i < 95 ? 20 : 900, true);
    }
    const hedge = router.hedgeDelayMs('llama-3-8b', 'v1');
    expect(hedge).not.toBeNull();
    // p95 of that distribution sits at the boundary of the slow tail.
    expect(hedge!).toBeGreaterThan(19);
  });

  it('distributes load rather than pinning every request to one replica', () => {
    const clock = new ManualClock(1_000);
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const router = new Router({ clock, random });
    for (const id of ['a', 'b', 'c', 'd']) router.register(replica(id));

    const counts = new Map<string, number>();
    for (let i = 0; i < 4_000; i++) {
      const result = router.pick('llama-3-8b', 'v1');
      if (!result.ok) throw new Error('expected a pick');
      const id = result.replica.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      router.dispatchStarted(id);
      // Every replica is equally fast, so load should spread evenly.
      router.dispatchCompleted(id, 50, true);
    }
    expect(counts.size).toBe(4);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(4_000 / 4 / 2);
    }
  });
});
