-- Halcyon control-plane schema, initial migration.

CREATE TYPE "rollout_phase" AS ENUM ('idle', 'progressing', 'paused', 'promoted', 'rolled_back');
CREATE TYPE "request_outcome" AS ENUM ('ok', 'shed_quota', 'shed_overload', 'shed_deadline', 'upstream_error', 'timeout');

CREATE TABLE IF NOT EXISTS "tenants" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "burst" double precision DEFAULT 100 NOT NULL,
  "rate_per_second" double precision DEFAULT 10 NOT NULL,
  "priority" real DEFAULT 0.5 NOT NULL,
  "api_key_hash" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_api_key_hash_idx" ON "tenants" ("api_key_hash");

CREATE TABLE IF NOT EXISTS "models" (
  "id" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "model_versions" (
  "model_id" text NOT NULL REFERENCES "models"("id") ON DELETE CASCADE,
  "version" text NOT NULL,
  "artifact_uri" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_versions_pk" PRIMARY KEY ("model_id", "version")
);

CREATE TABLE IF NOT EXISTS "replicas" (
  "id" text PRIMARY KEY NOT NULL,
  "model_id" text NOT NULL,
  "version" text NOT NULL,
  "address" text NOT NULL,
  "weight" real DEFAULT 1 NOT NULL,
  "accelerator" text DEFAULT 'cpu-sim' NOT NULL,
  "max_batch_size" integer DEFAULT 32 NOT NULL,
  "max_batch_tokens" integer DEFAULT 16384 NOT NULL,
  "registered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "replicas_model_version_idx" ON "replicas" ("model_id", "version");

CREATE TABLE IF NOT EXISTS "rollouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "model_id" text NOT NULL REFERENCES "models"("id") ON DELETE CASCADE,
  "baseline_version" text NOT NULL,
  "canary_version" text NOT NULL,
  "phase" "rollout_phase" DEFAULT 'idle' NOT NULL,
  "canary_percent" real DEFAULT 0 NOT NULL,
  "policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "rollouts_model_idx" ON "rollouts" ("model_id");

-- Two concurrent ramps on one model would leave neither arm a clean baseline, so the
-- database refuses the situation outright rather than trusting every caller to check.
CREATE UNIQUE INDEX IF NOT EXISTS "rollouts_one_active_per_model_idx"
  ON "rollouts" ("model_id")
  WHERE phase IN ('idle', 'progressing', 'paused');

CREATE TABLE IF NOT EXISTS "rollout_analyses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rollout_id" uuid NOT NULL REFERENCES "rollouts"("id") ON DELETE CASCADE,
  "analysed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "canary_percent" real NOT NULL,
  "decision" text NOT NULL,
  "reason" text,
  "baseline_metrics" jsonb NOT NULL,
  "canary_metrics" jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS "rollout_analyses_rollout_idx" ON "rollout_analyses" ("rollout_id", "analysed_at");

CREATE TABLE IF NOT EXISTS "request_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "model_id" text NOT NULL,
  "version" text NOT NULL,
  "replica_id" text,
  "outcome" "request_outcome" NOT NULL,
  "queued_ms" real DEFAULT 0 NOT NULL,
  "execution_ms" real DEFAULT 0 NOT NULL,
  "total_ms" real DEFAULT 0 NOT NULL,
  "prompt_tokens" integer DEFAULT 0 NOT NULL,
  "completion_tokens" integer DEFAULT 0 NOT NULL,
  "batch_size" integer DEFAULT 1 NOT NULL,
  "hedged" boolean DEFAULT false NOT NULL,
  -- Integer micro-rupees. Money in floating point accumulates rounding error that surfaces
  -- as invoices which do not reconcile; the fix is always an integer minor unit.
  "cost_micros_inr" bigint DEFAULT 0 NOT NULL,
  "trace_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "request_log_tenant_time_idx" ON "request_log" ("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "request_log_model_time_idx" ON "request_log" ("model_id", "version", "created_at");
CREATE INDEX IF NOT EXISTS "request_log_outcome_time_idx" ON "request_log" ("outcome", "created_at");
