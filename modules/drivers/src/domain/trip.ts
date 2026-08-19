import { ConflictError, PreconditionFailedError, ValidationError } from '@aytracker/domain';
import type { DriverId, TripId, VehicleId } from '@aytracker/types';

/**
 * Trip lifecycle.
 *
 * A trip is the unit a driver starts, pauses and ends, and the unit an admin sees on a map. Its
 * derived numbers — distance, duration, untracked time — are always recomputed by the server
 * from stored points; the device never reports them.
 */

export type TripStatus = 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export interface TripState {
  readonly id: TripId;
  readonly driverId: DriverId;
  readonly vehicleId: VehicleId;
  readonly status: TripStatus;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly pausedSeconds: number;
}

const ALLOWED_TRANSITIONS: Readonly<Record<TripStatus, readonly TripStatus[]>> = {
  PLANNED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['ACTIVE', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: TripStatus, to: TripStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: TripStatus, to: TripStatus): void {
  if (!canTransition(from, to)) {
    throw new PreconditionFailedError(
      'trip.invalid_transition',
      `Cannot move a trip from ${from} to ${to}.`,
      { details: { from, to } },
    );
  }
}

export function isTripOpen(status: TripStatus): boolean {
  return status === 'ACTIVE' || status === 'PAUSED';
}

export interface PauseInterval {
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export interface TripTotals {
  /** Wall-clock span from start to end. */
  readonly elapsedSeconds: number;
  /** Time the driver had the trip paused. */
  readonly pausedSeconds: number;
  /** elapsed − paused. What "duration" means on the driver's history screen. */
  readonly durationSeconds: number;
  /** Time the trip was running but no location arrived. Reported, never interpolated over. */
  readonly untrackedSeconds: number;
}

/**
 * Trip totals.
 *
 * `untrackedSeconds` is deliberately a first-class number rather than something hidden in a
 * log: a trip with 19 minutes of missing coverage is a different fact from a fully tracked one,
 * and the admin view says so instead of quietly drawing a straight line across the hole.
 */
export function computeTripTotals(input: {
  startedAt: Date;
  endedAt: Date;
  pauses: readonly PauseInterval[];
  gapSeconds: number;
}): TripTotals {
  const elapsedMs = input.endedAt.getTime() - input.startedAt.getTime();
  if (elapsedMs < 0) {
    throw new ValidationError('trip.end_before_start', 'Trip end must not precede its start.');
  }

  const pausedSeconds = input.pauses.reduce((total, pause) => {
    const end = pause.endedAt ?? input.endedAt;
    const clampedStart = Math.max(pause.startedAt.getTime(), input.startedAt.getTime());
    const clampedEnd = Math.min(end.getTime(), input.endedAt.getTime());
    return total + Math.max(0, Math.round((clampedEnd - clampedStart) / 1000));
  }, 0);

  const elapsedSeconds = Math.round(elapsedMs / 1000);
  return {
    elapsedSeconds,
    pausedSeconds,
    durationSeconds: Math.max(0, elapsedSeconds - pausedSeconds),
    // A gap can never exceed the running time it sits inside.
    untrackedSeconds: Math.min(input.gapSeconds, Math.max(0, elapsedSeconds - pausedSeconds)),
  };
}

/**
 * Validates a location batch before any of it is stored.
 *
 * Rules, and why each exists:
 *   * The trip must be ACTIVE. No location is accepted for a planned, paused, completed or
 *     cancelled trip — "do not collect location when there is no active tracking session" is a
 *     privacy promise, so it is enforced at ingestion rather than trusted to the client.
 *   * Timestamps are clamped into the trip window. A device with a wrong clock cannot write
 *     points into yesterday or tomorrow.
 *   * Batches are size-limited. The ingestion endpoint is the highest-frequency writer in the
 *     system and the most attractive way to try to exhaust it.
 */
export const MAX_LOCATION_BATCH_SIZE = 500;

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

export interface AcceptedLocationPoint extends RawLocationPoint {
  readonly isBackfilled: boolean;
}

export interface LocationBatchResult {
  readonly accepted: readonly AcceptedLocationPoint[];
  readonly rejected: number;
  readonly clamped: number;
}

export function validateLocationBatch(input: {
  trip: TripState;
  points: readonly RawLocationPoint[];
  now: Date;
  /** Points older than this are considered a queued offline replay rather than live data. */
  backfillThresholdSeconds: number;
}): LocationBatchResult {
  if (input.trip.status !== 'ACTIVE') {
    throw new PreconditionFailedError(
      'tracking.trip_not_active',
      'Location can only be recorded for an active trip.',
    );
  }
  if (!input.trip.startedAt) {
    throw new PreconditionFailedError('tracking.trip_not_started', 'This trip has no start time.');
  }
  if (input.points.length === 0) {
    return { accepted: [], rejected: 0, clamped: 0 };
  }
  if (input.points.length > MAX_LOCATION_BATCH_SIZE) {
    throw new ValidationError(
      'tracking.batch_too_large',
      `A batch may contain at most ${MAX_LOCATION_BATCH_SIZE} points.`,
    );
  }

  const windowStart = input.trip.startedAt.getTime();
  const windowEnd = input.now.getTime();

  const accepted: AcceptedLocationPoint[] = [];
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
    if (timestamp.getTime() < windowStart) {
      timestamp = new Date(windowStart);
      clamped += 1;
    } else if (timestamp.getTime() > windowEnd) {
      // A point from the future is a clock-skew artefact, not evidence of anything.
      timestamp = new Date(windowEnd);
      clamped += 1;
    }

    const ageSeconds = (windowEnd - timestamp.getTime()) / 1000;
    accepted.push({
      ...point,
      timestamp,
      isBackfilled: ageSeconds > input.backfillThresholdSeconds,
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

/**
 * Guards the "never duplicate a trip start" rule for offline replays.
 *
 * The idempotency ledger is the primary defence; this is the domain-level statement of the same
 * rule, so a caller that bypasses the HTTP layer still cannot open a second trip.
 */
export function assertNoOpenTrip(existing: TripState | null): void {
  if (existing && isTripOpen(existing.status)) {
    throw new ConflictError('trip.already_active', 'This driver already has a trip in progress.', {
      details: { tripId: existing.id, status: existing.status },
    });
  }
}
