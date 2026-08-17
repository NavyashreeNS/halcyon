import { z } from 'zod';

/**
 * Configuration is parsed once, at boot, and the process refuses to start if anything is
 * wrong. The alternative — reading `process.env` at the point of use — turns a typo in a
 * deployment manifest into a runtime failure that surfaces on the thousandth request, in
 * production, at the worst possible moment.
 */
const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65_535).default(8080),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- Batching -------------------------------------------------------------------------
  maxBatchSize: z.coerce.number().int().min(1).max(512).default(32),
  maxBatchTokens: z.coerce.number().int().min(1).default(16_384),
  maxQueueDepth: z.coerce.number().int().min(1).default(512),
  /** Upper bound on how long the scheduler will deliberately wait to grow a batch. */
  lingerMs: z.coerce.number().min(0).default(20),
  /** Headroom for dispatch, network and deserialisation on top of predicted compute. */
  safetyMarginMs: z.coerce.number().min(0).default(15),
  starvationGuardMs: z.coerce.number().min(0).default(2_000),

  // --- Admission ------------------------------------------------------------------------
  initialConcurrencyLimit: z.coerce.number().int().min(1).default(64),
  minConcurrencyLimit: z.coerce.number().int().min(1).default(8),
  maxConcurrencyLimit: z.coerce.number().int().min(1).default(4_096),
  /**
   * Quota applied to tenants with no explicit entry. Set deliberately generous: the default
   * should let the *scheduler* be the binding constraint, so that overload behaviour is
   * governed by measured capacity rather than by an arbitrary number in a config file.
   * Real tenants get real quotas from the database.
   */
  defaultTenantBurst: z.coerce.number().min(1).default(2_000),
  defaultTenantRate: z.coerce.number().min(0.1).default(1_000),
  defaultTenantPriority: z.coerce.number().min(0).max(1).default(1),

  // --- Routing --------------------------------------------------------------------------
  heartbeatTimeoutMs: z.coerce.number().int().min(1_000).default(15_000),
  /** Set false to disable hedging entirely; useful when replicas are not idempotent. */
  hedgingEnabled: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  hedgeMinimumSamples: z.coerce.number().int().min(1).default(50),
  upstreamTimeoutMs: z.coerce.number().int().min(100).default(30_000),
  /**
   * Concurrent batches allowed per replica before the scheduler stops dispatching.
   *
   * Defaults to 1 because an accelerator executes one batch at a time — dispatching a
   * second merely moves the queue inside the worker, where the scheduler cannot see it and
   * its latency predictions quietly become fiction. Raise this only for runtimes that
   * genuinely overlap execution (e.g. separate CUDA streams with reserved memory).
   */
  maxInFlightBatchesPerReplica: z.coerce.number().int().min(1).default(1),

  // --- Rollout --------------------------------------------------------------------------
  canaryAnalysisIntervalMs: z.coerce.number().int().min(1_000).default(30_000),

  // --- Telemetry ------------------------------------------------------------------------
  otlpEndpoint: z.string().url().optional(),
  traceSampleRatio: z.coerce.number().min(0).max(1).default(1),

  /** Cost model for tenant billing, in micro-rupees per 1,000 tokens. */
  costMicrosInrPerKiloToken: z.coerce.number().int().min(0).default(1_800),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    nodeEnv: env['NODE_ENV'],
    host: env['HOST'],
    port: env['PORT'],
    logLevel: env['LOG_LEVEL'],
    maxBatchSize: env['MAX_BATCH_SIZE'],
    maxBatchTokens: env['MAX_BATCH_TOKENS'],
    maxQueueDepth: env['MAX_QUEUE_DEPTH'],
    lingerMs: env['LINGER_MS'],
    safetyMarginMs: env['SAFETY_MARGIN_MS'],
    starvationGuardMs: env['STARVATION_GUARD_MS'],
    initialConcurrencyLimit: env['INITIAL_CONCURRENCY_LIMIT'],
    minConcurrencyLimit: env['MIN_CONCURRENCY_LIMIT'],
    maxConcurrencyLimit: env['MAX_CONCURRENCY_LIMIT'],
    defaultTenantBurst: env['DEFAULT_TENANT_BURST'],
    defaultTenantRate: env['DEFAULT_TENANT_RATE'],
    defaultTenantPriority: env['DEFAULT_TENANT_PRIORITY'],
    heartbeatTimeoutMs: env['HEARTBEAT_TIMEOUT_MS'],
    hedgingEnabled: env['HEDGING_ENABLED'],
    hedgeMinimumSamples: env['HEDGE_MINIMUM_SAMPLES'],
    upstreamTimeoutMs: env['UPSTREAM_TIMEOUT_MS'],
    maxInFlightBatchesPerReplica: env['MAX_INFLIGHT_BATCHES_PER_REPLICA'],
    canaryAnalysisIntervalMs: env['CANARY_ANALYSIS_INTERVAL_MS'],
    otlpEndpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT'],
    traceSampleRatio: env['TRACE_SAMPLE_RATIO'],
    costMicrosInrPerKiloToken: env['COST_MICROS_INR_PER_KILO_TOKEN'],
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid gateway configuration:\n${issues}`);
  }

  const config = parsed.data;
  if (config.minConcurrencyLimit > config.maxConcurrencyLimit) {
    throw new Error('MIN_CONCURRENCY_LIMIT must not exceed MAX_CONCURRENCY_LIMIT');
  }
  return config;
}
