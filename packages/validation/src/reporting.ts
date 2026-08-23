import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from './primitives.js';

/**
 * Query parameters for the reporting endpoints.
 *
 * These exist because `request.query as { from?: string }` is a cast, not a check. Under it,
 * `?from=yesterday` produced a `Date` whose time was `NaN` and the range resolver quietly
 * substituted "the last 24 hours" — so a mistyped or mis-encoded date came back as a confident
 * report about a period nobody asked for. `?limit=abc` was worse: `Number('abc')` reached Prisma
 * as `take: NaN` and the request failed as a 500, blaming the server for the client's typo.
 *
 * A malformed parameter is a client error. It gets a 400 naming the field, and no report.
 *
 * The **defaults** are a different matter and stay: an absent `from` legitimately means "the
 * usual window for this screen", and each endpoint decides what that is. Absent is not malformed.
 */

/**
 * `to` before `from` is refused rather than normalised.
 *
 * It is always a client bug, and an empty report is indistinguishable from "nothing happened" —
 * the wrong answer to give someone checking a payslip against it.
 */
const orderedRange = (value: { from?: Date | undefined; to?: Date | undefined }): boolean =>
  !value.from || !value.to || value.from.getTime() <= value.to.getTime();

const RANGE_MESSAGE = { message: 'Range start must not be after its end', path: ['from'] };

const rangeShape = {
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
};

/**
 * A page size the caller may choose, within a ceiling the caller may not.
 *
 * The ceiling belongs to the endpoint, because "how many rows is too many" depends on how wide
 * they are. Coerced from the string a query parameter always is, and rejected — never clamped —
 * when it is not a number: a client asking for `limit=abc` has a bug, and quietly serving the
 * default hides it.
 */
export function limitSchema(defaultValue: number, max: number) {
  return z.coerce.number().int().min(1).max(max).default(defaultValue);
}

/** A reporting window and nothing else — `GET /admin/dashboard`, geofence visits. */
export const rangeOnlyQuerySchema = z.object(rangeShape).refine(orderedRange, RANGE_MESSAGE);

/** `GET /admin/history` — a window, optional filters, and a page size. */
export const workHistoryQuerySchema = z
  .object({
    ...rangeShape,
    workerId: uuidSchema.optional(),
    workAreaId: uuidSchema.optional(),
    limit: limitSchema(250, 1000),
  })
  .refine(orderedRange, RANGE_MESSAGE);

/** `GET /admin/trips` — every trip in the organization. */
export const tripListQuerySchema = z
  .object({ ...rangeShape, limit: limitSchema(100, 500) })
  .refine(orderedRange, RANGE_MESSAGE);

/** `GET /driver/trips` — one driver's own history, so a smaller page. */
export const driverTripListQuerySchema = z
  .object({ ...rangeShape, limit: limitSchema(50, 200) })
  .refine(orderedRange, RANGE_MESSAGE);
