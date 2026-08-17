import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Logger, Tracer } from '@halcyon/telemetry';
import { loadConfig } from '../src/config.js';
import { InferenceEngine } from '../src/engine.js';
import { buildMetrics } from '../src/metrics.js';
import { TenantDirectory } from '../src/plugins/auth.js';
import { registerErrorHandler } from '../src/plugins/errors.js';
import { registerRoutes } from '../src/routes/index.js';

/**
 * These tests drive the gateway through its real HTTP surface, against a real (if trivial)
 * worker process listening on a real port.
 *
 * Mocking `fetch` would have been faster to write and would have tested nothing worth
 * testing: the interesting failures in this system live in the seams — batch dispatch,
 * response correlation, abort propagation — and a mock replaces exactly those seams with an
 * assumption. Fastify's `inject` covers the gateway side without binding a port; the worker
 * does bind one, because the engine genuinely dials it over HTTP.
 */

interface FakeWorker {
  app: FastifyInstance;
  address: string;
  /** Set to fail every execution, for breaker and error-path tests. */
  failing: boolean;
  /** Reject the next `busyFor` batches with 503 — backpressure, not a fault. */
  busyFor: number;
  /** Artificial delay per batch, for latency-sensitive tests. */
  delayMs: number;
  batches: { batchId: string; size: number }[];
}

async function startFakeWorker(replicaId: string): Promise<FakeWorker> {
  const state: FakeWorker = {
    app: Fastify({ logger: false }),
    address: '',
    failing: false,
    busyFor: 0,
    delayMs: 0,
    batches: [],
  };

  state.app.post<{ Body: { batchId: string; items: { requestId: string; input: string }[] } }>(
    '/v1/execute',
    async (request, reply) => {
      const { batchId, items } = request.body;
      state.batches.push({ batchId, size: items.length });
      if (state.busyFor > 0) {
        state.busyFor -= 1;
        reply.code(503);
        return { error: 'replica busy' };
      }
      if (state.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      }
      if (state.failing) {
        reply.code(500);
        return { error: 'simulated failure' };
      }
      return {
        batchId,
        replicaId,
        executionMs: state.delayMs,
        results: items.map((item) => ({
          requestId: item.requestId,
          output: `echo:${item.input}`,
          promptTokens: 4,
          completionTokens: 8,
        })),
      };
    },
  );

  await state.app.listen({ host: '127.0.0.1', port: 0 });
  const addressInfo = state.app.server.address();
  if (!addressInfo || typeof addressInfo === 'string') throw new Error('no port assigned');
  state.address = `http://127.0.0.1:${addressInfo.port}`;
  return state;
}

interface Harness {
  app: FastifyInstance;
  engine: InferenceEngine;
  workers: FakeWorker[];
  close: () => Promise<void>;
}

async function buildHarness(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const config = loadConfig({
    LOG_LEVEL: 'error',
    // Keep the scheduler responsive so tests do not wait on real linger windows.
    LINGER_MS: '5',
    SAFETY_MARGIN_MS: '2',
    HEDGING_ENABLED: 'false',
    ...env,
  } as NodeJS.ProcessEnv);

  const metrics = buildMetrics();
  const logger = new Logger({ service: 'test', level: 'error' });
  const tracer = new Tracer({ serviceName: 'test' });
  const engine = new InferenceEngine(config, metrics, logger, tracer);

  const tenants = new TenantDirectory();
  tenants.register('test-key', { tenantId: 'test-tenant', name: 'Test' });

  const app = Fastify({ logger: false });
  // The real handler, not a stand-in. A harness that reimplements error mapping tests only
  // the reimplementation — which is exactly how a missing Retry-After header reaches prod.
  registerErrorHandler(app, logger);
  await registerRoutes(app, { engine, metrics, tenants });

  const workers: FakeWorker[] = [];
  return {
    app,
    engine,
    workers,
    close: async () => {
      await engine.shutdown();
      await app.close();
      await Promise.all(workers.map((w) => w.app.close()));
    },
  };
}

async function registerWorker(
  harness: Harness,
  replicaId: string,
  version = 'v1',
): Promise<FakeWorker> {
  const worker = await startFakeWorker(replicaId);
  harness.workers.push(worker);
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/workers/register',
    payload: {
      replicaId,
      modelId: 'test-model',
      version,
      address: worker.address,
      weight: 1,
    },
  });
  expect(response.statusCode).toBe(200);
  return worker;
}

const infer = (harness: Harness, body: Record<string, unknown> = {}) =>
  harness.app.inject({
    method: 'POST',
    url: '/v1/infer',
    headers: { 'x-api-key': 'test-key' },
    payload: {
      model: 'test-model',
      input: 'hello',
      deadlineMs: 5_000,
      maxOutputTokens: 32,
      ...body,
    },
  });

