import { ValidationError } from './errors.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

export function normalizePageRequest(input: {
  limit?: number | undefined;
  offset?: number | undefined;
}): PageRequest {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationError(
      'pagination.invalid_limit',
      `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError(
      'pagination.invalid_offset',
      'offset must be a non-negative integer.',
    );
  }
  return { limit, offset };
}
