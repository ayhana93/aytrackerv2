import { ConflictError, ForbiddenError, PreconditionFailedError } from '@aytracker/domain';
import type { DriverId, PositionSessionId, TripId, VehicleId, WorkerId } from '@aytracker/types';

/**
 * The worker → driver handoff.
 *
 * A worker selects the position "Шофьор", picks a vehicle, and lands in the driver portal with a
 * trip already recording. Underneath, three things must become true together or none of them:
 * the position session moves, the vehicle is assigned, and the trip opens.
 *
 * Everything here is a pure decision over loaded data. The transaction that acts on these
 * decisions lives in the application service.
 */

export type PositionKind = 'STANDARD' | 'DRIVING';

export function isDrivingPosition(kind: PositionKind): boolean {
  return kind === 'DRIVING';
}

export interface DriverProfile {
  readonly driverId: DriverId;
  readonly workerId: WorkerId;
  readonly status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  readonly licenseExpiresAt: Date | null;
}

export interface SelectableVehicle {
  readonly vehicleId: VehicleId;
  readonly registrationNumber: string;
  readonly make: string;
  readonly model: string;
  readonly vehicleType: string;
  readonly fuelType: string;
  readonly odometer: string;
  readonly status: 'ACTIVE' | 'IN_MAINTENANCE' | 'OUT_OF_SERVICE' | 'SOLD' | 'ARCHIVED';
  /** The driver holding an open assignment on this vehicle, if any. */
  readonly assignedToDriverId: DriverId | null;
  /** True when that open assignment is this driver's own — the vehicle is already theirs. */
  readonly assignedToSelf: boolean;
}

/**
 * A worker may only take a vehicle if they *are* a driver.
 *
 * The link is `Driver.workerId`. Requiring it rather than creating a driver profile on the fly
 * is deliberate: a driver record carries a licence number and expiry, and conjuring one because
 * somebody tapped a position would put an unlicensed person behind a company vehicle with the
 * system's blessing.
 */
export function assertCanDrive(
  profile: DriverProfile | null,
  now: Date,
): asserts profile is DriverProfile {
  if (!profile) {
    throw new ForbiddenError(
      'driving.no_driver_profile',
      'This worker is not registered as a driver.',
    );
  }
  if (profile.status !== 'ACTIVE') {
    throw new ForbiddenError('driving.driver_not_active', 'This driver profile is not active.', {
      details: { status: profile.status },
    });
  }
  if (profile.licenseExpiresAt && profile.licenseExpiresAt.getTime() <= now.getTime()) {
    // A hard stop rather than a warning. An expired licence is the fleet manager's problem to
    // fix before the vehicle moves, not something to note in a report afterwards.
    throw new ForbiddenError('driving.license_expired', 'This driver’s licence has expired.', {
      details: { expiredAt: profile.licenseExpiresAt.toISOString() },
    });
  }
}

/** Vehicles offered in the picker: usable, and not held by someone else. */
export function selectableVehicles(
  vehicles: readonly SelectableVehicle[],
): readonly SelectableVehicle[] {
  return (
    vehicles
      .filter((vehicle) => vehicle.status === 'ACTIVE')
      .filter((vehicle) => vehicle.assignedToDriverId === null || vehicle.assignedToSelf)
      // The driver's own vehicle first — on most mornings it is the one they want, and putting it
      // at the top turns the picker into a confirmation.
      .sort((a, b) => {
        if (a.assignedToSelf !== b.assignedToSelf) return a.assignedToSelf ? -1 : 1;
        return a.registrationNumber.localeCompare(b.registrationNumber);
      })
  );
}

export type AssignmentPlan =
  /** The driver already holds this vehicle. Nothing to create, nothing to close later. */
  | { readonly action: 'REUSE'; readonly assignmentId: string }
  /** Create an assignment for this shift, and close it when the driving position is left. */
  | { readonly action: 'CREATE' };

export interface AssignmentContext {
  readonly vehicle: SelectableVehicle;
  /** The open assignment on this vehicle, if any. */
  readonly vehicleAssignment: { id: string; driverId: DriverId } | null;
  /** The driver's own open assignment, if any. */
  readonly driverAssignment: { id: string; vehicleId: VehicleId } | null;
}

