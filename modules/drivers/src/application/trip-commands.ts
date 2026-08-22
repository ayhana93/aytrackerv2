import {
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  type Clock,
  type EventBus,
} from '@aytracker/domain';
import type { DriverId, OrganizationId, TripId, VehicleId } from '@aytracker/types';
import {
  computeTrackDistance,
  deriveTrackingState,
  eventForTransition,
  findTrackingGaps,
  totalGapSeconds,
  type TrackingState,
} from '@aytracker/tracking';
import {
  assertNoOpenTrip,
  assertTransition,
  computeTripTotals,
  validateLocationBatch,
  type RawLocationPoint,
  type TripState,
} from '../domain/trip.js';
import type {
  DriverTransactionRunner,
  DriverVehicleAccess,
  DriverUnitOfWork,
} from '../domain/ports.js';

/**
 * Driver trip commands.
 *
 * The driver's identity always comes from the session. There is no `driverId` parameter a
 * client could set to another driver — `assertOwnDriver` at the route plus session-derived ids
 * here mean the "driver cannot see another driver's route" test has two independent reasons to
 * pass.
 */
export class TripCommandService {
  constructor(
    private readonly transactions: DriverTransactionRunner,
    private readonly vehicles: DriverVehicleAccess,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  /**
   * Starts a trip on the vehicle currently assigned to the driver.
   *
   * The vehicle is resolved server-side from the assignment table. A driver cannot start a trip
   * on a vehicle they are not assigned to, whatever the request body says.
   *
   * `label` and `plannedDistanceMeters` are the route, and both are optional. A trip with
   * neither is a perfectly ordinary trip — the vehicle went out and came back, and the record of
   * where it went is the track itself. Requiring a route to be declared first would mean a
   * driver who has to leave now either invents one or drives untracked, and the second of those
   * is what actually happens.
   */
  async startTrip(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    label: string | null;
    plannedDistanceMeters: number | null;
    /**
     * The vehicle the driver picked, when they hold none already.
     *
     * Ignored when an assignment exists — a driver who has been given a van by their fleet
     * manager drives that van, and a vehicle id in a request body has never been allowed to
     * override an assignment on the server.
     */
    requestedVehicleId: VehicleId | null;
    startLatitude: number | null;
    startLongitude: number | null;
    startOdometer: string | null;
    at: Date;
  }): Promise<{ tripId: TripId; vehicleId: string }> {
    const assigned = await this.vehicles.currentVehicleId(input.organizationId, input.driverId);

    /**
     * Picking the vehicle is part of starting the trip.
     *
     * The alternative — a separate "take a vehicle" step that persists between trips — leaves
     * vans assigned to drivers who went home, and the next person to need one finds it held by
     * somebody who is not in the building. Claiming at the start and releasing at the end means
     * a vehicle is only ever held while it is genuinely out.
     */
    let vehicleId = assigned;
    if (!vehicleId) {
      if (!input.requestedVehicleId) {
        throw new PreconditionFailedError(
          'trip.no_vehicle_assigned',
          'No vehicle is currently assigned to this driver, and none was chosen.',
        );
      }
      /**
       * Refuse an already-running trip *before* taking a vehicle for it.
       *
       * The transaction below checks this too, and the partial unique index decides it under
       * concurrency. This earlier read exists only so a driver whose trip is already running
       * does not end up holding a second van that no command will ever hand back.
       */
      assertNoOpenTrip(
        await this.transactions.run(input.organizationId, (uow) =>
          uow.trips.findOpenForDriver(input.organizationId, input.driverId),
        ),
      );
      await this.vehicles.claimForTrip({
        organizationId: input.organizationId,
        driverId: input.driverId,
        vehicleId: input.requestedVehicleId,
        at: input.at,
      });
      vehicleId = input.requestedVehicleId;
    }

    const result = await this.transactions.run(input.organizationId, async (uow) => {
      const existing = await uow.trips.findOpenForDriver(input.organizationId, input.driverId);
      assertNoOpenTrip(existing);

      const trip = await uow.trips.create({
        organizationId: input.organizationId,
        driverId: input.driverId,
        vehicleId,
        label: input.label,
        plannedDistanceMeters: input.plannedDistanceMeters,
        startedAt: input.at,
        startLatitude: input.startLatitude,
        startLongitude: input.startLongitude,
        startOdometer: input.startOdometer,
      });

      await uow.trackingEvents.record({
        organizationId: input.organizationId,
        tripId: trip.id,
        type: 'TRACKING_STARTED',
        state: 'ACTIVE',
        occurredAt: input.at,
        lastLatitude: input.startLatitude,
        lastLongitude: input.startLongitude,
      });

      return { tripId: trip.id };
    });

    await this.events.publish({
      name: 'trip.started',
      organizationId: input.organizationId,
      occurredAt: input.at,
      payload: { tripId: result.tripId, driverId: input.driverId, vehicleId },
    });

    return { tripId: result.tripId, vehicleId };
  }

