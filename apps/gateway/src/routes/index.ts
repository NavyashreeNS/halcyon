import type { FastifyInstance } from 'fastify';
import {
  InferenceRequestSchema,
  RolloutRequestSchema,
  WorkerRegistrationSchema,
} from '@halcyon/contracts';
import { EngineError, type InferenceEngine } from '../engine.js';
import type { Metrics } from '../metrics.js';
import { authenticate, type TenantDirectory } from '../plugins/auth.js';

interface RouteDeps {
  engine: InferenceEngine;
  metrics: Metrics;
  tenants: TenantDirectory;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { engine, metrics, tenants } = deps;
  const auth = authenticate(tenants);

  // -------------------------------------------------------------------------------------
  // Inference
  // -------------------------------------------------------------------------------------

  app.post('/v1/infer', async (request, reply) => {
    const identity = await auth(request, reply);
    const parsed = InferenceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new EngineError(
        'invalid_request',
        parsed.error.issues.map((i) => i.message).join('; '),
      );
    }
    const traceparent = request.headers['traceparent'];
    const response = await engine.infer(
      parsed.data,
      identity.tenantId,
      Array.isArray(traceparent) ? traceparent[0] : traceparent,
    );
    // Surfacing the scheduler's own decisions on the response makes the system explicable
    // from the client side: a caller can see it was batched with 17 others and waited 4ms.
    reply.header('x-halcyon-version', response.version);
    reply.header('x-halcyon-batch-size', String(response.batch.size));
    reply.header('x-halcyon-queued-ms', response.timings.queuedMs.toFixed(1));
    return response;
  });

  // -------------------------------------------------------------------------------------
  // Worker lifecycle
  // -------------------------------------------------------------------------------------

  app.post('/v1/workers/register', async (request) => {
    const parsed = WorkerRegistrationSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new EngineError(
        'invalid_request',
        parsed.error.issues.map((i) => i.message).join('; '),
      );
    }
    engine.registerWorker(parsed.data);
    return { ok: true, replicaId: parsed.data.replicaId };
  });

  app.post<{ Params: { replicaId: string } }>(
    '/v1/workers/:replicaId/heartbeat',
    async (request) => {
      engine.heartbeat(request.params.replicaId);
      return { ok: true };
    },
  );

  app.post<{ Params: { replicaId: string } }>('/v1/workers/:replicaId/drain', async (request) => {
    engine.drainWorker(request.params.replicaId);
    return { ok: true };
  });

  // -------------------------------------------------------------------------------------
  // Control plane
  // -------------------------------------------------------------------------------------

  app.get('/v1/control/state', async () => engine.snapshot());

  app.post('/v1/control/rollouts', async (request) => {
    const parsed = RolloutRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new EngineError(
        'invalid_request',
        parsed.error.issues.map((i) => i.message).join('; '),
      );
    }
    const { modelId, baselineVersion, canaryVersion, policy } = parsed.data;
    engine.startRollout(modelId, baselineVersion, canaryVersion, policy ?? {});
    return { ok: true, modelId, baselineVersion, canaryVersion };
  });

  app.post<{ Params: { modelId: string } }>(
    '/v1/control/rollouts/:modelId/abort',
    async (request) => {
      engine.abortRollout(request.params.modelId);
      return { ok: true };
    },
  );

  app.post<{ Params: { modelId: string } }>(
    '/v1/control/rollouts/:modelId/promote',
    async (request) => {
      engine.promoteRollout(request.params.modelId);
      return { ok: true };
    },
  );

  app.get<{ Params: { modelId: string } }>(
    '/v1/control/rollouts/:modelId/history',
    async (request) => ({ history: engine.rolloutHistory(request.params.modelId) }),
  );

  // -------------------------------------------------------------------------------------
  // Operational endpoints
  // -------------------------------------------------------------------------------------

  /** Liveness: is the process running? Deliberately dependency-free. */
  app.get('/healthz', async () => ({ status: 'ok' }));

  /**
   * Readiness: can this instance actually serve traffic? Distinct from liveness on purpose —
   * conflating them makes an orchestrator restart a healthy process that is merely waiting
   * for workers to register, which is the fastest way to turn a blip into an outage.
   */
  app.get('/readyz', async (_request, reply) => {
    const snapshot = engine.snapshot();
    const ready = snapshot.replicas.some((replica) => !replica.draining);
    if (!ready) {
      reply.code(503);
      return { status: 'unavailable', reason: 'no registered replicas' };
    }
    return { status: 'ready', replicas: snapshot.replicas.length };
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.render();
  });
}
