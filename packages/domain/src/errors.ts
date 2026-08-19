/**
 * The domain error vocabulary.
 *
 * Two rules make these useful at the API edge:
 *   1. `code` is a stable, machine-readable string. Clients branch on it; humans read the
 *      localized message the client looks up from the code, never the `message` here.
 *   2. `message` is developer-facing English. No user-facing strings live in business logic
 *      (see docs/localization.md).
 */

export type DomainErrorKind =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'PRECONDITION_FAILED'
  | 'RATE_LIMITED'
  | 'ENTITLEMENT_REQUIRED'
  | 'INTERNAL';

export interface DomainErrorOptions {
  /** Structured, non-sensitive detail safe to return to the caller. */
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class DomainError extends Error {
  readonly kind: DomainErrorKind;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(kind: DomainErrorKind, code: string, message: string, options?: DomainErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.kind = kind;
    this.code = code;
    if (options?.details) this.details = options.details;
  }
}

export class ValidationError extends DomainError {
  constructor(code: string, message: string, options?: DomainErrorOptions) {
    super('VALIDATION', code, message, options);
  }
}

export class NotFoundError extends DomainError {
  constructor(code: string, message: string, options?: DomainErrorOptions) {
    super('NOT_FOUND', code, message, options);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, options?: DomainErrorOptions) {
    super('CONFLICT', code, message, options);
  }
}

export class ForbiddenError extends DomainError {
  constructor(code: string, message: string, options?: DomainErrorOptions) {
    super('FORBIDDEN', code, message, options);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(code = 'auth.unauthenticated', message = 'Authentication required.') {
    super('UNAUTHENTICATED', code, message);
  }
}

export class PreconditionFailedError extends DomainError {
  constructor(code: string, message: string, options?: DomainErrorOptions) {
    super('PRECONDITION_FAILED', code, message, options);
  }
}

export class EntitlementRequiredError extends DomainError {
  constructor(featureCode: string, options?: DomainErrorOptions) {
    super('ENTITLEMENT_REQUIRED', 'entitlement.required', `Feature ${featureCode} is not enabled.`, {
      ...options,
      details: { featureCode, ...options?.details },
    });
  }
}

export class RateLimitedError extends DomainError {
  constructor(code = 'rate_limit.exceeded', retryAfterSeconds?: number) {
    super('RATE_LIMITED', code, 'Too many requests.', {
      details: retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
    });
  }
}

/**
 * Raised when a request would read or write a row belonging to a different tenant.
 *
 * Deliberately reported as NOT_FOUND at the HTTP edge: telling a caller "this exists but is not
 * yours" is itself a cross-tenant information leak. The distinction is preserved here so the
 * security event can be logged accurately.
 */
export class TenantIsolationError extends DomainError {
  constructor(entityType: string, entityId: string) {
    super('NOT_FOUND', 'tenant.isolation_violation', `Cross-tenant access to ${entityType}.`, {
      details: { entityType, entityId },
    });
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** Maps a domain error kind to the HTTP status the API layer should emit. */
export function httpStatusForKind(kind: DomainErrorKind): number {
  switch (kind) {
    case 'VALIDATION':
      return 400;
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'ENTITLEMENT_REQUIRED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'PRECONDITION_FAILED':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL':
      return 500;
  }
}