/**
 * Decides what to do about the vehicle assignment.
 *
 * The conflicts are refusals, not silent fixes. Quietly taking a vehicle from another driver, or
 * quietly dropping the one this driver already holds, are both the kind of "helpful" behaviour
 * that loses a vehicle at 06:00 and costs someone an hour working out why.
 */
export function planAssignment(context: AssignmentContext, driverId: DriverId): AssignmentPlan {
  const { vehicle, vehicleAssignment, driverAssignment } = context;

  if (vehicle.status !== 'ACTIVE') {
    throw new ConflictError(
      'driving.vehicle_not_available',
      `Vehicle is ${vehicle.status.toLowerCase().replace(/_/g, ' ')}.`,
      { details: { vehicleId: vehicle.vehicleId, status: vehicle.status } },
    );
  }

  if (vehicleAssignment && vehicleAssignment.driverId !== driverId) {
    throw new ConflictError(
      'driving.vehicle_taken',
      'This vehicle is currently assigned to another driver.',
    );
  }

  if (driverAssignment && driverAssignment.vehicleId !== vehicle.vehicleId) {
    throw new ConflictError(
      'driving.already_holds_vehicle',
      'This driver already holds a different vehicle.',
      { details: { heldVehicleId: driverAssignment.vehicleId } },
    );
  }

  return vehicleAssignment
    ? { action: 'REUSE', assignmentId: vehicleAssignment.id }
    : { action: 'CREATE' };
}

export interface DrivingContext {
  readonly driverId: DriverId;
  readonly vehicleId: VehicleId;
  readonly tripId: TripId;
  readonly positionSessionId: PositionSessionId;
}

/**
 * Guards the reverse direction: leaving a driving position, or ending the shift.
 *
 * The open trip must close with the session. A worker recorded at Machine 2 with a trip still
 * running is a state that makes every downstream number — position utilization, trip distance,
 * cost per km — quietly wrong.
 */
export function assertCanEndDriving(input: {
  tripStatus: 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  at: Date;
  tripStartedAt: Date | null;
}): void {
  if (input.tripStatus === 'COMPLETED' || input.tripStatus === 'CANCELLED') {
    // Already closed — the caller is finishing a partially-applied handoff, which is fine.
    return;
  }
  if (!input.tripStartedAt) {
    throw new PreconditionFailedError('driving.trip_not_started', 'This trip has no start time.');
  }
  if (input.at.getTime() < input.tripStartedAt.getTime()) {
    throw new PreconditionFailedError(
      'driving.end_before_start',
      'A trip cannot end before it began.',
    );
  }
}

/**
 * Permissions a worker session gains while driving.
 *
 * Scoped to the open driving session and removed when it closes. The alternative — issuing a
 * second, DRIVER session — would leave two live sessions for one person and two places to
 * revoke; and inventing a fourth actor type would touch every guard in the codebase to express
 * something that is really just "this worker is currently driving".
 */
export const DRIVING_SESSION_PERMISSIONS: readonly string[] = [
  'driver.portal.access',
  'driver.trip.start',
  'driver.trip.stop',
  'driver.location.submit',
  /*
   * `tracking.submit` is deliberately NOT in this list.
   *
   * The list is symmetric: whatever elevation adds, leaving the driving position removes. A
   * worker already holds `tracking.submit` from their own role — it is what lets their working
   * day be recorded at all — so adding it here would mean stripping it the moment they parked,
   * and the rest of their shift would go untracked. A driver-only session gets it from the
   * driver role instead.
   */
  'driver.trip.history',
  'driver.vehicle.view',
];

export function withDrivingPermissions(base: readonly string[]): readonly string[] {
  return [...new Set([...base, ...DRIVING_SESSION_PERMISSIONS])].sort();
}

export function withoutDrivingPermissions(base: readonly string[]): readonly string[] {
  const driving = new Set(DRIVING_SESSION_PERMISSIONS);
  return base.filter((permission) => !driving.has(permission));
}