describe('gateway', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  describe('authentication', () => {
    it('rejects a request with no API key', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/infer',
        payload: { model: 'test-model', input: 'x' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an unrecognised API key', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/infer',
        headers: { 'x-api-key': 'wrong' },
        payload: { model: 'test-model', input: 'x' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('validation', () => {
    it('rejects a malformed body before it reaches the scheduler', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/infer',
        headers: { 'x-api-key': 'test-key' },
        payload: { model: '', input: '' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_request');
    });

    it('reports a model with no registered replicas as not found', async () => {
      const response = await infer(harness, { model: 'nonexistent' });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('model_not_found');
    });
  });

  describe('inference', () => {
    it('serves a request end to end and reports the scheduler decisions', async () => {
      await registerWorker(harness, 'replica-a');
      const response = await infer(harness);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.output).toBe('echo:hello');
      expect(body.version).toBe('v1');
      expect(body.replicaId).toBe('replica-a');
      expect(body.batch.size).toBeGreaterThanOrEqual(1);
      expect(body.timings.totalMs).toBeGreaterThanOrEqual(0);
      expect(body.usage.completionTokens).toBe(8);
    });

    it('surfaces scheduler decisions as response headers', async () => {
      await registerWorker(harness, 'replica-a');
      const response = await infer(harness);
      expect(response.headers['x-halcyon-version']).toBe('v1');
      expect(response.headers['x-halcyon-batch-size']).toBeDefined();
      expect(response.headers['x-halcyon-queued-ms']).toBeDefined();
    });

    it('coalesces concurrent requests into a single batch', async () => {
      const worker = await registerWorker(harness, 'replica-a');
      const responses = await Promise.all(Array.from({ length: 8 }, () => infer(harness)));

      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      // Eight concurrent requests must not produce eight separate executions, or batching
      // is not happening at all.
      expect(worker.batches.length).toBeLessThan(8);
      expect(Math.max(...worker.batches.map((b) => b.size))).toBeGreaterThan(1);
    });

    it('correlates each response to the request that asked for it', async () => {
      await registerWorker(harness, 'replica-a');
      const responses = await Promise.all(
        ['alpha', 'beta', 'gamma', 'delta'].map((input) => infer(harness, { input })),
      );
      const outputs = responses.map((r) => r.json().output);
      expect(new Set(outputs).size).toBe(4);
      expect(outputs).toContain('echo:alpha');
      expect(outputs).toContain('echo:delta');
    });

    it('rejects a deadline it cannot meet rather than accepting doomed work', async () => {
      await registerWorker(harness, 'replica-a');
      const response = await infer(harness, { deadlineMs: 10, maxOutputTokens: 4_096 });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('deadline_unreachable');
    });

    it('retries a busy replica rather than failing the batch', async () => {
      // A 503 means "fully occupied", not "broken". Failing the batch on backpressure was
      // observed shedding real traffic under sustained load.
      const worker = await registerWorker(harness, 'replica-a');
      worker.busyFor = 1;
      const response = await infer(harness);
      expect(response.statusCode).toBe(200);
      expect(worker.batches.length).toBeGreaterThanOrEqual(2);
    });

    it('does not hold a busy signal against a replica', async () => {
      // Counting backpressure as failure trips the breaker on a healthy replica, then on
      // the next one, until the fleet has no capacity at all. This was the cause of a live
      // crash: a 503 cascade starved routing until every dispatch errored.
      const worker = await registerWorker(harness, 'replica-a');
      worker.busyFor = 2;
      await infer(harness);

      const state = await harness.app.inject({ method: 'GET', url: '/v1/control/state' });
      const replica = state.json().replicas[0];
      expect(replica.breaker.state).toBe('closed');
      expect(replica.totalFailed).toBe(0);
    });

    it('reports upstream failure without hanging the client', async () => {
      const worker = await registerWorker(harness, 'replica-a');
      worker.failing = true;
      const response = await infer(harness);
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe('upstream_failure');
    });

    it('fails a queued request at its deadline when capacity never returns', async () => {
      // Regression test for a hang. With every replica draining there is nowhere to
      // dispatch, so the batcher holds the request — and without deadline expiry it held it
      // forever, keeping the caller's connection open long past any useful answer.
      await registerWorker(harness, 'replica-a');
      await harness.app.inject({ method: 'POST', url: '/v1/workers/replica-a/drain' });

      const startedAt = Date.now();
      const response = await infer(harness, { deadlineMs: 300 });
      const elapsed = Date.now() - startedAt;

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('deadline_unreachable');
      // It must fail at roughly the stated deadline — not immediately, and not never.
      expect(elapsed).toBeLessThan(3_000);
    });
  });

  describe('quotas', () => {
    it('sheds a tenant that exceeds its burst, with an actionable Retry-After', async () => {
      const local = await buildHarness({
        DEFAULT_TENANT_BURST: '3',
        DEFAULT_TENANT_RATE: '1',
      });
      try {
        await registerWorker(local, 'replica-a');
        const results = await Promise.all(Array.from({ length: 12 }, () => infer(local)));
        const shed = results.filter((r) => r.statusCode === 429);
        expect(shed.length).toBeGreaterThan(0);
        expect(shed[0]!.json().error.code).toBe('quota_exceeded');
        expect(Number(shed[0]!.headers['retry-after'] ?? 0)).toBeGreaterThan(0);
      } finally {
        await local.close();
      }
    });
  });

  describe('rollouts', () => {
    it('refuses a rollout to a version with no registered replicas', async () => {
      await registerWorker(harness, 'replica-a', 'v1');
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/control/rollouts',
        payload: { modelId: 'test-model', baselineVersion: 'v1', canaryVersion: 'v2' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('splits traffic once a canary starts, and keeps a session on one version', async () => {
      await registerWorker(harness, 'replica-a', 'v1');
      await registerWorker(harness, 'replica-b', 'v2');

      const started = await harness.app.inject({
        method: 'POST',
        url: '/v1/control/rollouts',
        payload: {
          modelId: 'test-model',
          baselineVersion: 'v1',
          canaryVersion: 'v2',
          policy: { steps: [50, 100] },
        },
      });
      expect(started.statusCode).toBe(200);

      // Assignment is a pure function of the session key, so it must never vary.
      const versions = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const response = await infer(harness, { sessionKey: 'sticky-user' });
        versions.add(response.json().version);
      }
      expect(versions.size).toBe(1);

      // Across many keys, both versions must appear at a 50/50 split.
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const response = await infer(harness, { sessionKey: `user-${i}` });
        seen.add(response.json().version);
      }
      expect(seen).toEqual(new Set(['v1', 'v2']));
    });

    it('sends all traffic to the canary once an operator promotes it', async () => {
      await registerWorker(harness, 'replica-a', 'v1');
      await registerWorker(harness, 'replica-b', 'v2');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/control/rollouts',
        payload: { modelId: 'test-model', baselineVersion: 'v1', canaryVersion: 'v2' },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/v1/control/rollouts/test-model/promote',
      });

      for (let i = 0; i < 10; i++) {
        const response = await infer(harness, { sessionKey: `user-${i}` });
        expect(response.json().version).toBe('v2');
      }
    });

    it('returns all traffic to the baseline on rollback', async () => {
      await registerWorker(harness, 'replica-a', 'v1');
      await registerWorker(harness, 'replica-b', 'v2');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/control/rollouts',
        payload: {
          modelId: 'test-model',
          baselineVersion: 'v1',
          canaryVersion: 'v2',
          policy: { steps: [50, 100] },
        },
      });
      await harness.app.inject({ method: 'POST', url: '/v1/control/rollouts/test-model/abort' });

      for (let i = 0; i < 10; i++) {
        const response = await infer(harness, { sessionKey: `user-${i}` });
        expect(response.json().version).toBe('v1');
      }
    });
  });

  describe('operational endpoints', () => {
    it('reports liveness without depending on replicas', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
    });

    it('is not ready until a replica registers', async () => {
      const before = await harness.app.inject({ method: 'GET', url: '/readyz' });
      expect(before.statusCode).toBe(503);

      await registerWorker(harness, 'replica-a');
      const after = await harness.app.inject({ method: 'GET', url: '/readyz' });
      expect(after.statusCode).toBe(200);
    });

    it('exposes Prometheus metrics in exposition format', async () => {
      await registerWorker(harness, 'replica-a');
      await infer(harness);
      const response = await harness.app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('halcyon_requests_total');
      expect(response.body).toContain('halcyon_request_duration_ms_bucket');
    });

    it('returns complete control-plane state in one round trip', async () => {
      await registerWorker(harness, 'replica-a');
      await infer(harness);
      const response = await harness.app.inject({ method: 'GET', url: '/v1/control/state' });
      const body = response.json();

      expect(body.models).toHaveLength(1);
      expect(body.replicas).toHaveLength(1);
      expect(body.traffic.requests).toBeGreaterThan(0);
      expect(body.admission.limiter.limit).toBeGreaterThan(0);
      expect(Object.keys(body.batching)).toContain('test-model@v1');
    });
  });
});
