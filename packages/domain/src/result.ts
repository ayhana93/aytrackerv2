import type { DomainError } from './errors.js';

/**
 * Result type for operations whose failure is an expected business outcome rather than a bug.
 *
 * Used where a caller must branch (e.g. "is this worker eligible for this position?").
 * Genuinely exceptional situations still throw — see docs/architecture.md § error handling.
 */
export type Result<T, E extends DomainError = DomainError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends DomainError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E extends DomainError>(
  result: Result<T, E>,
): result is { ok: true; value: T } {
  return result.ok;
}

/** Unwraps a result, throwing the contained error. Use at the boundary, not inside logic. */
export function unwrap<T, E extends DomainError>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}
