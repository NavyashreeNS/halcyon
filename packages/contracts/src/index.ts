import { z } from 'zod';

/**
 * The contract between the gateway, the workers and the control-plane UI.
 *
 * These are Zod schemas rather than bare TypeScript types on purpose. TypeScript types
 * evaporate at runtime, and every one of these payloads crosses a process boundary — a
 * worker registering itself, a client submitting inference, a dashboard reading state.
 * At those boundaries the compiler guarantees nothing, so the schema is the guarantee, and
 * the static types are *derived* from it. One definition, enforced in both worlds.
 */

// ---------------------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------------------

export const LaneSchema = z.enum(['interactive', 'bulk']);
export type LaneName = z.infer<typeof LaneSchema>;

export const InferenceRequestSchema = z.object({
  /** Model family, e.g. `llama-3-8b`. Version is resolved by the active traffic split. */
  model: z.string().min(1).max(128),
  /** Opaque payload handed to the model runtime. */
  input: z.string().min(1).max(1_000_000),
  /**
   * Stable key used for sticky canary assignment. Supplying a session or user id keeps a
   * given user pinned to one model version for the duration of a rollout; omitting it means
   * assignment falls back to the request id and a user may cross versions between calls.
   */
  sessionKey: z.string().min(1).max(256).optional(),
  /**
   * Client-declared latency budget. The scheduler treats this as a hard constraint and will
   * refuse the request outright rather than accept work it cannot deliver in time.
   */
  deadlineMs: z.number().int().min(10).max(600_000).default(2_000),
  lane: LaneSchema.default('interactive'),
  maxOutputTokens: z.number().int().min(1).max(8_192).default(256),
});
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;

export const InferenceResponseSchema = z.object({
  requestId: z.string(),
  model: z.string(),
  version: z.string(),
  output: z.string(),
  replicaId: z.string(),
  /** True when a hedge request beat the original dispatch. */
  hedged: z.boolean(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  }),
  timings: z.object({
    queuedMs: z.number().nonnegative(),
    executionMs: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
  }),
  batch: z.object({
    size: z.number().int().positive(),
    reason: z.enum(['saturated', 'deadline', 'linger', 'drain']),
  }),
});
export type InferenceResponse = z.infer<typeof InferenceResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum([
      'quota_exceeded',
      'overloaded',
      'unknown_tenant',
      'deadline_unreachable',
      'queue_full',
      'no_capacity',
      'upstream_failure',
      'model_not_found',
      'invalid_request',
      'unauthorized',
    ]),
    message: z.string(),
    /** Present on retryable rejections; mirrors the `Retry-After` header, in milliseconds. */
    retryAfterMs: z.number().nonnegative().optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---------------------------------------------------------------------------------------
// Worker registration and execution
// ---------------------------------------------------------------------------------------

export const WorkerRegistrationSchema = z.object({
  replicaId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  address: z.string().url(),
  /** Relative capacity: an H100 replica should advertise more weight than an A10G one. */
  weight: z.number().positive().max(1_000).default(1),
  accelerator: z.string().max(64).default('cpu-sim'),
  maxBatchSize: z.number().int().positive().max(512).default(32),
  maxBatchTokens: z.number().int().positive().max(1_000_000).default(16_384),
});
export type WorkerRegistration = z.infer<typeof WorkerRegistrationSchema>;

export const BatchExecutionRequestSchema = z.object({
  batchId: z.string(),
  items: z
    .array(
      z.object({
        requestId: z.string(),
        input: z.string(),
        maxOutputTokens: z.number().int().positive(),
      }),
    )
    .min(1),
});
export type BatchExecutionRequest = z.infer<typeof BatchExecutionRequestSchema>;

export const BatchExecutionResponseSchema = z.object({
  batchId: z.string(),
  replicaId: z.string(),
  executionMs: z.number().nonnegative(),
  results: z.array(
    z.object({
      requestId: z.string(),
      output: z.string(),
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
    }),
  ),
});
export type BatchExecutionResponse = z.infer<typeof BatchExecutionResponseSchema>;

// ---------------------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------------------

export const RolloutRequestSchema = z.object({
  modelId: z.string().min(1),
  baselineVersion: z.string().min(1),
  canaryVersion: z.string().min(1),
  policy: z
    .object({
      steps: z.array(z.number().min(0).max(100)).min(1).optional(),
      healthyChecksToAdvance: z.number().int().positive().optional(),
      unhealthyChecksToRollback: z.number().int().positive().optional(),
      minimumRequests: z.number().int().nonnegative().optional(),
      latencyToleranceFactor: z.number().positive().optional(),
      errorRateToleranceFactor: z.number().positive().optional(),
      maxDurationMs: z.number().int().positive().optional(),
    })
    .optional(),
});
export type RolloutRequest = z.infer<typeof RolloutRequestSchema>;

export const TenantQuotaSchema = z.object({
  tenantId: z.string().min(1).max(128),
  burst: z.number().positive(),
  ratePerSecond: z.number().positive(),
  priority: z.number().min(0).max(1),
});
export type TenantQuotaInput = z.infer<typeof TenantQuotaSchema>;

/** Everything the dashboard needs for one render, in a single round trip. */
export const ControlPlaneStateSchema = z.object({
  generatedAt: z.number(),
  uptimeMs: z.number(),
  models: z.array(
    z.object({
      modelId: z.string(),
      versions: z.array(z.string()),
      split: z.array(z.object({ version: z.string(), weight: z.number() })),
      rollout: z
        .object({
          phase: z.enum(['idle', 'progressing', 'paused', 'promoted', 'rolled_back']),
          baselineVersion: z.string(),
          canaryVersion: z.string(),
          canaryPercent: z.number(),
          healthyStreak: z.number(),
          unhealthyStreak: z.number(),
          startedAt: z.number(),
        })
        .nullable(),
    }),
  ),
  replicas: z.array(z.record(z.string(), z.unknown())),
  batching: z.record(z.string(), z.unknown()),
  admission: z.record(z.string(), z.unknown()),
  traffic: z.object({
    requests: z.number(),
    errors: z.number(),
    shed: z.number(),
    hedged: z.number(),
    latency: z.object({
      count: z.number(),
      mean: z.number(),
      min: z.number(),
      max: z.number(),
      p50: z.number(),
      p95: z.number(),
      p99: z.number(),
    }),
  }),
});
export type ControlPlaneState = z.infer<typeof ControlPlaneStateSchema>;

/** HTTP status for each error code — kept beside the codes so the two cannot drift. */
export const ERROR_STATUS: Record<ErrorResponse['error']['code'], number> = {
  quota_exceeded: 429,
  overloaded: 503,
  unknown_tenant: 403,
  deadline_unreachable: 503,
  queue_full: 503,
  no_capacity: 503,
  upstream_failure: 502,
  model_not_found: 404,
  invalid_request: 400,
  unauthorized: 401,
};
