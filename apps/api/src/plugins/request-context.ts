import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Request identity and structured logging context.
 *
 * Every log line, audit row and error response carries the same `requestId`, so a customer
 * reporting "it failed at 14:32" can be traced end to end. The id is echoed in the response
 * header for exactly that reason.
 */
declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startedAt: number;
  }
}

const requestContextPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('requestId', '');
  app.decorateRequest('startedAt', 0);

  app.addHook('onRequest', async (request, reply) => {
    // Accept an inbound id only from a trusted proxy; otherwise generate one. An attacker-set
    // id would let them collide with, and pollute, someone else's trace.
    request.requestId = randomUUID();
    request.startedAt = Date.now();
    void reply.header('x-request-id', request.requestId);
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        requestId: request.requestId,
        method: request.method,
        route: request.routeOptions?.url ?? request.url,
        status: reply.statusCode,
        durationMs: Date.now() - request.startedAt,
        organizationId: request.actor?.organizationId,
        actorType: request.actor?.actorType,
      },
      'request completed',
    );
  });
};

export default fp(requestContextPlugin, { name: 'request-context' });
