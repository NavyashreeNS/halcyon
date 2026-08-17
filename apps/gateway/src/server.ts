import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { Logger, Tracer } from '@halcyon/telemetry';
import { loadConfig } from './config.js';
import { InferenceEngine } from './engine.js';
import { buildMetrics } from './metrics.js';
import { buildTenantDirectory } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/errors.js';
import { registerRoutes } from './routes/index.js';

export async function buildServer() {
  const config = loadConfig();
  const logger = new Logger({ service: 'halcyon-gateway', level: config.logLevel });
  const tracer = new Tracer({
    serviceName: 'halcyon-gateway',
    serviceVersion: '0.1.0',
    ...(config.otlpEndpoint ? { endpoint: config.otlpEndpoint } : {}),
    sampleRatio: config.traceSampleRatio,
  });
  const metrics = buildMetrics();
  const tenants = buildTenantDirectory();
  const engine = new InferenceEngine(config, metrics, logger, tracer);

  const app = Fastify({
    // Fastify's own logger is disabled in favour of the structured logger, so that every
    // line in the system shares one schema and one trace-correlation convention.
    logger: false,
    // Trust the proxy's forwarded headers — behind an ingress the socket address is the
    // load balancer, which makes per-client reasoning meaningless.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: 'x-request-id',
  });

  await app.register(cors, {
    origin: true,
    exposedHeaders: ['x-halcyon-version', 'x-halcyon-batch-size'],
  });
  await registerRoutes(app, { engine, metrics, tenants });

  registerErrorHandler(app, logger);
  engine.startControlLoop();

  return { app, config, engine, logger, tracer };
}

async function main(): Promise<void> {
  const { app, config, engine, logger } = await buildServer();

  /**
   * Graceful shutdown. The order is deliberate: stop accepting new connections first, then
   * let in-flight work drain. Reversing it would drain a queue that is still being filled.
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    try {
      await app.close();
      await engine.shutdown();
      process.exit(0);
    } catch (error) {
      logger.error('shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  logger.info('gateway listening', {
    host: config.host,
    port: config.port,
    maxBatchSize: config.maxBatchSize,
    lingerMs: config.lingerMs,
    hedging: config.hedgingEnabled,
  });
}

// Only auto-start when executed directly, so tests can import `buildServer` without
// binding a port.
const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  void main();
}
