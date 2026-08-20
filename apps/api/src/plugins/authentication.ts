import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { UnauthenticatedError, ForbiddenError } from '@aytracker/domain';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  hashSessionToken,
  shouldTouchSession,
  validateSession,
} from '@aytracker/auth';
import type { ActorContext, OrganizationId } from '@aytracker/types';
import type { SessionService } from '../services/session-service.js';

/**
 * Authentication.
 *
 * The request carries an opaque session token in an HTTP-only cookie. Everything that decides
 * what the caller may do — organization, actor type, actor id, permissions — is read from the
 * session row on the server. Nothing in the request body, headers or query string contributes.
 *
 * That is the whole of the "server is the source of truth" rule, implemented in one place.
 */

declare module 'fastify' {
  interface FastifyRequest {
    actor?: ActorContext;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest) => ActorContext;
  }
}

/** Methods that mutate state and therefore need CSRF protection. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AuthenticationPluginOptions {
  readonly sessions: SessionService;
}

const authenticationPlugin: FastifyPluginAsync<AuthenticationPluginOptions> = async (
  app,
  options,
) => {
  app.decorateRequest('actor', undefined);

  app.decorate('requireAuth', (request: FastifyRequest): ActorContext => {
    if (!request.actor) throw new UnauthenticatedError();
    return request.actor;
  });

  app.addHook('preHandler', async (request) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token) return;

    const session = await options.sessions.findByTokenHash(hashSessionToken(token));
    if (!session) return;

    const now = new Date();
    const validity = validateSession(session, now);
    if (!validity.valid) {
      // An expired or revoked session is not an error on a public route; it simply means the
      // request is anonymous. Protected routes then reject it with 401.
      request.log.info(
        { requestId: request.requestId, reason: validity.reason },
        'session rejected',
      );
      return;
    }

    /**
     * CSRF: double-submit.
     *
     * The session cookie is HTTP-only, so a cross-site form cannot read it — but a browser will
     * still attach it to a cross-site request the form makes (that's what SameSite=None exists to
     * allow, since the web app and the API are not always on the same registrable domain). The
     * CSRF cookie is readable by our own JS and must be echoed in a header, which a form on
     * another origin cannot do, so this check is what actually stops the cross-site submit.
     */
    if (MUTATING_METHODS.has(request.method)) {
      const cookieToken = request.cookies[CSRF_COOKIE_NAME];
      const headerToken = request.headers[CSRF_HEADER_NAME];
      if (!cookieToken || cookieToken !== headerToken) {
        throw new ForbiddenError('auth.csrf_failed', 'CSRF token missing or mismatched.');
      }
    }

    request.actor = {
      actorType: session.actorType,
      organizationId: session.organizationId as OrganizationId,
      ...(session.userId ? { userId: session.userId as ActorContext['userId'] } : {}),
      ...(session.workerId ? { workerId: session.workerId as ActorContext['workerId'] } : {}),
      ...(session.driverId ? { driverId: session.driverId as ActorContext['driverId'] } : {}),
      permissions: session.permissions,
      sessionId: session.id,
      isPlatformAdmin: session.isPlatformAdmin,
    };

    // Idle-timeout accounting without a write on every request.
    if (shouldTouchSession(session.lastSeenAt, now)) {
      void options.sessions.touch(session.id, now).catch((error: unknown) => {
        request.log.warn({ err: error }, 'failed to touch session');
      });
    }
  });
};

export default fp(authenticationPlugin, {
  name: 'authentication',
  dependencies: ['request-context'],
});
