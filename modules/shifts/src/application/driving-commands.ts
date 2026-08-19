import {
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  type Clock,
  type EventBus,
} from '@aytracker/domain';
import type {
  DriverId,
  OrganizationId,
  PositionId,
  PositionSessionId,
  SiteId,
  VehicleId,
  WorkerId,
} from '@aytracker/types';
import { ELIGIBILITY_ERROR_CODES, type WorkforceQueryService } from '@aytracker/module-workforce';
import { planPositionChange } from '../domain/position-session.js';
import {
  assertCanDrive,
  assertCanEndDriving,
  isDrivingPosition,
  planAssignment,
  selectableVehicles,
  type DrivingContext,
  type SelectableVehicle,
} from '../domain/driving.js';
import type { ShiftUnitOfWork, TransactionRunner } from '../domain/ports.js';

/**
 * The worker → driver handoff.
 *
 * The flow the worker sees:
 *
 *   pick "Шофьор" → pick a vehicle → confirm → they are in the driver portal, trip running
 *
 * What happens underneath, in one transaction:
 *
 *   close the current position session
 *   open a session on the driving position
 *   assign the vehicle (or reuse the assignment they already hold)
 *   open a trip, linked to that session
 *   record TRACKING_STARTED
 *
 * All of it commits together. A half-applied handoff — a worker moved onto the driving position
 * with no trip, or a trip with no session — is the state that makes every downstream number
 * wrong, so it is the state the transaction exists to make impossible.
 */
