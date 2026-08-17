import { MetricsRegistry } from '@halcyon/telemetry';

/**
 * Metric definitions live in one place so names and label cardinality are reviewable.
 *
 * Cardinality is the thing to guard: a label whose values are unbounded — a request id, a
 * prompt, a user id — multiplies into a separate time series per value and will take down
 * the metrics backend long before it takes down the gateway. Every label here has a small,
 * bounded domain: model, version, outcome, lane.
 */
export function buildMetrics() {
  const registry = new MetricsRegistry();

  return {
    registry,
    requests: registry.counter(
      'halcyon_requests_total',
      'Inference requests by model, version and outcome.',
    ),
    latency: registry.histogram(
      'halcyon_request_duration_ms',
      'End-to-end request latency in milliseconds.',
      [5, 10, 25, 50, 100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800],
    ),
    queueWait: registry.histogram(
      'halcyon_queue_wait_ms',
      'Time a request spent waiting to be batched.',
      [1, 2, 5, 10, 20, 40, 80, 160, 320, 640],
    ),
    execution: registry.histogram(
      'halcyon_execution_duration_ms',
      'Time a batch spent executing on a replica.',
      [10, 25, 50, 100, 200, 400, 800, 1_600, 3_200, 6_400],
    ),
    batchSize: registry.histogram(
      'halcyon_batch_size',
      'Requests per dispatched batch.',
      [1, 2, 4, 8, 16, 32, 64, 128],
    ),
    tokens: registry.counter('halcyon_tokens_total', 'Tokens processed by kind.'),
    costInr: registry.counter(
      'halcyon_cost_micros_inr_total',
      'Attributed cost in micro-rupees, by tenant and model.',
    ),
    hedges: registry.counter('halcyon_hedged_requests_total', 'Hedge requests dispatched.'),
    hedgeWins: registry.counter(
      'halcyon_hedge_wins_total',
      'Hedges that returned before the original dispatch.',
    ),
    queueDepth: registry.gauge('halcyon_queue_depth', 'Requests currently queued for batching.'),
    concurrencyLimit: registry.gauge(
      'halcyon_concurrency_limit',
      'Current adaptive concurrency limit.',
    ),
    inflight: registry.gauge('halcyon_inflight_requests', 'Requests currently in flight.'),
    replicas: registry.gauge('halcyon_replicas', 'Registered replicas by state.'),
    canaryPercent: registry.gauge(
      'halcyon_canary_percent',
      'Share of traffic on the canary version, per model.',
    ),
    rolloutEvents: registry.counter(
      'halcyon_rollout_events_total',
      'Canary decisions by model and verdict.',
    ),
  };
}

export type Metrics = ReturnType<typeof buildMetrics>;
