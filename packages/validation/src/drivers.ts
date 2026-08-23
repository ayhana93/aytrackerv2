import { z } from 'zod';
import {
  clientActionIdSchema,
  isoDateTimeSchema,
  latitudeSchema,
  longitudeSchema,
  nonNegativeDecimalStringSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Driver portal schemas.
 *
 * No `driverId` and no `vehicleId` on trip start: the driver comes from the session and the
 * vehicle from the current assignment. A driver cannot start a trip on a vehicle they do not
 * hold, however the request is constructed.
 */

/**
 * Starting a trip.
 *
 * `label` and `plannedDistanceKm` are the route, and both are optional. A driver who has to
 * leave now presses one button; a dispatcher who knows the run declares it and the trip is then
 * measured against what was planned. Neither is a precondition for recording.
 *
 * The planned distance is refused without a label, because a number with no route attached is
 * a figure nobody can check later.
 */
export const startTripSchema = z
  .object({
    clientActionId: clientActionIdSchema,
    label: z.string().trim().max(160).nullable().default(null),
    /** Kilometres, as typed. Converted to metres by the route — the domain stores metres. */
    plannedDistanceKm: z.number().positive().max(20_000).nullable().default(null),
    /**
     * The vehicle the driver picked.
     *
     * Only consulted when the driver holds no assignment. It is a choice from a list the server
     * produced, not an instruction: a vehicle the driver may not take is refused here exactly as
     * it would be if they had never been shown it.
     */
    vehicleId: uuidSchema.nullable().default(null),
    startLatitude: latitudeSchema.nullable().default(null),
    startLongitude: longitudeSchema.nullable().default(null),
    startOdometer: nonNegativeDecimalStringSchema.nullable().default(null),
    occurredAt: isoDateTimeSchema.optional(),
  })
  .refine((value) => value.plannedDistanceKm === null || Boolean(value.label), {
    message: 'A planned distance needs a route to belong to',
    path: ['plannedDistanceKm'],
  });

export const endTripSchema = z.object({
  clientActionId: clientActionIdSchema,
  endLatitude: latitudeSchema.nullable().default(null),
  endLongitude: longitudeSchema.nullable().default(null),
  endOdometer: nonNegativeDecimalStringSchema.nullable().default(null),
  occurredAt: isoDateTimeSchema.optional(),
});

/**
 * One GPS sample.
 *
 * `speedMps` is capped at 150 m/s (540 km/h) — beyond that the reading is a sensor artefact,
 * not a vehicle. Accuracy is required to be non-negative so the distance filter can rely on it.
 */
export const locationPointSchema = z.object({
  timestamp: isoDateTimeSchema,
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracyMeters: z.number().nonnegative().max(10_000).nullable().default(null),
  speedMps: z.number().min(0).max(150).nullable().default(null),
  heading: z.number().min(0).max(360).nullable().default(null),
  altitude: z.number().min(-500).max(10_000).nullable().default(null),
  source: z.enum(['GPS', 'NETWORK', 'FUSED', 'MANUAL']).default('GPS'),
});

/**
 * A location batch.
 *
 * Capped at 500 points: enough for a long offline stretch replayed at the configured sampling
 * floor, small enough that a single request cannot be used to flood the table.
 *
 * `deviceReported` is the device telling us about itself. It is recorded as an observation and
 * never as proof of intent — "permission not granted" is a fact about the device, not an
 * accusation about the driver.
 */
/**
 * A batch from a device, for either context.
 *
 * There is no session id and no trip id: the server resolves both from the authenticated actor
 * and from each point's timestamp. A client naming its own session would be a client choosing
 * where its data lands.
 *
 * The telemetry fields are here because they change what the system does — battery decides the
 * sampling interval, and a reported permission state explains silence that would otherwise look
 * like a driver hiding. Nothing is collected merely because a phone exposes it.
 */
export const submitTrackingPointsSchema = z.object({
  clientActionId: clientActionIdSchema,
  points: z.array(locationPointSchema).min(1).max(500),
  deviceReported: z.enum(['ONLINE', 'OFFLINE', 'PERMISSION_DENIED']).nullable().default(null),
  batteryLevel: z.number().min(0).max(1).nullable().default(null),
  isCharging: z.boolean().nullable().default(null),
  permission: z.enum(['granted', 'denied', 'prompt', 'unknown']).nullable().default(null),
});

export type SubmitTrackingPointsRequest = z.infer<typeof submitTrackingPointsSchema>;

/*
 * There is no trip-scoped submission shape any more.
 *
 * A body carrying a `tripId` invited the client to say which trip its points belonged to, and the
 * server has never accepted that answer — the trip is decided per point from the timestamp. The
 * field's only remaining effect was to make a second ingestion route look reasonable.
 */

export type StartTripRequest = z.infer<typeof startTripSchema>;
