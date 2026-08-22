import { ConflictError, PreconditionFailedError } from '@aytracker/domain';
import type { DriverId, OrganizationId, VehicleId, WorkerId } from '@aytracker/types';

/**
 * Tracking sessions — the domain of "when may this device report, and what for".
 *
 * Everything here is a pure decision over loaded data. The transactions that act on these
 * decisions live in the application service, and the SQL lives in infrastructure.
 *
 * The whole module exists to make one rule structural rather than promised: **a location point
 * cannot exist without an open session, and a session cannot exist without a shift or a trip.**
 * There is no code path, and no row shape, that represents location collected outside authorised
 * working time.
 */

export type TrackingContext = 'WORK' | 'DRIVER_TRIP';

export type TrackingSessionId = string & { readonly __brand: 'TrackingSessionId' };

/** What the device last said about itself. An observation, never an accusation. */
export type DevicePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface TrackingSessionState {
  readonly id: TrackingSessionId;
  readonly organizationId: OrganizationId;
  readonly context: TrackingContext;
  readonly workerId: WorkerId | null;
  readonly driverId: DriverId | null;
  readonly shiftId: string | null;
  readonly tripId: string | null;
  readonly vehicleId: VehicleId | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly distanceMeters: number;
  readonly untrackedSeconds: number;
  readonly trackingState: string;
  readonly lastPointAt: Date | null;
}

export function isOpen(session: TrackingSessionState): boolean {
  return session.endedAt === null;
}

/**
 * A session may only be opened once for its subject.
 *
 * Checked here for the message; decided by `tracking_sessions_one_open_work_per_worker` and its
 * driver counterpart when two devices race. A worker who left their phone at one terminal and
 * signed in at another must not end up with two streams, because the second one would silently
 * halve the day's distance between them.
 */
export function assertNoOpenSession(existing: TrackingSessionState | null): void {
  if (!existing) return;
  throw new ConflictError(
    existing.context === 'WORK'
      ? 'tracking.work_session_already_open'
      : 'tracking.trip_session_already_open',
    'A tracking session is already open for this subject.',
  );
}

export function assertSessionOpen(
  session: TrackingSessionState | null,
): asserts session is TrackingSessionState {
  if (!session) {
    throw new PreconditionFailedError(
      'tracking.no_open_session',
      'There is no open tracking session to record against.',
    );
  }
  if (session.endedAt !== null) {
    throw new PreconditionFailedError(
      'tracking.session_closed',
      'This tracking session has already been closed.',
    );
  }
}

export function assertCloseAfterStart(session: TrackingSessionState, at: Date): void {
  if (at.getTime() < session.startedAt.getTime()) {
    throw new PreconditionFailedError(
      'tracking.end_before_start',
      'A tracking session cannot end before it began.',
    );
  }
}

/**
 * Which trip, if any, a fix taken at this moment belongs to.
 *
 * This is the whole of "one stream, two contexts". A worker's phone reports once; the point is
 * stored once, owned by the working day's session, and additionally tagged with the trip when
 * the fix falls inside the trip's window. The day's route and the trip's route are then two
 * readings of the same rows rather than two copies of them — which is what keeps a driver's
 * kilometres from being counted twice in a cost report.
 *
 * The window is half-open at the end so a point taken at the exact instant a trip closed is not
 * claimed by a trip that is no longer running.
 */
export function tripForTimestamp(
  timestamp: Date,
  trip: {
    readonly id: string;
    readonly startedAt: Date | null;
    readonly endedAt: Date | null;
  } | null,
): string | null {
  if (!trip?.startedAt) return null;
  const at = timestamp.getTime();
  if (at < trip.startedAt.getTime()) return null;
  if (trip.endedAt !== null && at >= trip.endedAt.getTime()) return null;
  return trip.id;
}

/**
 * Device telemetry worth recording.
 *
 * Collected because it changes what the system should do or explains what it saw — not because
 * a phone happens to expose it. Battery decides the sampling interval; a revoked permission is
 * the difference between "we do not know where this van is" and an accusation nobody can
 * support. Anything that fails neither test is not collected.
 */
export interface DeviceTelemetry {
  /** 0…1. Below the policy's threshold the device is asked to sample less often. */
  readonly batteryLevel: number | null;
  readonly isCharging: boolean | null;
  readonly permission: DevicePermission | null;
}

export function normalizeTelemetry(input: Partial<DeviceTelemetry> | null): DeviceTelemetry {
  const level = input?.batteryLevel ?? null;
  return {
    // A device reporting 1.4 or -0.2 is reporting a bug. Dropped rather than clamped: a wrong
    // battery level would move the sampling interval for a reason nobody could reconstruct.
    batteryLevel:
      level !== null && Number.isFinite(level) && level >= 0 && level <= 1 ? level : null,
    isCharging: input?.isCharging ?? null,
    permission: input?.permission ?? null,
  };
}
