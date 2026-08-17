import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { z } from 'zod';
import { BatchExecutionRequestSchema, type BatchExecutionResponse } from '@halcyon/contracts';
import { Logger } from '@halcyon/telemetry';
import { SimulatedRuntime, type ModelRuntime } from './runtimes/index.js';

const ConfigSchema = z.object({
  replicaId: z.string().min(1),
  modelId: z.string().min(1).default('llama-3-8b'),
  version: z.string().min(1).default('v1'),
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65_535).default(9100),
  /** Address the gateway should dial. Must be reachable from the gateway, not from here. */
  advertiseAddress: z.string().url(),
  gatewayUrl: z.string().url(),
  weight: z.coerce.number().positive().default(1),
  accelerator: z.string().default('cpu-sim'),
  maxBatchSize: z.coerce.number().int().positive().default(32),
  maxBatchTokens: z.coerce.number().int().positive().default(16_384),
  heartbeatIntervalMs: z.coerce.number().int().min(500).default(5_000),
  kernelOverheadMs: z.coerce.number().min(0).default(18),
  msPerToken: z.coerce.number().min(0).default(0.022),
  failureRate: z.coerce.number().min(0).max(1).default(0),
  speedFactor: z.coerce.number().positive().default(1),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type WorkerConfig = z.infer<typeof ConfigSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const port = env['PORT'] ?? '9100';
  const replicaId = env['REPLICA_ID'] ?? `replica-${port}`;
  const parsed = ConfigSchema.safeParse({
    replicaId,
    modelId: env['MODEL_ID'],
    version: env['MODEL_VERSION'],
    host: env['HOST'],
    port,
    advertiseAddress: env['ADVERTISE_ADDRESS'] ?? `http://localhost:${port}`,
    gatewayUrl: env['GATEWAY_URL'] ?? 'http://localhost:8080',
    weight: env['REPLICA_WEIGHT'],
    accelerator: env['ACCELERATOR'],
    maxBatchSize: env['MAX_BATCH_SIZE'],
    maxBatchTokens: env['MAX_BATCH_TOKENS'],
    heartbeatIntervalMs: env['HEARTBEAT_INTERVAL_MS'],
    kernelOverheadMs: env['KERNEL_OVERHEAD_MS'],
    msPerToken: env['MS_PER_TOKEN'],
    failureRate: env['FAILURE_RATE'],
    speedFactor: env['SPEED_FACTOR'],
    logLevel: env['LOG_LEVEL'],
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid worker configuration:\n${parsed.error.issues
        .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return parsed.data;
}

export function buildWorker(config: WorkerConfig, runtime?: ModelRuntime) {
  const logger = new Logger({
    service: `halcyon-worker:${config.replicaId}`,
    level: config.logLevel,
  });
  const engine: ModelRuntime =
    runtime ??
    new SimulatedRuntime({
      modelId: config.modelId,
      version: config.version,
      kernelOverheadMs: config.kernelOverheadMs,
      msPerToken: config.msPerToken,
      failureRate: config.failureRate,
      speedFactor: config.speedFactor,
      // Seeding from the replica id keeps each replica's jitter independent, so a fleet does
      // not move in lockstep — synchronised replicas would make the router's job artificially
      // easy and hide exactly the imbalance it exists to correct.
      seed: hashString(config.replicaId),
    });

  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  /**
   * A worker executes one batch at a time, matching how an accelerator actually behaves.
   * Concurrency here would not make the device faster; it would only hide queueing from
   * the gateway, whose scheduling decisions depend on knowing when this replica is busy.
   */
  let busy = false;

  app.post('/v1/execute', async (request, reply) => {
    const parsed = BatchExecutionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues.map((i) => i.message).join('; ') };
    }
    if (busy) {
      // Explicit rejection beats silent queueing: the gateway can route elsewhere, whereas
      // an invisible queue here would corrupt its latency model for every replica.
      reply.code(503);
      return { error: 'replica busy' };
    }

    busy = true;
    const startedAt = Date.now();
    try {
      const results = await engine.execute(parsed.data.items);
      const response: BatchExecutionResponse = {
        batchId: parsed.data.batchId,
        replicaId: config.replicaId,
        executionMs: Date.now() - startedAt,
        results,
      };
      return response;
    } catch (error) {
      logger.warn('batch execution failed', {
        batchId: parsed.data.batchId,
        error: error instanceof Error ? error.message : String(error),
      });
      reply.code(500);
      return { error: error instanceof Error ? error.message : 'execution failed' };
    } finally {
      busy = false;
    }
  });

  app.get('/healthz', async () => ({ status: 'ok', replicaId: config.replicaId, busy }));

  return { app, logger, runtime: engine };
}

/**
 * Registers with the gateway, retrying with exponential backoff.
 *
 * Workers and gateways start in arbitrary order — under an orchestrator, almost never the
 * convenient one. A worker that gives up because the gateway was not ready for its first
 * attempt turns a startup race into a permanently missing replica.
 */
async function registerWithGateway(config: WorkerConfig, logger: Logger): Promise<void> {
  const payload = {
    replicaId: config.replicaId,
    modelId: config.modelId,
    version: config.version,
    address: config.advertiseAddress,
    weight: config.weight,
    accelerator: config.accelerator,
    maxBatchSize: config.maxBatchSize,
    maxBatchTokens: config.maxBatchTokens,
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${config.gatewayUrl}/v1/workers/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`gateway returned HTTP ${response.status}`);
      logger.info('registered with gateway', { gateway: config.gatewayUrl });
      return;
    } catch (error) {
      const delay = Math.min(30_000, 500 * 2 ** attempt);
      logger.warn('registration failed, retrying', {
        attempt,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const { app, logger } = buildWorker(config);

  await app.listen({ host: config.host, port: config.port });
  logger.info('worker listening', {
    port: config.port,
    model: config.modelId,
    version: config.version,
    accelerator: config.accelerator,
  });

  await registerWithGateway(config, logger);

  const heartbeat = setInterval(() => {
    void fetch(`${config.gatewayUrl}/v1/workers/${config.replicaId}/heartbeat`, {
      method: 'POST',
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {
      // A missed heartbeat is self-healing: the gateway's router will stop routing here
      // after its timeout and resume the moment beats return. Logging every miss during a
      // gateway restart would be pure noise.
    });
  }, config.heartbeatIntervalMs);
  heartbeat.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    clearInterval(heartbeat);
    // Ask the gateway to stop routing here *before* closing the server, so in-flight work
    // finishes instead of being severed mid-batch.
    await fetch(`${config.gatewayUrl}/v1/workers/${config.replicaId}/drain`, {
      method: 'POST',
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  void main();
}
