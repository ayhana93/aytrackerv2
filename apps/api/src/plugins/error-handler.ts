import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { httpStatusForKind, isDomainError, type DomainError } from '@aytracker/domain';
import { translateDatabaseError } from '@aytracker/database';

/**
 * The single error boundary.
 *
 * Three properties matter:
 *   1. Nothing is swallowed. Every unrecognized error is logged at error level with its stack
 *      and the request id before a generic response goes out.
 *   2. Nothing internal leaks. Clients get a stable `code` and, for validation errors, the
 *      field paths — never a stack trace, a SQL fragment or a table name.
 *   3. Cross-tenant access reports 404. A 403 would confirm that the row exists in another
 *      organization, which is itself the leak we are preventing.
 */

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly kind: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}

const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.requestId ?? 'unknown';

    if (error instanceof ZodError) {
      request.log.info({ requestId, issues: error.issues }, 'request validation failed');
      return reply.status(400).send({
        error: {
          code: 'validation.failed',
          kind: 'VALIDATION',
          requestId,
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
      } satisfies ApiErrorBody);
    }

    const domainError = isDomainError(error) ? error : translateDatabaseError(error);

    if (domainError) {
      const status = httpStatusForKind(domainError.kind);

      // Security-relevant refusals are logged at warn with the actor, so a pattern of probing
      // is visible without having to reconstruct it from 403s in an access log.
      if (
        domainError.code.startsWith('auth.cross_tenant') ||
        domainError.code.startsWith('tenant.') ||
        domainError.details?.['securityEvent']
      ) {
        request.log.warn(
          {
            requestId,
            code: domainError.code,
            organizationId: request.actor?.organizationId,
            actorType: request.actor?.actorType,
            route: request.routeOptions?.url ?? request.url,
          },
          'tenant isolation refusal',
        );
      } else if (status >= 500) {
        request.log.error({ requestId, err: domainError }, 'domain error');
      } else {
        request.log.info({ requestId, code: domainError.code }, 'request rejected');
      }

      return reply.status(status).send({
        error: {
          code: domainError.code,
          kind: domainError.kind,
          requestId,
          ...(domainError.details ? { details: domainError.details } : {}),
        },
      } satisfies ApiErrorBody);
    }

    // Fastify's own errors (bad JSON, payload too large, unsupported media type).
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode < 500) {
      request.log.info({ requestId, err: error }, 'client error');
      return reply.status(statusCode).send({
        error: { code: 'request.invalid', kind: 'VALIDATION', requestId },
      } satisfies ApiErrorBody);
    }

    request.log.error({ requestId, err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'error.internal', kind: 'INTERNAL', requestId },
    } satisfies ApiErrorBody);
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: 'route.not_found',
        kind: 'NOT_FOUND',
        requestId: request.requestId ?? 'unknown',
      },
    } satisfies ApiErrorBody);
  });
};

export default fp(errorHandlerPlugin, { name: 'error-handler', dependencies: ['request-context'] });

export function toDomainError(error: unknown): DomainError | null {
  return isDomainError(error) ? error : translateDatabaseError(error);
}
