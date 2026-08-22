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

/*
 * Location admission used to live here, keyed on a trip.
 *
 * It is now `admitPoints` in `@aytracker/module-tracking`, keyed on a tracking session — because
 * an employee's working day needs exactly the same rules and is not a trip. One copy, one set of
 * rules, one place a mistake can be made.
 */

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
