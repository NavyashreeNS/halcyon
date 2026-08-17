import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Control-plane schema.
 *
 * A guiding rule runs through this file: Postgres holds *configuration and history* — the
 * things that must survive a restart and be audited — while live scheduling state stays in
 * memory. Queue depth, EWMA latencies and circuit-breaker state change thousands of times
 * per second and are worthless a second later; writing them here would add a database
 * round-trip to the request path in exchange for durability nobody wants.
 */

export const rolloutPhase = pgEnum('rollout_phase', [
  'idle',
  'progressing',
  'paused',
  'promoted',
  'rolled_back',
]);

export const requestOutcome = pgEnum('request_outcome', [
  'ok',
  'shed_quota',
  'shed_overload',
  'shed_deadline',
  'upstream_error',
  'timeout',
]);

export const tenants = pgTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Burst capacity in work units — see the token bucket in `@halcyon/core`. */
    burst: doublePrecision('burst').notNull().default(100),
    ratePerSecond: doublePrecision('rate_per_second').notNull().default(10),
    /** Share of fleet capacity retained during overload, in [0, 1]. */
    priority: real('priority').notNull().default(0.5),
    apiKeyHash: text('api_key_hash').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('tenants_api_key_hash_idx').on(table.apiKeyHash)],
);

export const models = pgTable('models', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const modelVersions = pgTable(
  'model_versions',
  {
    modelId: text('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    artifactUri: text('artifact_uri').notNull(),
    /** Parameter count, quantisation, context window — whatever the runtime needs. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.modelId, table.version] })],
);

/**
 * Registered workers. This table is a *directory*, not the source of routing truth — the
 * router keeps its own live view keyed on heartbeats, because a replica that stopped
 * responding two seconds ago is still `active` here and must stop receiving traffic
 * immediately rather than at the next database write.
 */
export const replicas = pgTable(
  'replicas',
  {
    id: text('id').primaryKey(),
    modelId: text('model_id').notNull(),
    version: text('version').notNull(),
    address: text('address').notNull(),
    weight: real('weight').notNull().default(1),
    accelerator: text('accelerator').notNull().default('cpu-sim'),
    maxBatchSize: integer('max_batch_size').notNull().default(32),
    maxBatchTokens: integer('max_batch_tokens').notNull().default(16384),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('replicas_model_version_idx').on(table.modelId, table.version)],
);

export const rollouts = pgTable(
  'rollouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    baselineVersion: text('baseline_version').notNull(),
    canaryVersion: text('canary_version').notNull(),
    phase: rolloutPhase('phase').notNull().default('idle'),
    canaryPercent: real('canary_percent').notNull().default(0),
    policy: jsonb('policy').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    index('rollouts_model_idx').on(table.modelId),
    // At most one rollout per model may be in flight; a second concurrent ramp would make
    // the canary comparison meaningless, since neither arm would be a clean baseline.
    uniqueIndex('rollouts_one_active_per_model_idx')
      .on(table.modelId)
      .where(sql`phase in ('idle', 'progressing', 'paused')`),
  ],
);

/**
 * Every canary decision, with the metrics that produced it. This is the audit trail that
 * answers "why did the rollout stop at 3am" without anyone needing to reproduce it.
 */
export const rolloutAnalyses = pgTable(
  'rollout_analyses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rolloutId: uuid('rollout_id')
      .notNull()
      .references(() => rollouts.id, { onDelete: 'cascade' }),
    analysedAt: timestamp('analysed_at', { withTimezone: true }).notNull().defaultNow(),
    canaryPercent: real('canary_percent').notNull(),
    decision: text('decision').notNull(),
    reason: text('reason'),
    baselineMetrics: jsonb('baseline_metrics').$type<Record<string, number>>().notNull(),
    canaryMetrics: jsonb('canary_metrics').$type<Record<string, number>>().notNull(),
  },
  (table) => [index('rollout_analyses_rollout_idx').on(table.rolloutId, table.analysedAt)],
);

/**
 * Per-request accounting, written asynchronously off the request path.
 *
 * Cost is stored in integer micro-rupees rather than a float. Money in floating point
 * accumulates rounding error that shows up as invoices which do not reconcile, and the fix
 * is always the same: keep an integer minor unit and divide only at the presentation layer.
 */
export const requestLog = pgTable(
  'request_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    modelId: text('model_id').notNull(),
    version: text('version').notNull(),
    replicaId: text('replica_id'),
    outcome: requestOutcome('outcome').notNull(),
    queuedMs: real('queued_ms').notNull().default(0),
    executionMs: real('execution_ms').notNull().default(0),
    totalMs: real('total_ms').notNull().default(0),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    batchSize: integer('batch_size').notNull().default(1),
    hedged: boolean('hedged').notNull().default(false),
    costMicrosInr: bigint('cost_micros_inr', { mode: 'number' }).notNull().default(0),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Supports the dashboard's primary query: recent traffic for one tenant, newest first.
    index('request_log_tenant_time_idx').on(table.tenantId, table.createdAt),
    index('request_log_model_time_idx').on(table.modelId, table.version, table.createdAt),
    // Rollout analysis reads exclusively by (version, time), so it gets its own index
    // rather than relying on a prefix scan of the composite above.
    index('request_log_outcome_time_idx').on(table.outcome, table.createdAt),
  ],
);

export const modelsRelations = relations(models, ({ many }) => ({
  versions: many(modelVersions),
  rollouts: many(rollouts),
}));

export const modelVersionsRelations = relations(modelVersions, ({ one }) => ({
  model: one(models, { fields: [modelVersions.modelId], references: [models.id] }),
}));

export const rolloutsRelations = relations(rollouts, ({ one, many }) => ({
  model: one(models, { fields: [rollouts.modelId], references: [models.id] }),
  analyses: many(rolloutAnalyses),
}));

export const rolloutAnalysesRelations = relations(rolloutAnalyses, ({ one }) => ({
  rollout: one(rollouts, { fields: [rolloutAnalyses.rolloutId], references: [rollouts.id] }),
}));

export type Tenant = typeof tenants.$inferSelect;
export type Model = typeof models.$inferSelect;
export type ModelVersion = typeof modelVersions.$inferSelect;
export type Replica = typeof replicas.$inferSelect;
export type Rollout = typeof rollouts.$inferSelect;
export type RolloutAnalysis = typeof rolloutAnalyses.$inferSelect;
export type RequestLogEntry = typeof requestLog.$inferSelect;
export type NewRequestLogEntry = typeof requestLog.$inferInsert;
