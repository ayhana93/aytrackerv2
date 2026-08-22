import { ValidationError } from '@aytracker/domain';
import { assertSessionOpen, tripForTimestamp, type TrackingSessionState } from './session.js';

/**
 * Server-side admission: what a device is allowed to add to the record.
 *
 * This runs on every batch from every device, and it is the reason a client cannot change any
 * number that matters. A phone may report where it thinks it is; it may not report how far it
 * went, when the session started, or which trip a fix belongs to. Those are decided here.
 *
 * The rules, and why each exists:
 *
 *   * **The session must be open.** No point is stored against a closed or missing session —
 *     "no collection outside an authorised context" is a privacy promise, so it is enforced at
 *     ingestion rather than trusted to the client that made the promise.
 *   * **Timestamps outside the session window are refused, not moved.** A device with a wrong
 *     clock cannot write points into yesterday, or into a shift that has not started. Only skew
 *     small enough to be a clock artefact is corrected; anything further out is dropped, because
 *     a fix dragged to a time the device never claimed is a fabricated fix.
 *   * **Coordinates are validated.** A malformed pair is dropped rather than stored and filtered
 *     later, because a NaN in a Decimal column outlives every reader that would have to guard
 *     against it.
 *   * **Batches are size-limited.** This is the highest-frequency writer in the system and the
 *     most attractive way to try to exhaust it.
 *   * **The trip is decided from the timestamp**, not from the request. A client that names a
 *     trip it is not on gains nothing.
 */

export const MAX_LOCATION_BATCH_SIZE = 500;

/**
 * How far a fix may sit outside the session window and still be treated as a clock artefact.
 *
 * Phone clocks drift, and a fix acquired in the second before the shift record was written can
 * legitimately carry a timestamp a moment before the session began. Two minutes covers that.
 *
 * It deliberately does not cover more. A point an hour in the future, or from a shift that ended
 * yesterday, is not evidence about this session: pulling it to the nearest edge of the window
 * would place the employee somewhere they were not, at a time they were not there, and the
 * distance and the route would then both be wrong. Such a point is dropped and counted, so the
 * response says how many were refused instead of quietly inventing them.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 120;

export interface RawLocationPoint {
  readonly timestamp: Date;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters?: number | null;
  readonly speedMps?: number | null;
  readonly heading?: number | null;
  readonly altitude?: number | null;
  readonly source?: string;
}

export interface AdmittedLocationPoint extends RawLocationPoint {
  readonly timestamp: Date;
  readonly isBackfilled: boolean;
  /** Set when the fix fell inside a running trip. The overlay, decided server-side. */
  readonly tripId: string | null;
}

export interface AdmissionResult {
  readonly accepted: readonly AdmittedLocationPoint[];
  readonly rejected: number;
  readonly clamped: number;
}

export interface TripWindow {
  readonly id: string;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

export function admitPoints(input: {
  session: TrackingSessionState | null;
  points: readonly RawLocationPoint[];
  /** The trip running inside this session, if any. Resolved by the caller from the database. */
  trip: TripWindow | null;
  now: Date;
  /** Points older than this are a queued offline replay rather than live data. */
  backfillThresholdSeconds: number;
}): AdmissionResult {
  assertSessionOpen(input.session);
  const session = input.session;

  if (input.points.length === 0) return { accepted: [], rejected: 0, clamped: 0 };
  if (input.points.length > MAX_LOCATION_BATCH_SIZE) {
    throw new ValidationError(
      'tracking.batch_too_large',
      `A batch may contain at most ${MAX_LOCATION_BATCH_SIZE} points.`,
    );
  }

  const windowStart = session.startedAt.getTime();
  const windowEnd = input.now.getTime();
  const tolerance = CLOCK_SKEW_TOLERANCE_SECONDS * 1000;

  const accepted: AdmittedLocationPoint[] = [];
  let rejected = 0;
  let clamped = 0;

  for (const point of input.points) {
    if (!isValidCoordinate(point.latitude, point.longitude)) {
      rejected += 1;
      continue;
    }
    if (
      point.accuracyMeters !== undefined &&
      point.accuracyMeters !== null &&
      point.accuracyMeters < 0
    ) {
      rejected += 1;
      continue;
    }

    let timestamp = point.timestamp;
    const at = timestamp.getTime();
    if (at < windowStart - tolerance || at > windowEnd + tolerance) {
      // Too far out to be clock drift: this fix is not evidence about this session.
      rejected += 1;
      continue;
    }
    if (at < windowStart) {
      timestamp = new Date(windowStart);
      clamped += 1;
    } else if (at > windowEnd) {
      timestamp = new Date(windowEnd);
      clamped += 1;
    }

    const ageSeconds = (windowEnd - timestamp.getTime()) / 1000;
    accepted.push({
      ...point,
      timestamp,
      isBackfilled: ageSeconds > input.backfillThresholdSeconds,
      tripId: tripForTimestamp(timestamp, input.trip),
    });
  }

  return { accepted, rejected, clamped };
}

export function isValidCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}
