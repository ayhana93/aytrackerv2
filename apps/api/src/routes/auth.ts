import type { FastifyPluginAsync } from 'fastify';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME, sessionCookieOptions } from '@aytracker/auth';
import {
  adminLoginSchema,
  driverLoginSchema,
  registerSchema,
  workerLoginSchema,
} from '@aytracker/validation';
import { displayName, logoAssetUrl } from '../lib/branding.js';
import type { AppServices } from '../services/container.js';

/**
 * /api/v1/auth
 *
 * Login sets two cookies: the session (HTTP-only, the credential) and the CSRF token (readable,
 * echoed in a header on mutations). The response body carries no token — a token in a JSON body
 * ends up in localStorage, and localStorage is readable by any XSS.
 */
export function authRoutes(services: AppServices): FastifyPluginAsync {
  return async (app) => {
    const cookieOptions = (ttlSeconds: number) =>
      sessionCookieOptions({
        ttlSeconds,
        secure: services.config.useSecureCookies,
        domain: services.config.env.SESSION_COOKIE_DOMAIN || undefined,
      });

    /**
     * Self-serve signup: a new organization, and its first user.
     *
     * The tightest rate limit in the file. Login attempts are cheap to make and cheap to reject;
     * this one writes an organization, a user, a site and a work area, so an unthrottled endpoint
     * is a way to fill someone else's database from a laptop.
     *
     * Signs the new owner in directly rather than bouncing them to the login form. They proved
     * they hold the credentials by choosing them thirty milliseconds ago, and making someone type
     * a password they have just invented is the sort of friction that loses the account.
     */
    app.post(
      '/register',
      { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
      async (request, reply) => {
        const body = registerSchema.parse(request.body);
        const now = new Date();

        const created = await services.registration.register({ ...body, now });

        const ttl = services.config.sessionTtlSeconds.USER;
        const session = await services.sessions.issue({
          actorType: 'USER',
          organizationId: created.organizationId,
          userId: created.userId,
          permissions: created.permissions,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          ttlSeconds: ttl,
          now,
        });

        return reply
          .status(201)
          .setCookie(SESSION_COOKIE_NAME, session.token, cookieOptions(ttl))
          .setCookie(CSRF_COOKIE_NAME, session.csrfToken, {
            ...cookieOptions(ttl),
            httpOnly: false,
          })
          .send({
            actorType: 'USER',
            organizationId: created.organizationId,
            // Returned because the worker and driver login screens need it, and the person who
            // just signed up is the one who has to give it to their staff.
            organizationSlug: created.organizationSlug,
            permissions: created.permissions,
            expiresAt: session.expiresAt.toISOString(),
          });
      },
    );

    /** Admin login. Rate limited per IP — see the rate-limit plugin's per-route override. */
    app.post(
      '/login',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request, reply) => {
        const body = adminLoginSchema.parse(request.body);
        const now = new Date();

        const actor = await services.auth.authenticateAdmin({
          email: body.email,
          password: body.password,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          now,
        });

        const ttl = services.config.sessionTtlSeconds.USER;
        const session = await services.sessions.issue({
          actorType: 'USER',
          organizationId: actor.organizationId,
          userId: actor.userId,
          permissions: actor.permissions,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          ttlSeconds: ttl,
          now,
        });

        return reply
          .setCookie(SESSION_COOKIE_NAME, session.token, cookieOptions(ttl))
          .setCookie(CSRF_COOKIE_NAME, session.csrfToken, {
            ...cookieOptions(ttl),
            httpOnly: false,
          })
          .send({
            actorType: 'USER',
            organizationId: actor.organizationId,
            permissions: actor.permissions,
            expiresAt: session.expiresAt.toISOString(),
          });
      },
    );

    /**
     * Worker PIN login.
     *
     * A tighter limit than admin login: a 6-digit PIN has far less entropy than a password, so
     * the rate limit is doing more of the work here.
     */
    app.post(
      '/worker/login',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = workerLoginSchema.parse(request.body);
        const now = new Date();

        const actor = await services.auth.authenticateWorker({
          organizationSlug: body.organizationSlug,
          employeeNumber: body.employeeNumber,
          pin: body.pin,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          now,
        });

        const ttl = services.config.sessionTtlSeconds.WORKER;
        const session = await services.sessions.issue({
          actorType: 'WORKER',
          organizationId: actor.organizationId,
          workerId: actor.workerId,
          permissions: actor.permissions,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          ttlSeconds: ttl,
          now,
        });

        return reply
          .setCookie(SESSION_COOKIE_NAME, session.token, cookieOptions(ttl))
          .setCookie(CSRF_COOKIE_NAME, session.csrfToken, {
            ...cookieOptions(ttl),
            httpOnly: false,
          })
          .send({
            actorType: 'WORKER',
            workerId: actor.workerId,
            permissions: actor.permissions,
            expiresAt: session.expiresAt.toISOString(),
          });
      },
    );

    app.post(
      '/driver/login',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = driverLoginSchema.parse(request.body);
        const now = new Date();

        const actor = await services.auth.authenticateDriver({
          organizationSlug: body.organizationSlug,
          driverCode: body.driverCode,
          pin: body.pin,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          now,
        });

        const ttl = services.config.sessionTtlSeconds.DRIVER;
        const session = await services.sessions.issue({
          actorType: 'DRIVER',
          organizationId: actor.organizationId,
          driverId: actor.driverId,
          permissions: actor.permissions,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          ttlSeconds: ttl,
          now,
        });

        return reply
          .setCookie(SESSION_COOKIE_NAME, session.token, cookieOptions(ttl))
          .setCookie(CSRF_COOKIE_NAME, session.csrfToken, {
            ...cookieOptions(ttl),
            httpOnly: false,
          })
          .send({
            actorType: 'DRIVER',
            driverId: actor.driverId,
            permissions: actor.permissions,
            expiresAt: session.expiresAt.toISOString(),
          });
      },
    );

    app.post('/logout', async (request, reply) => {
      const actor = request.actor;
      if (actor) {
        await services.sessions.revoke(actor.sessionId, 'user_logout', new Date());
      }
      return reply
        .clearCookie(SESSION_COOKIE_NAME, { path: '/' })
        .clearCookie(CSRF_COOKIE_NAME, { path: '/' })
        .send({ ok: true });
    });

    /** Who am I. The client renders navigation from this, never from a decoded token. */
    app.get('/me', async (request) => {
      const actor = app.requireAuth(request);
      const [entitlements, organization] = await Promise.all([
        services.entitlements.forOrganization(actor.organizationId),
        services.prisma.organization.findUnique({
          where: { id: actor.organizationId },
          select: {
            name: true,
            slug: true,
            branding: { select: { companyName: true, logoAssetId: true, logoUrl: true } },
          },
        }),
      ]);
      return {
        actorType: actor.actorType,
        organizationId: actor.organizationId,
        /**
         * Carried here because the admin has to be able to read it out to their staff: it is
         * what a worker types on their own login screen. Somewhere in the interface has to
         * answer "what do I tell them", and the alternative is an admin who cannot onboard
         * anyone because the tenant key exists only in a database column.
         */
        organizationSlug: organization?.slug ?? null,
        /**
         * The name every shell in the product shows in place of the product's own.
         *
         * Resolved here rather than in each client so the sidebar, the worker portal and the
         * driver portal cannot disagree about what the company is called — and so a client never
         * has to decide between `branding.companyName` and the registered name.
         */
        organizationName: organization ? displayName(organization, organization.branding) : null,
        /** The chosen logo, or an externally hosted one, or null for the monogram fallback. */
        organizationLogoUrl: organization?.branding?.logoAssetId
          ? logoAssetUrl(services.config.env.API_URL, organization.branding.logoAssetId)
          : (organization?.branding?.logoUrl ?? null),
        userId: actor.userId ?? null,
        workerId: actor.workerId ?? null,
        driverId: actor.driverId ?? null,
        permissions: actor.permissions,
        features: entitlements.enabledFeatureCodes(),
      };
    });
  };
}
