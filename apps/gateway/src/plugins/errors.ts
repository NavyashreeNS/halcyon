import type { FastifyInstance } from 'fastify';
import type { Logger } from '@halcyon/telemetry';
import { EngineError } from '../engine.js';

/**
 * The single place an error becomes an HTTP response.
 *
 * Extracted rather than inlined in `buildServer` so the test suite exercises the *real*
 * handler. A test harness that reimplements error mapping proves only that the
 * reimplementation works — which is how a missing `Retry-After` header survives a green
 * suite all the way into production.
 */
export function registerErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof EngineError) {
      if (error.retryAfterMs !== undefined) {
        // Seconds, per RFC 9110 — and at least 1, since `Retry-After: 0` invites a hot loop.
        reply.header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))));
        // Millisecond precision alongside it, because a one-second floor is far coarser than
        // the scheduler actually knows and well-behaved clients can do better.
        reply.header('x-halcyon-retry-after-ms', String(Math.ceil(error.retryAfterMs)));
      }
      reply.code(error.status);
      return {
        error: {
          code: error.code,
          message: error.message,
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          requestId: request.id,
        },
      };
    }

    // Fastify raises body-parse and schema failures before the route ever runs, so they
    // arrive here rather than as an EngineError.
    const message = error instanceof Error ? error.message : String(error);
    if ((error as { statusCode?: number })?.statusCode === 400) {
      reply.code(400);
      return {
        error: { code: 'invalid_request', message, requestId: request.id },
      };
    }

    logger.error('unhandled request error', {
      requestId: request.id,
      path: request.url,
      error: message,
    });
    reply.code(500);
    // Deliberately opaque: an unhandled error's message may carry internals, and the
    // requestId is enough to correlate with the structured log line above.
    return {
      error: { code: 'upstream_failure', message: 'Internal error', requestId: request.id },
    };
  });
}
