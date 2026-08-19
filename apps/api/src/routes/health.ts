import type { FastifyPluginAsync } from 'fastify';
import type { AppServices } from '../services/container.js';

/**
 * Health endpoints.
 *
 * `/health/live` answers "is the process up" and must never touch the database — a liveness
 * probe that fails on a slow query restarts a healthy container during an incident, turning a
 * degradation into an outage.
 *
 * `/health/ready` answers "can this instance serve traffic" and does check the database.
 */
export function healthRoutes(services: AppServices): FastifyPluginAsync {
  return async (app) => {
    app.get('/live', async () => ({ status: 'ok', time: new Date().toISOString() }));

    app.get('/ready', async (_request, reply) => {
      try {
        await services.prisma.$queryRaw`SELECT 1`;
        return { status: 'ready' };
      } catch (error) {
        app.log.error({ err: error }, 'readiness check failed');
        return reply.status(503).send({ status: 'unavailable' });
      }
    });
  };
}
