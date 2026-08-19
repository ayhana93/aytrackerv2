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

export const startTripSchema = z.object({
  clientActionId: clientActionIdSchema,
  label: z.string().trim().max(160).nullable().default(null),
  startLatitude: latitudeSchema.nullable().default(null),
  startLongitude: longitudeSchema.nullable().default(null),
  startOdometer: nonNegativeDecimalStringSchema.nullable().default(null),
  occurredAt: isoDateTimeSchema.optional(),
});

export const tripActionSchema = z.object({
  clientActionId: clientActionIdSchema,
  occurredAt: isoDateTimeSchema.optional(),
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
export const submitLocationsSchema = z.object({
  clientActionId: clientActionIdSchema,
  tripId: uuidSchema,
  points: z.array(locationPointSchema).min(1).max(500),
  deviceReported: z.enum(['ONLINE', 'OFFLINE', 'PERMISSION_DENIED']).nullable().default(null),
  batteryLevel: z.number().min(0).max(1).nullable().default(null),
});

export type StartTripRequest = z.infer<typeof startTripSchema>;
export type SubmitLocationsRequest = z.infer<typeof submitLocationsSchema>;
