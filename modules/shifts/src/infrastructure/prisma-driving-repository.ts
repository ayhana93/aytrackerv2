import type { DatabaseClient } from '@aytracker/database';
import { computeTrackDistance, findTrackingGaps, totalGapSeconds } from '@aytracker/tracking';
import type {
  DriverId,
  OrganizationId,
  PositionSessionId,
  SiteId,
  TripId,
  VehicleId,
  WorkerId,
} from '@aytracker/types';
import type { AssignmentContext, DriverProfile, SelectableVehicle } from '../domain/driving.js';
import type { DrivingRepository } from '../domain/ports.js';

/**
 * The driving handoff's database adapter.
 *
 * This is the one place the shifts module writes to fleet and driver tables, and it does so
 * through a contract the shifts module owns. The reason is atomicity: the position change, the
 * vehicle assignment and the trip must commit together, and routing each through its own
 * module's service would mean three transactions and a window where the worker is on a driving
 * position with no vehicle.
 *
 * Every method takes the transaction client it was constructed with, so the whole handoff shares
 * one transaction.
 */
export class PrismaDrivingRepository implements DrivingRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findDriverForWorker(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<DriverProfile | null> {
    const driver = await this.db.driver.findFirst({
      where: { organizationId, workerId, deletedAt: null },
      select: { id: true, workerId: true, status: true, licenseExpiresAt: true },
    });
    if (!driver || !driver.workerId) return null;
    return {
      driverId: driver.id as DriverId,
      workerId: driver.workerId as WorkerId,
      status: driver.status,
      licenseExpiresAt: driver.licenseExpiresAt,
    };
  }

  /**
   * Vehicles at the site, each with the driver currently holding it.
   *
   * The filtering to *selectable* vehicles happens in the domain (`selectableVehicles`), not
   * here — the query returns the facts, the rule decides. That keeps the rule testable without a
   * database and keeps this method honest about what it is: a read.
   */
  async listVehiclesForSelection(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    siteId: SiteId | null;
  }): Promise<readonly SelectableVehicle[]> {
    const vehicles = await this.db.vehicle.findMany({
      where: {
        organizationId: input.organizationId,
        deletedAt: null,
        // A site-less vehicle is available anywhere; a site-bound one only at its own site.
        ...(input.siteId ? { OR: [{ siteId: input.siteId }, { siteId: null }] } : {}),
      },
      select: {
        id: true,
        registrationNumber: true,
        make: true,
        model: true,
        vehicleType: true,
        fuelType: true,
        odometerCurrent: true,
        status: true,
        assignments: {
          where: { endedAt: null },
          select: { driverId: true },
          take: 1,
        },
      },
      orderBy: { registrationNumber: 'asc' },
      take: 200,
    });

    return vehicles.map((vehicle) => {
      const assignedToDriverId = (vehicle.assignments[0]?.driverId ?? null) as DriverId | null;
      return {
        vehicleId: vehicle.id as VehicleId,
        registrationNumber: vehicle.registrationNumber,
        make: vehicle.make,
        model: vehicle.model,
        vehicleType: vehicle.vehicleType,
        fuelType: vehicle.fuelType,
        odometer: vehicle.odometerCurrent.toString(),
        status: vehicle.status,
        assignedToDriverId,
        assignedToSelf: assignedToDriverId === input.driverId,
      };
    });
  }

  async loadAssignmentContext(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
  }): Promise<AssignmentContext> {
    const [vehicle, vehicleAssignment, driverAssignment] = await Promise.all([
      this.db.vehicle.findFirst({
        where: { id: input.vehicleId, organizationId: input.organizationId, deletedAt: null },
        select: {
          id: true,
          registrationNumber: true,
          make: true,
          model: true,
          vehicleType: true,
          fuelType: true,
          odometerCurrent: true,
          status: true,
        },
      }),
      this.db.vehicleAssignment.findFirst({
        where: {
          organizationId: input.organizationId,
          vehicleId: input.vehicleId,
          endedAt: null,
        },
        select: { id: true, driverId: true },
      }),
      this.db.vehicleAssignment.findFirst({
        where: {
          organizationId: input.organizationId,
          driverId: input.driverId,
          endedAt: null,
        },
        select: { id: true, vehicleId: true },
      }),
    ]);

    if (!vehicle) {
      // Reported as unavailable rather than "not found": from the caller's side the two are the
      // same, and a distinct 404 would confirm which vehicle ids exist in the tenant.
      throw new Error('driving.vehicle_not_available');
    }

    const assignedToDriverId = (vehicleAssignment?.driverId ?? null) as DriverId | null;
    return {
      vehicle: {
        vehicleId: vehicle.id as VehicleId,
        registrationNumber: vehicle.registrationNumber,
        make: vehicle.make,
        model: vehicle.model,
        vehicleType: vehicle.vehicleType,
        fuelType: vehicle.fuelType,
        odometer: vehicle.odometerCurrent.toString(),
        status: vehicle.status,
        assignedToDriverId,
        assignedToSelf: assignedToDriverId === input.driverId,
      },
      vehicleAssignment: vehicleAssignment
        ? { id: vehicleAssignment.id, driverId: vehicleAssignment.driverId as DriverId }
        : null,
      driverAssignment: driverAssignment
        ? { id: driverAssignment.id, vehicleId: driverAssignment.vehicleId as VehicleId }
        : null,
    };
  }

  async createAssignment(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    startedAt: Date;
    isAutomatic: boolean;
  }): Promise<{ assignmentId: string }> {
    const assignment = await this.db.vehicleAssignment.create({
      data: {
        organizationId: input.organizationId,
        driverId: input.driverId,
        vehicleId: input.vehicleId,
        startedAt: input.startedAt,
        isAutomatic: input.isAutomatic,
        notes: input.isAutomatic ? 'Created by the driving handoff.' : null,
      },
      select: { id: true },
    });
    return { assignmentId: assignment.id };
  }

  /**
   * Releases the vehicle — but only if this flow took it.
   *
   * `isAutomatic: true` in the filter is the whole point. A vehicle a fleet manager assigned to
   * a driver stays with that driver when they finish a shift.
   */
  async closeAutomaticAssignment(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    endedAt: Date;
  }): Promise<{ closed: boolean }> {
    const result = await this.db.vehicleAssignment.updateMany({
      where: {
        organizationId: input.organizationId,
        driverId: input.driverId,
        vehicleId: input.vehicleId,
        endedAt: null,
        isAutomatic: true,
      },
      data: { endedAt: input.endedAt },
    });
    return { closed: result.count > 0 };
  }

  async startTrip(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    positionSessionId: PositionSessionId;
    label: string | null;
    startedAt: Date;
    startLatitude: number | null;
    startLongitude: number | null;
  }): Promise<{ tripId: TripId }> {
    const trip = await this.db.driverTrip.create({
      data: {
        organizationId: input.organizationId,
        driverId: input.driverId,
        vehicleId: input.vehicleId,
        positionSessionId: input.positionSessionId,
        label: input.label,
        status: 'ACTIVE',
        startedAt: input.startedAt,
        startLatitude: input.startLatitude?.toFixed(6) ?? null,
        startLongitude: input.startLongitude?.toFixed(6) ?? null,
        trackingState: 'ACTIVE',
      },
      select: { id: true },
    });

    /*
     * No TRACKING_STARTED written here.
     *
     * A worker moving onto a driving position is already being tracked — their working day's
     * session opened when they clocked in, and the trip's points are that stream with a trip
     * attached. Announcing a tracking start mid-shift would put a transition in the log that
     * never happened. `TrackingCommandService.attachTrip` decides whether this trip genuinely
     * needs a session of its own, and records the event only then.
     */
    return { tripId: trip.id as TripId };
  }

  async findTripForSession(
    organizationId: OrganizationId,
    positionSessionId: PositionSessionId,
  ): Promise<{
    tripId: TripId;
    driverId: DriverId;
    vehicleId: VehicleId;
    status: 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
    startedAt: Date | null;
  } | null> {
    const trip = await this.db.driverTrip.findFirst({
      where: { organizationId, positionSessionId },
      select: {
        id: true,
        driverId: true,
        vehicleId: true,
        status: true,
        startedAt: true,
      },
    });
    if (!trip) return null;
    return {
      tripId: trip.id as TripId,
      driverId: trip.driverId as DriverId,
      vehicleId: trip.vehicleId as VehicleId,
      status: trip.status,
      startedAt: trip.startedAt,
    };
  }

  /**
   * Closes the trip and computes its final numbers.
   *
   * Distance is recomputed from every stored point rather than trusted from the running total,
   * so a trip whose points synced out of order still ends with the right figure. Gaps are
   * measured and reported as `untrackedSeconds` — never interpolated over.
   */
  async closeTrip(input: {
    organizationId: OrganizationId;
    tripId: TripId;
    endedAt: Date;
  }): Promise<{ distanceMeters: number; durationSeconds: number; untrackedSeconds: number }> {
    const trip = await this.db.driverTrip.findFirstOrThrow({
      where: { id: input.tripId, organizationId: input.organizationId },
      select: { startedAt: true, pausedSeconds: true },
    });

    // The trip's own points, read through the trip overlay on the shared table. These are the
    // same rows the working day's route is drawn from — never a second copy.
    const points = await this.db.locationPoint.findMany({
      where: { organizationId: input.organizationId, tripId: input.tripId },
      select: { timestamp: true, latitude: true, longitude: true, accuracyMeters: true },
      orderBy: { timestamp: 'asc' },
    });

    const track = points.map((point) => ({
      timestamp: point.timestamp,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      accuracyMeters: point.accuracyMeters === null ? null : Number(point.accuracyMeters),
    }));

    const distance = computeTrackDistance(track);
    const startedAt = trip.startedAt ?? input.endedAt;
    const gaps = findTrackingGaps({
      pointTimestamps: track.map((point) => point.timestamp),
      tripStartedAt: startedAt,
      tripEndedAt: input.endedAt,
      now: input.endedAt,
    });

    const elapsed = Math.max(0, Math.round((input.endedAt.getTime() - startedAt.getTime()) / 1000));
    const durationSeconds = Math.max(0, elapsed - trip.pausedSeconds);
    const untrackedSeconds = Math.min(totalGapSeconds(gaps), durationSeconds);

    const lastPoint = track.at(-1);
    await this.db.driverTrip.updateMany({
      where: { id: input.tripId, organizationId: input.organizationId },
      data: {
        status: 'COMPLETED',
        endedAt: input.endedAt,
        endLatitude: lastPoint ? lastPoint.latitude.toFixed(6) : null,
        endLongitude: lastPoint ? lastPoint.longitude.toFixed(6) : null,
        distanceMeters: distance.distanceMeters,
        durationSeconds,
        untrackedSeconds,
        trackingState: 'STOPPED',
      },
    });

    // Likewise no TRACKING_STOPPED: the employee is still at work and still reporting. Only
    // `detachTrip` closes a session, and only when the trip owned one.
    return { distanceMeters: distance.distanceMeters, durationSeconds, untrackedSeconds };
  }
}
