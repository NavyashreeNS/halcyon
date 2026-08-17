import type { Clock } from '../clock.js';
import { Ewma } from '../stats/ewma.js';
import { LatencyHistogram } from '../stats/histogram.js';
import {
  BreakerState,
  CircuitBreaker,
  type BreakerSnapshot,
  type CircuitBreakerOptions,
} from './circuit-breaker.js';

export interface ReplicaSpec {
  readonly id: string;
  readonly modelId: string;
  readonly version: string;
  readonly address: string;
  /** Relative capacity. An H100 replica carries more weight than an A10G one. */
  readonly weight: number;
}

interface ReplicaState {
  readonly spec: ReplicaSpec;
  inflight: number;
  latency: Ewma;
  histogram: LatencyHistogram;
  breaker: CircuitBreaker;
  draining: boolean;
  lastSeen: number;
  totalDispatched: number;
  totalFailed: number;
}

export interface RouterOptions {
  clock: Clock;
  /** Time constant for the latency EWMA. */
  latencyTauMs?: number;
  /** Replicas silently missing for longer than this are treated as gone. */
  heartbeatTimeoutMs?: number;
  breaker?: Partial<CircuitBreakerOptions>;
  /**
   * Hard ceiling on concurrent dispatches to a single replica.
   *
   * Scoring alone is not enough here. Peak-EWMA makes a busy replica *less attractive*, but
   * a replica that physically accepts one batch at a time needs it to be *ineligible* —
   * otherwise a straggler whose latency is high enough can still win the comparison while
   * already occupied, and the dispatch is rejected on arrival. Defaults to unlimited, since
   * most runtimes do overlap requests.
   */
  maxInflightPerReplica?: number;
  /** Deterministic source of randomness for the two-choices sample; injectable for tests. */
  random?: () => number;
}

export type PickResult =
  { ok: true; replica: ReplicaSpec } | { ok: false; reason: 'no_replicas' | 'all_unavailable' };

/**
 * Load-aware replica router.
 *
 * Round-robin assumes every replica is identical and every request costs the same. Neither
 * holds for GPU inference: replicas differ in hardware generation and in what is resident
 * in their KV cache, and request cost varies by an order of magnitude. Least-connections is
 * better but blind to the fact that one replica's connections may each be ten times more
 * expensive.
 *
 * Halcyon uses **peak-EWMA scoring under power-of-two-choices**. The score
 *
 *     score = (inflight + 1) × ewmaLatency / weight
 *
 * is a direct estimate of the queueing delay a new request would experience — Little's Law
 * applied per replica. Sampling only two candidates at random and taking the better one
 * (rather than globally minimising) is what keeps the balance stable: a globally-optimal
 * choice made independently by every gateway instance causes them all to stampede the same
 * "best" replica, and the herd oscillates. Two random choices provably reduces maximum load
 * from Θ(log n / log log n) to Θ(log log n) while being immune to that resonance.
 *
 * `+1` in the numerator is what makes an idle replica with unknown latency attractive
 * without being infinitely attractive, so new replicas warm up instead of being flooded.
 */
export class Router {
  private readonly replicas = new Map<string, ReplicaState>();
  private readonly byModel = new Map<string, Set<string>>();
  private readonly clock: Clock;
  private readonly latencyTauMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly breakerOptions: Partial<CircuitBreakerOptions>;
  private readonly maxInflightPerReplica: number;
  private readonly random: () => number;

  constructor(options: RouterOptions) {
    this.clock = options.clock;
    this.latencyTauMs = options.latencyTauMs ?? 10_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
    this.breakerOptions = options.breaker ?? {};
    this.maxInflightPerReplica = options.maxInflightPerReplica ?? Number.POSITIVE_INFINITY;
    this.random = options.random ?? Math.random;
  }

  register(spec: ReplicaSpec): void {
    const now = this.clock.now();
    const existing = this.replicas.get(spec.id);
    if (existing) {
      existing.lastSeen = now;
      existing.draining = false;
      return;
    }
    this.replicas.set(spec.id, {
      spec,
      inflight: 0,
      latency: new Ewma(this.latencyTauMs),
      histogram: new LatencyHistogram(8, 120_000),
      breaker: new CircuitBreaker(this.breakerOptions),
      draining: false,
      lastSeen: now,
      totalDispatched: 0,
      totalFailed: 0,
    });
    const key = modelKey(spec.modelId, spec.version);
    let set = this.byModel.get(key);
    if (!set) {
      set = new Set();
      this.byModel.set(key, set);
    }
    set.add(spec.id);
  }

  heartbeat(replicaId: string): void {
    const state = this.replicas.get(replicaId);
    if (state) state.lastSeen = this.clock.now();
  }

  /** Marks a replica as draining: it finishes in-flight work but receives no new requests. */
  drain(replicaId: string): void {
    const state = this.replicas.get(replicaId);
    if (state) state.draining = true;
  }

  deregister(replicaId: string): void {
    const state = this.replicas.get(replicaId);
    if (!state) return;
    this.replicas.delete(replicaId);
    this.byModel.get(modelKey(state.spec.modelId, state.spec.version))?.delete(replicaId);
  }