export class DrivingCommandService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly workforce: WorkforceQueryService,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  /**
   * The vehicle picker's contents.
   *
   * Filtered server-side, like the position picker: a vehicle the worker may not take is never
   * sent. The eligibility of the *position* is checked here too, so this endpoint cannot be used
   * to enumerate the fleet by asking about a driving position the caller cannot occupy.
   */
  async listSelectableVehicles(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    positionId: PositionId;
    siteId: SiteId | null;
  }): Promise<{ driverId: DriverId; vehicles: readonly SelectableVehicle[] }> {
    const now = this.clock.now();

    const decision = await this.workforce.checkEligibility({
      organizationId: input.organizationId,
      workerId: input.workerId,
      positionId: input.positionId,
      now,
    });
    if (!decision.allowed) {
      throw new ForbiddenError(
        ELIGIBILITY_ERROR_CODES[decision.reason],
        `Worker is not eligible for this position (${decision.reason}).`,
        { details: { reason: decision.reason } },
      );
    }

    return this.transactions.run(input.organizationId, async (uow) => {
      const profile = await uow.driving.findDriverForWorker(input.organizationId, input.workerId);
      assertCanDrive(profile, now);

      const vehicles = await uow.driving.listVehiclesForSelection({
        organizationId: input.organizationId,
        driverId: profile.driverId,
        siteId: input.siteId,
      });

      return { driverId: profile.driverId, vehicles: selectableVehicles(vehicles) };
    });
  }

  /**
   * Confirms the handoff.
   *
   * The start coordinates come from the device at the moment the driver confirmed — the same
   * gesture that granted location permission. They are the trip's origin, and the only client
   * values this command accepts; everything else is resolved server-side.
   */
  async beginDriving(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    positionId: PositionId;
    vehicleId: VehicleId;
    label: string | null;
    startLatitude: number | null;
    startLongitude: number | null;
    at: Date;
  }): Promise<DrivingContext> {
    const decision = await this.workforce.checkEligibility({
      organizationId: input.organizationId,
      workerId: input.workerId,
      positionId: input.positionId,
      now: input.at,
    });
    if (!decision.allowed) {
      throw new ForbiddenError(
        ELIGIBILITY_ERROR_CODES[decision.reason],
        `Worker is not eligible for this position (${decision.reason}).`,
        { details: { reason: decision.reason } },
      );
    }
    if (decision.requiresApproval) {
      throw new ForbiddenError(
        'position.supervisor_approval_required',
        'This position requires supervisor approval.',
      );
    }

    const result = await this.transactions.run(input.organizationId, async (uow) => {
      const shift = await uow.shifts.findOpenForWorker(input.organizationId, input.workerId);
      if (!shift) {
        throw new PreconditionFailedError(
          'shift.not_active',
          'The worker does not have a shift in progress.',
        );
      }
      if (shift.status === 'ON_BREAK') {
        throw new PreconditionFailedError(
          'position.change_while_on_break',
          'End the break before changing position.',
        );
      }

      const profile = await uow.driving.findDriverForWorker(input.organizationId, input.workerId);
      assertCanDrive(profile, input.at);

      const context = await uow.driving.loadAssignmentContext({
        organizationId: input.organizationId,
        driverId: profile.driverId,
        vehicleId: input.vehicleId,
      });
      const assignmentPlan = planAssignment(context, profile.driverId);

      // Close whatever the worker was on, and open the driving session.
      const current = await uow.positionSessions.findOpenForShift(input.organizationId, shift.id);
      const plan = planPositionChange({
        currentSession: current,
        targetPositionId: input.positionId,
        at: input.at,
        source: 'MANUAL',
      });
      if (plan.closing) {
        await uow.positionSessions.close({ organizationId: input.organizationId, ...plan.closing });
      }
      const session = await uow.positionSessions.open({
        organizationId: input.organizationId,
        shiftId: shift.id,
        workerId: input.workerId,
        positionId: input.positionId,
        startedAt: input.at,
        source: 'MANUAL',
      });

      if (assignmentPlan.action === 'CREATE') {
        await uow.driving.createAssignment({
          organizationId: input.organizationId,
          driverId: profile.driverId,
          vehicleId: input.vehicleId,
          startedAt: input.at,
          isAutomatic: true,
        });
      }

      const trip = await uow.driving.startTrip({
        organizationId: input.organizationId,
        driverId: profile.driverId,
        vehicleId: input.vehicleId,
        positionSessionId: session.id,
        label: input.label,
        startedAt: input.at,
        startLatitude: input.startLatitude,
        startLongitude: input.startLongitude,
      });

      return {
        driverId: profile.driverId,
        vehicleId: input.vehicleId,
        tripId: trip.tripId,
        positionSessionId: session.id,
        shiftId: shift.id,
        closedSessionId: plan.closing?.sessionId ?? null,
      };
    });

    await this.events.publish({
      name: 'driving.started',
      organizationId: input.organizationId,
      occurredAt: input.at,
      payload: {
        workerId: input.workerId,
        driverId: result.driverId,
        vehicleId: result.vehicleId,
        tripId: result.tripId,
        positionSessionId: result.positionSessionId,
        shiftId: result.shiftId,
      },
    });

    return {
      driverId: result.driverId,
      vehicleId: result.vehicleId,
      tripId: result.tripId,
      positionSessionId: result.positionSessionId,
    };
  }

  /**
   * Closes the driving context attached to a position session, if there is one.
   *
   * Called from inside the transaction of whatever is closing the session — a position change
   * away from driving, or the end of the shift. It is idempotent: a session with no trip, or a
   * trip already closed, returns null rather than failing, so a partially-applied handoff can
   * always be finished.
   */
  static async endDrivingForSession(
    uow: ShiftUnitOfWork,
    input: {
      organizationId: OrganizationId;
      positionSessionId: PositionSessionId;
      at: Date;
    },
  ): Promise<{
    tripId: string;
    driverId: DriverId;
    vehicleId: VehicleId;
    distanceMeters: number;
    durationSeconds: number;
    untrackedSeconds: number;
  } | null> {
    const trip = await uow.driving.findTripForSession(
      input.organizationId,
      input.positionSessionId,
    );
    if (!trip) return null;

    assertCanEndDriving({
      tripStatus: trip.status,
      at: input.at,
      tripStartedAt: trip.startedAt,
    });

    if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED') return null;

    const totals = await uow.driving.closeTrip({
      organizationId: input.organizationId,
      tripId: trip.tripId,
      endedAt: input.at,
    });

    // Only an assignment this flow created is released. A vehicle a fleet manager assigned
    // long-term stays with its driver.
    await uow.driving.closeAutomaticAssignment({
      organizationId: input.organizationId,
      driverId: trip.driverId,
      vehicleId: trip.vehicleId,
      endedAt: input.at,
    });

    return {
      tripId: trip.tripId,
      driverId: trip.driverId,
      vehicleId: trip.vehicleId,
      ...totals,
    };
  }

  /** Whether a position hands the worker a vehicle. Used by the API to route the request. */
  async isDriving(input: {
    organizationId: OrganizationId;
    positionId: PositionId;
  }): Promise<boolean> {
    const rule = await this.workforce.positionRule(input.organizationId, input.positionId);
    if (!rule) throw new NotFoundError('position.not_found', 'Position not found.');
    return isDrivingPosition(rule.kind);
  }
}
