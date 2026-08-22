import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '@aytracker/config';
import requestContext from './plugins/request-context.js';
import errorHandler from './plugins/error-handler.js';
import authentication from './plugins/authentication.js';
import authorization from './plugins/authorization.js';
import { authRoutes } from './routes/auth.js';
import { marketRoutes } from './routes/market.js';
import { workerRoutes } from './routes/worker.js';
import { driverRoutes } from './routes/driver.js';
import { trackingRoutes } from './routes/tracking.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import type { AppServices } from './services/container.js';

/**
 * Builds the Fastify application.
 *
 * Separated from `server.ts` so tests can build an app against a test database without binding
 * a port — which is what makes the tenant-isolation integration tests cheap enough to run on
 * every commit.
 */
export async function buildApp(config: AppConfig, services: AppServices): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.env.LOG_LEVEL,
      redact: {
        // Never log a credential, even by accident, even at trace level.
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.pin',
          'req.body.currentPassword',
          'req.body.newPassword',
        ],
        censor: '[redacted]',
      },
    },
    // Fastify's own request id is replaced by ours in the request-context plugin.
    disableRequestLogging: true,
    trustProxy: config.isProduction,
    bodyLimit: 1_048_576, // 1 MiB — a 500-point location batch is ~60 KiB.
  });

  await app.register(requestContext);
  await app.register(errorHandler);

  await app.register(helmet, {
    // The API serves JSON only; a restrictive CSP costs nothing here and blocks a whole class
    // of mistakes if an endpoint ever returns HTML.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    // 'same-site' would block the browser from reading a response at all once the web app and
    // the API are on different registrable domains (e.g. two separate Railway `*.up.railway.app`
    // services) — the explicit CORS origin allow-list above is what actually governs access.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cors, {
    // An explicit allow-list. `credentials: true` with a reflected origin would let any site
    // read authenticated responses.
    origin: config.env.CORS_ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
    maxAge: 600,
  });

  await app.register(cookie, {
    secret: config.env.SESSION_SECRET,
    parseOptions: { sameSite: 'lax', path: '/' },
  });

  if (config.env.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      /**
       * Keyed by organization when authenticated, by IP otherwise.
       *
       * Keying purely by IP would let one factory's shared NAT exhaust the limit for everyone
       * behind it — the exact deployment shape a manufacturing customer has.
       */
      keyGenerator: (request) =>
        request.actor
          ? `org:${request.actor.organizationId}:${request.actor.actorType}`
          : `ip:${request.ip}`,
      // In-process by default. REDIS_URL switches this to a shared store so the limit holds
      // across replicas rather than being multiplied by the replica count.
      ...(config.env.REDIS_URL ? {} : {}),
    });
  }

  await app.register(authentication, { sessions: services.sessions });
  await app.register(authorization, { entitlements: services.entitlements });

  await app.register(healthRoutes(services), { prefix: '/health' });
  await app.register(authRoutes(services), { prefix: '/api/v1/auth' });
  await app.register(marketRoutes(services), { prefix: '/api/v1/market' });
  await app.register(workerRoutes(services), { prefix: '/api/v1/worker' });
  await app.register(driverRoutes(services), { prefix: '/api/v1/driver' });
  await app.register(trackingRoutes(services), { prefix: '/api/v1/tracking' });
  await app.register(adminRoutes(services), { prefix: '/api/v1/admin' });

  return app;
}