  /**
   * Selects a replica for `modelId@version`.
   *
   * @param exclude Replica already handling this request — set when picking a hedge target
   *   so the backup lands somewhere else. A hedge to the same replica is worthless.
   */
  pick(modelId: string, version: string, exclude?: string): PickResult {
    const now = this.clock.now();
    const ids = this.byModel.get(modelKey(modelId, version));
    if (!ids || ids.size === 0) return { ok: false, reason: 'no_replicas' };

    // Eligibility is decided with the *non-mutating* `peek`. Reserving a half-open probe
    // slot for a replica we then decline to use would leak that slot permanently, since
    // only a completed dispatch releases it.
    const eligible: ReplicaState[] = [];
    for (const id of ids) {
      if (id === exclude) continue;
      const state = this.replicas.get(id);
      if (!state) continue;
      if (state.draining) continue;
      if (state.inflight >= this.maxInflightPerReplica) continue;
      if (now - state.lastSeen > this.heartbeatTimeoutMs) continue;
      if (state.breaker.peek(now) === BreakerState.Open) continue;
      eligible.push(state);
    }

    // Only the winner acquires. If its breaker refuses (half-open probe budget exhausted),
    // drop it and re-run the selection over what remains.
    const pool = eligible.slice();
    while (pool.length > 0) {
      const chosen = this.twoChoices(pool, now);
      if (chosen.breaker.tryAcquire(now)) {
        return { ok: true, replica: chosen.spec };
      }
      const idx = pool.indexOf(chosen);
      if (idx >= 0) pool.splice(idx, 1);
    }
    return { ok: false, reason: 'all_unavailable' };
  }

  private twoChoices(candidates: ReplicaState[], now: number): ReplicaState {
    const first = candidates[Math.floor(this.random() * candidates.length)] ?? candidates[0]!;
    if (candidates.length === 1) return first;
    let second = candidates[Math.floor(this.random() * candidates.length)] ?? candidates[0]!;
    // Resample once if we drew the same replica twice; one retry keeps this O(1).
    if (second === first) {
      const idx = (candidates.indexOf(first) + 1) % candidates.length;
      second = candidates[idx] ?? first;
    }
    return this.score(first, now) <= this.score(second, now) ? first : second;
  }

  /** Estimated queueing delay for a new request. Lower is better. */
  private score(state: ReplicaState, now: number): number {
    // A replica with no samples yet is optimistically assumed to be as fast as the fleet's
    // median rather than infinitely fast, so cold replicas warm up gradually.
    const latency = state.latency.hasSamples
      ? state.latency.get(now)
      : this.fleetMedianLatency(now);
    const weight = state.spec.weight > 0 ? state.spec.weight : 1;
    return ((state.inflight + 1) * Math.max(latency, 1e-3)) / weight;
  }

  private fleetMedianLatency(now: number): number {
    const samples: number[] = [];
    for (const state of this.replicas.values()) {
      if (state.latency.hasSamples) samples.push(state.latency.get(now));
    }
    if (samples.length === 0) return 50; // Neutral prior on a completely cold fleet.
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)] ?? 50;
  }

  /** Call immediately before dispatching to `replicaId`. */
  dispatchStarted(replicaId: string): void {
    const state = this.replicas.get(replicaId);
    if (!state) return;
    state.inflight++;
    state.totalDispatched++;
  }

  /** Call when a dispatch settles, successfully or not. */
  dispatchCompleted(replicaId: string, latencyMs: number, ok: boolean): void {
    const state = this.replicas.get(replicaId);
    if (!state) return;
    const now = this.clock.now();
    state.inflight = Math.max(0, state.inflight - 1);
    state.lastSeen = now;
    if (ok) {
      state.latency.observe(latencyMs, now);
      state.histogram.record(latencyMs);
      state.breaker.onSuccess(now);
    } else {
      state.totalFailed++;
      state.breaker.onFailure(now);
    }
  }

  /**
   * How long to wait before firing a hedge request, as the p95 of observed latency for this
   * model. Hedging at p95 bounds the extra load at ~5% while cutting the tail dramatically:
   * the backup only ever races a request that is already known to be behaving abnormally.
   * Returns `null` when there is not enough data to hedge responsibly.
   */
  hedgeDelayMs(modelId: string, version: string, minimumSamples = 50): number | null {
    const ids = this.byModel.get(modelKey(modelId, version));
    if (!ids) return null;
    const merged = new LatencyHistogram(8, 120_000);
    for (const id of ids) {
      const state = this.replicas.get(id);
      if (state) merged.merge(state.histogram);
    }
    if (merged.count < minimumSamples) return null;
    return Math.max(1, merged.p95);
  }

  /** Removes replicas whose heartbeats have lapsed. Returns the ids evicted. */
  reapStale(): string[] {
    const now = this.clock.now();
    const evicted: string[] = [];
    for (const [id, state] of this.replicas) {
      if (now - state.lastSeen > this.heartbeatTimeoutMs * 2) {
        evicted.push(id);
      }
    }
    for (const id of evicted) this.deregister(id);
    return evicted;
  }

  get size(): number {
    return this.replicas.size;
  }

  snapshot(): ReplicaSnapshot[] {
    const now = this.clock.now();
    return [...this.replicas.values()].map((state) => ({
      id: state.spec.id,
      modelId: state.spec.modelId,
      version: state.spec.version,
      address: state.spec.address,
      weight: state.spec.weight,
      inflight: state.inflight,
      draining: state.draining,
      score: Number(this.score(state, now).toFixed(4)),
      ewmaLatencyMs: Number(state.latency.get(now).toFixed(2)),
      latency: state.histogram.snapshot(),
      breaker: state.breaker.snapshot(now),
      totalDispatched: state.totalDispatched,
      totalFailed: state.totalFailed,
      staleForMs: Math.max(0, Math.round(now - state.lastSeen)),
    }));
  }
}

export interface ReplicaSnapshot {
  id: string;
  modelId: string;
  version: string;
  address: string;
  weight: number;
  inflight: number;
  draining: boolean;
  score: number;
  ewmaLatencyMs: number;
  latency: ReturnType<LatencyHistogram['snapshot']>;
  breaker: BreakerSnapshot;
  totalDispatched: number;
  totalFailed: number;
  staleForMs: number;
}

const modelKey = (modelId: string, version: string): string => `${modelId}@${version}`;
