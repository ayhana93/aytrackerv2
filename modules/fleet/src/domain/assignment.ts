import { ConflictError, ValidationError } from '@aytracker/domain';
import type { DriverId, VehicleId } from '@aytracker/types';

/**
 * Vehicle assignment.
 *
 * One open assignment per vehicle and one per driver. Enforced here for a clear error and by
 * the `vehicle_assignments_one_open_per_*` partial unique indexes for correctness under
 * concurrency. A future shared-vehicle workflow has to drop those indexes deliberately — which
 * is the point: the constraint makes the decision visible instead of accidental.
 */

export interface AssignmentState {
  readonly id: string;
  readonly driverId: DriverId;
  readonly vehicleId: VehicleId;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export function isOpenAssignment(assignment: AssignmentState): boolean {
  return assignment.endedAt === null;
}

export function assertCanAssign(input: {
  vehicleOpenAssignment: AssignmentState | null;
  driverOpenAssignment: AssignmentState | null;
  vehicleStatus: 'ACTIVE' | 'IN_MAINTENANCE' | 'OUT_OF_SERVICE' | 'SOLD' | 'ARCHIVED';
  driverStatus: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
}): void {
  if (input.vehicleStatus !== 'ACTIVE') {
    throw new ConflictError(
      'fleet.vehicle_not_available',
      `Vehicle is ${input.vehicleStatus.toLowerCase().replace('_', ' ')}.`,
      { details: { vehicleStatus: input.vehicleStatus } },
    );
  }
  if (input.driverStatus !== 'ACTIVE') {
    throw new ConflictError('fleet.driver_not_active', 'Driver is not active.', {
      details: { driverStatus: input.driverStatus },
    });
  }
  if (input.vehicleOpenAssignment) {
    throw new ConflictError(
      'fleet.vehicle_already_assigned',
      'This vehicle is already assigned to a driver.',
      { details: { assignmentId: input.vehicleOpenAssignment.id } },
    );
  }
  if (input.driverOpenAssignment) {
    throw new ConflictError('fleet.driver_already_assigned', 'This driver already has a vehicle.', {
      details: { assignmentId: input.driverOpenAssignment.id },
    });
  }
}

export function assertCanUnassign(input: {
  assignment: AssignmentState;
  hasOpenTrip: boolean;
  at: Date;
}): void {
  if (!isOpenAssignment(input.assignment)) {
    throw new ConflictError('fleet.assignment_already_ended', 'This assignment is already closed.');
  }
  if (input.at.getTime() < input.assignment.startedAt.getTime()) {
    throw new ValidationError(
      'fleet.unassign_before_start',
      'An assignment cannot end before it began.',
    );
  }
  if (input.hasOpenTrip) {
    // Unassigning mid-trip would orphan the trip's vehicle reference and leave a driver
    // tracking a vehicle they no longer hold.
    throw new ConflictError(
      'fleet.driver_on_active_trip',
      'End the driver’s active trip before unassigning the vehicle.',
    );
  }
}
