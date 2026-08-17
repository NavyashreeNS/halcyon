/**
 * @halcyon/core — the algorithmic heart of the control plane.
 *
 * Everything here is pure, dependency-free and clock-injectable. No I/O, no globals, no
 * `Date.now()`. That constraint is deliberate: it is what lets the entire scheduling and
 * rollout surface be tested deterministically, and what lets the same code run inside the
 * gateway process, inside a worker, or inside a simulation harness without modification.
 */

export { SystemClock, ManualClock, staticClock } from './clock.js';
export type { Clock, CancelHandle } from './clock.js';

export { Ewma } from './stats/ewma.js';
export { LatencyHistogram } from './stats/histogram.js';
export type { HistogramSnapshot } from './stats/histogram.js';

export { BatchCostModel } from './batching/cost-model.js';
export { ContinuousBatcher, Lane } from './batching/batcher.js';
export type {
  BatchItem,
  BatchFlush,
  BatcherOptions,
  BatcherSnapshot,
  EnqueueResult,
  FlushReason,
} from './batching/batcher.js';

export {
  CircuitBreaker,
  BreakerState,
  DEFAULT_BREAKER_OPTIONS,
} from './routing/circuit-breaker.js';
export type { BreakerSnapshot, CircuitBreakerOptions } from './routing/circuit-breaker.js';
export { Router } from './routing/router.js';
export type { PickResult, ReplicaSnapshot, ReplicaSpec, RouterOptions } from './routing/router.js';

export { TokenBucket } from './admission/token-bucket.js';
export { AdaptiveLimiter } from './admission/adaptive-limit.js';
export type { AdaptiveLimitOptions, AdaptiveLimitSnapshot } from './admission/adaptive-limit.js';
export { AdmissionController } from './admission/controller.js';
export type {
  AdmissionControllerOptions,
  AdmissionOutcome,
  AdmissionSnapshot,
  TenantQuota,
} from './admission/controller.js';

export { TrafficSplitter, fnv1a32, hashToUnitInterval } from './rollout/traffic-split.js';
export type { Variant } from './rollout/traffic-split.js';
export { CanaryController, RolloutPhase, DEFAULT_CANARY_POLICY } from './rollout/canary.js';
export type {
  AnalysisRecord,
  AnalysisVerdict,
  CanaryPolicy,
  RolloutState,
  VariantMetrics,
} from './rollout/canary.js';