  /**
   * There is no `pauseTrip`, and that is the point.
   *
   * A running trip is recorded until it ends. The driver's screen has a start and a stop and
   * nothing in between, because a pause control is a way to keep driving with the recording
   * switched off — and the fuel burned in that window belongs to nobody. Standing still needs no
   * button: a stationary vehicle produces a stop on its own track, computed from the points.
   *
   * Historical trips may still carry TRACKING_PAUSED events from before this was removed, so the
   * pause arithmetic below stays: `endTrip` reads those intervals and excludes them, which keeps
   * an old trip's totals what they always were.
   */

  /**
   * Ends a trip and computes its final numbers.
   *
   * Distance is recomputed from every stored point at close time rather than trusted from the
   * running total, so a trip that synced out of order still ends with the right number.
   */
  async endTrip(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    tripId: TripId;
    endLatitude: number | null;
    endLongitude: number | null;
    endOdometer: string | null;
    at: Date;
  }): Promise<{
    distanceMeters: number;
    durationSeconds: number;
    untrackedSeconds: number;
  }> {
    const result = await this.transactions.run(input.organizationId, async (uow) => {
      const trip = await this.requireOwnTrip(
        uow,
        input.organizationId,
        input.driverId,
        input.tripId,
      );
      assertTransition(trip.status, 'COMPLETED');
      if (!trip.startedAt) {
        throw new PreconditionFailedError('trip.not_started', 'This trip has no start time.');
      }

      const points = await uow.locations.listForTrip(input.organizationId, input.tripId);
      const pauses = await uow.trips.listPauses(input.organizationId, input.tripId);

      const distance = computeTrackDistance(points);
      const gaps = findTrackingGaps({
        pointTimestamps: points.map((point) => point.timestamp),
        tripStartedAt: trip.startedAt,
        tripEndedAt: input.at,
        now: input.at,
        pausedIntervals: pauses.map((pause) => ({ start: pause.startedAt, end: pause.endedAt })),
      });

      const totals = computeTripTotals({
        startedAt: trip.startedAt,
        endedAt: input.at,
        pauses,
        gapSeconds: totalGapSeconds(gaps),
      });

      await uow.trips.close({
        organizationId: input.organizationId,
        tripId: input.tripId,
        endedAt: input.at,
        endLatitude: input.endLatitude,
        endLongitude: input.endLongitude,
        endOdometer: input.endOdometer,
        distanceMeters: distance.distanceMeters,
        durationSeconds: totals.durationSeconds,
        pausedSeconds: totals.pausedSeconds,
        untrackedSeconds: totals.untrackedSeconds,
      });

      await uow.trackingEvents.record({
        organizationId: input.organizationId,
        tripId: input.tripId,
        type: 'TRACKING_STOPPED',
        state: 'STOPPED',
        occurredAt: input.at,
        lastLatitude: input.endLatitude,
        lastLongitude: input.endLongitude,
      });

      return {
        distanceMeters: distance.distanceMeters,
        durationSeconds: totals.durationSeconds,
        untrackedSeconds: totals.untrackedSeconds,
        vehicleId: trip.vehicleId,
      };
    });

    if (input.endOdometer) {
      await this.vehicles.recordOdometer({
        organizationId: input.organizationId,
        vehicleId: result.vehicleId,
        odometer: input.endOdometer,
      });
    }

    // The trip is over, so the vehicle goes back in the pool — but only if this module took it.
    // A manual assignment is a fleet decision and survives.
    await this.vehicles.releaseAutomatic({
      organizationId: input.organizationId,
      driverId: input.driverId,
      vehicleId: result.vehicleId as VehicleId,
      endedAt: input.at,
    });

    await this.events.publish({
      name: 'trip.completed',
      organizationId: input.organizationId,
      occurredAt: input.at,
      payload: { tripId: input.tripId, driverId: input.driverId, ...result },
    });

    return {
      distanceMeters: result.distanceMeters,
      durationSeconds: result.durationSeconds,
      untrackedSeconds: result.untrackedSeconds,
    };
  }

  /**
   * Ingests a batch of location points.
   *
   * This is the highest-frequency write path in the system, so it does the minimum:
   * validate → append → update the running distance and tracking state. Route reconstruction,
   * stop detection and gap analysis are read-side concerns and stay out of the hot path.
   *
   * A tracking-state transition (say, ACTIVE → INTERRUPTED → ACTIVE) writes one neutral event
   * describing what was observed. It never records a conclusion about why.
   */
  async ingestLocations(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    tripId: TripId;
    points: readonly RawLocationPoint[];
    deviceReported: 'ONLINE' | 'OFFLINE' | 'PERMISSION_DENIED' | null;
    now: Date;
    backfillThresholdSeconds?: number;
  }): Promise<{ accepted: number; rejected: number; clamped: number; state: TrackingState }> {
    return this.transactions.run(input.organizationId, async (uow) => {
      const trip = await this.requireOwnTrip(
        uow,
        input.organizationId,
        input.driverId,
        input.tripId,
      );

      const batch = validateLocationBatch({
        trip,
        points: input.points,
        now: input.now,
        backfillThresholdSeconds: input.backfillThresholdSeconds ?? 120,
      });

      if (batch.accepted.length > 0) {
        await uow.locations.appendMany({
          organizationId: input.organizationId,
          tripId: input.tripId,
          points: batch.accepted,
        });
      }

      const allPoints = await uow.locations.listForTrip(input.organizationId, input.tripId);
      const distance = computeTrackDistance(allPoints);
      const lastPointAt = allPoints.at(-1)?.timestamp ?? null;
      const lastAccuracy = allPoints.at(-1)?.accuracyMeters ?? null;

      const previousState =
        (await uow.trackingEvents.latestState(input.organizationId, input.tripId)) ?? 'STOPPED';
      const state = deriveTrackingState({
        tripStatus: trip.status,
        lastPointAt,
        lastPointAccuracyMeters: lastAccuracy,
        deviceReported: input.deviceReported,
        now: input.now,
      });

      const transitionEvent = eventForTransition(previousState, state);
      if (transitionEvent) {
        await uow.trackingEvents.record({
          organizationId: input.organizationId,
          tripId: input.tripId,
          type: transitionEvent,
          state,
          occurredAt: input.now,
          lastLatitude: allPoints.at(-1)?.latitude ?? null,
          lastLongitude: allPoints.at(-1)?.longitude ?? null,
          metadata: { previousState, deviceReported: input.deviceReported },
        });
      }

      if (lastPointAt) {
        await uow.trips.updateLiveMetrics({
          organizationId: input.organizationId,
          tripId: input.tripId,
          distanceMeters: distance.distanceMeters,
          lastPointAt,
          trackingState: state,
        });
      }

      return {
        accepted: batch.accepted.length,
        rejected: batch.rejected,
        clamped: batch.clamped,
        state,
      };
    });
  }

  /**
   * Sweeps active trips and records an interruption event for any that have gone quiet.
   *
   * Run on a schedule. Without it, a trip whose device died would sit at ACTIVE forever, and
   * the admin dashboard would show a driver as tracked when nothing is arriving.
   */
  async detectInterruptions(input: {
    organizationId: OrganizationId;
  }): Promise<{ interrupted: number }> {
    const now = this.clock.now();
    return this.transactions.run(input.organizationId, async (uow) => {
      const active = await uow.trips.listActive(input.organizationId);
      let interrupted = 0;

      for (const trip of active) {
        const lastPointAt = await uow.locations.lastPointAt(input.organizationId, trip.id);
        const previousState =
          (await uow.trackingEvents.latestState(input.organizationId, trip.id)) ?? 'STOPPED';
        const state = deriveTrackingState({
          tripStatus: trip.status,
          lastPointAt,
          lastPointAccuracyMeters: null,
          deviceReported: null,
          now,
        });

        const transitionEvent = eventForTransition(previousState, state);
        if (!transitionEvent) continue;

        await uow.trackingEvents.record({
          organizationId: input.organizationId,
          tripId: trip.id,
          type: transitionEvent,
          state,
          occurredAt: lastPointAt ?? trip.startedAt ?? now,
          gapSeconds: lastPointAt
            ? Math.round((now.getTime() - lastPointAt.getTime()) / 1000)
            : null,
          metadata: { previousState, detectedBy: 'sweep' },
        });
        if (state === 'INTERRUPTED') interrupted += 1;
      }

      return { interrupted };
    });
  }

  /**
   * Loads a trip and proves it belongs to this driver.
   *
   * Reported as NOT_FOUND rather than FORBIDDEN: confirming that another driver's trip id
   * exists would itself leak information.
   */
  private async requireOwnTrip(
    uow: DriverUnitOfWork,
    organizationId: OrganizationId,
    driverId: DriverId,
    tripId: TripId,
  ): Promise<TripState> {
    const trip = await uow.trips.findById(organizationId, tripId);
    if (!trip) {
      throw new NotFoundError('trip.not_found', 'Trip not found.');
    }
    if (trip.driverId !== driverId) {
      throw new NotFoundError('trip.not_found', 'Trip not found.', {
        details: { securityEvent: 'cross_driver_trip_access' },
      });
    }
    return trip;
  }
}

/** Thrown by the read side when a non-driver actor asks for a driver-scoped view. */
export function assertDriverScope(actorDriverId: string | undefined, driverId: string): void {
  if (actorDriverId !== driverId) {
    throw new ForbiddenError('driver.not_own_data', 'Drivers may only read their own data.');
  }
}
