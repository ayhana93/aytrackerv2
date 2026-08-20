import { z } from 'zod';
import { clientActionIdSchema, isoDateTimeSchema, uuidSchema } from './primitives.js';

/**
 * Worker portal command schemas.
 *
 * Every mutation carries a `clientActionId` so an offline replay is idempotent, and an optional
 * `occurredAt` so an action queued at 09:14 and synced at 11:02 is recorded at 09:14. The
 * server clamps that timestamp into a plausible window — see `reconcileClientTimestamp` — so a
 * device with a wrong clock cannot backdate work.
 *
 * There is no `workerId` field anywhere here. That is not an oversight.
 */

export const startShiftSchema = z.object({
  clientActionId: clientActionIdSchema,
  siteId: uuidSchema,
  shiftTypeId: uuidSchema.nullable().default(null),
  initialPositionId: uuidSchema.nullable().default(null),
  occurredAt: isoDateTimeSchema.optional(),
});

export const endShiftSchema = z.object({
  clientActionId: clientActionIdSchema,
  occurredAt: isoDateTimeSchema.optional(),
});

export const startBreakSchema = z.object({
  clientActionId: clientActionIdSchema,
  type: z.enum(['PAID', 'UNPAID', 'MEAL', 'TECHNICAL']).default('UNPAID'),
  occurredAt: isoDateTimeSchema.optional(),
});

export const endBreakSchema = z.object({
  clientActionId: clientActionIdSchema,
  occurredAt: isoDateTimeSchema.optional(),
});

/**
 * Position change.
 *
 * Either a position id (tapped in the picker) or a QR token (scanned at the machine). The QR
 * token is an addressing convenience — the server runs the identical eligibility check for
 * both, which is why the union is safe.
 */
export const changePositionSchema = z
  .object({
    clientActionId: clientActionIdSchema,
    positionId: uuidSchema.optional(),
    qrToken: z.string().trim().min(8).max(128).optional(),
    occurredAt: isoDateTimeSchema.optional(),
  })
  .refine(
    (value) => Boolean(value.positionId) !== Boolean(value.qrToken),
    'Provide exactly one of positionId or qrToken',
  );

export const recordProductionSchema = z.object({
  clientActionId: clientActionIdSchema,
  productTemplateId: uuidSchema.nullable().default(null),
  goodQuantity: z.number().nonnegative().finite(),
  defectQuantity: z.number().nonnegative().finite().default(0),
  notes: z.string().trim().max(500).optional(),
  occurredAt: isoDateTimeSchema.optional(),
});

/** Supervisor correction. Requires `shifts.correct`; the reason is mandatory and audited. */
export const correctPositionSessionSchema = z
  .object({
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema.nullable(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (value) => value.endedAt === null || value.endedAt.getTime() >= value.startedAt.getTime(),
    { message: 'End must not precede start', path: ['endedAt'] },
  );

/**
 * Offline sync envelope.
 *
 * A batch of queued actions replayed in order. Each carries its own idempotency key, so a
 * partially applied batch can be retried whole without duplicating what already landed.
 */
export const syncBatchSchema = z.object({
  actions: z
    .array(
      z.object({
        clientActionId: clientActionIdSchema,
        endpoint: z.string().trim().min(1).max(120),
        occurredAt: isoDateTimeSchema,
        payload: z.record(z.unknown()),
      }),
    )
    .min(1)
    .max(100),
});

export type StartShiftRequest = z.infer<typeof startShiftSchema>;
export type ChangePositionRequest = z.infer<typeof changePositionSchema>;
export type SyncBatchRequest = z.infer<typeof syncBatchSchema>;

/**
 * Confirming a move onto a DRIVING position.
 *
 * Separate from `changePositionSchema` because the shape genuinely differs: this one carries a
 * vehicle and the coordinates where the trip begins. Folding both into one schema with optional
 * fields would let a client omit the vehicle on a driving position and reach a half-formed
 * handoff, which the server would then have to reject anyway.
 *
 * The start coordinates are the only client-supplied values the command accepts. They come from
 * the same gesture that granted location permission, and the server clamps them into the trip
 * window like any other point.
 */
export const beginDrivingSchema = z.object({
  clientActionId: clientActionIdSchema,
  positionId: uuidSchema,
  vehicleId: uuidSchema,
  label: z.string().trim().max(160).nullable().default(null),
  startLatitude: z.number().gte(-90).lte(90).nullable().default(null),
  startLongitude: z.number().gte(-180).lte(180).nullable().default(null),
  occurredAt: isoDateTimeSchema.optional(),
});

export type BeginDrivingRequest = z.infer<typeof beginDrivingSchema>;
