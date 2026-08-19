import type { DatabaseClient, Prisma, PrismaClient } from '@aytracker/database';
import { withTenant } from '@aytracker/database';
import type { DriverId, OrganizationId, TripId, VehicleId } from '@aytracker/types';
import type { TrackingEventType, TrackingState } from '@aytracker/tracking';
import type {
  AcceptedLocationPoint,
  PauseInterval,
  TripState,
  TripStatus,
} from '../domain/trip.js';
import type {
  DriverTransactionRunner,
  DriverUnitOfWork,
  DriverVehicleAccess,
  LocationPointRepository,
  TrackingEventRepository,
  TripRepository,
} from '../domain/ports.js';

const TRIP_SELECT = {
  id: true,
  driverId: true,
  vehicleId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  pausedSeconds: true,
} as const;

export class PrismaTripRepository implements TripRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findById(organizationId: OrganizationId, tripId: TripId): Promise<TripState | null> {
    const trip = await this.db.driverTrip.findFirst({
      where: { id: tripId, organizationId },
      select: TRIP_SELECT,
    });
    return trip ? (trip as TripState) : null;
  }

  async findOpenForDriver(
    organizationId: OrganizationId,
    driverId: DriverId,
  ): Promise<TripState | null> {
    const trip = await this.db.driverTrip.findFirst({
      where: { organizationId, driverId, status: { in: ['ACTIVE', 'PAUSED'] } },
      select: TRIP_SELECT,
    });
    return trip ? (trip as TripState) : null;
  }

  async create(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    label: string | null;
    startedAt: Date;
    startLatitude: number | null;
    startLongitude: number | null;
    startOdometer: string | null;
  }): Promise<TripState> {
    const trip = await this.db.driverTrip.create({
      data: {
        organizationId: input.organizationId,
        driverId: input.driverId,
        vehicleId: input.vehicleId,
        label: input.label,
        status: 'ACTIVE',
        startedAt: input.startedAt,
        startLatitude: input.startLatitude,
        startLongitude: input.startLongitude,
        startOdometer: input.startOdometer,
        trackingState: 'ACTIVE',
      },
      select: TRIP_SELECT,
    });
    return trip as TripState;
  }

  async updateStatus(input: {
    organizationId: OrganizationId;
    tripId: TripId;
    status: TripStatus;
    trackingState: TrackingState;
  }): Promise<void> {
    await this.db.driverTrip.updateMany({
      where: { id: input.tripId, organizationId: input.organizationId },
      data: { status: input.status, trackingState: input.trackingState },
    });
  }

  async close(input: {
    organizationId: OrganizationId;
    tripId: TripId;
    endedAt: Date;
    endLatitude: number | null;
    endLongitude: number | null;
    endOdometer: string | null;
    distanceMeters: number;
    durationSeconds: number;
    pausedSeconds: number;
    untrackedSeconds: number;
  }): Promise<void> {
    await this.db.driverTrip.updateMany({
      where: { id: input.tripId, organizationId: input.organizationId },
      data: {
        status: 'COMPLETED',
        endedAt: input.endedAt,
        endLatitude: input.endLatitude,
        endLongitude: input.endLongitude,
        endOdometer: input.endOdometer,
        distanceMeters: input.distanceMeters,
        durationSeconds: input.durationSeconds,
        pausedSeconds: input.pausedSeconds,
        untrackedSeconds: input.untrackedSeconds,
        trackingState: 'STOPPED',
      },
    });
  }

  async updateLiveMetrics(input: {
    organizationId: OrganizationId;
    tripId: TripId;
    distanceMeters: number;
    lastPointAt: Date;
    trackingState: TrackingState;
  }): Promise<void> {
    await this.db.driverTrip.updateMany({
      where: { id: input.tripId, organizationId: input.organizationId },
      data: {
        distanceMeters: input.distanceMeters,
        lastPointAt: input.lastPointAt,
        trackingState: input.trackingState,
      },
    });
  }

  async listForDriver(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<readonly TripState[]> {
    const trips = await this.db.driverTrip.findMany({
      where: {
        organizationId: input.organizationId,
        driverId: input.driverId,
        startedAt: { gte: input.from, lte: input.to },
      },
      select: TRIP_SELECT,
      orderBy: { startedAt: 'desc' },
      take: input.limit,
    });
    return trips as TripState[];
  }

  async listActive(organizationId: OrganizationId): Promise<readonly TripState[]> {
    const trips = await this.db.driverTrip.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: TRIP_SELECT,
      take: 1000,
    });
    return trips as TripState[];
  }

  /**
   * Pause intervals, reconstructed from the tracking-event log.
   *
   * There is no separate pauses table on purpose: the events are already the audit record of
   * what the driver did, and a second table would be a second source of truth to keep in sync.
   */
  async listPauses(
    organizationId: OrganizationId,
    tripId: TripId,
  ): Promise<readonly PauseInterval[]> {
    const events = await this.db.trackingEvent.findMany({
      where: {
        organizationId,
        tripId,
        type: { in: ['TRACKING_PAUSED', 'TRACKING_RESUMED'] },
      },
      select: { type: true, occurredAt: true },
      orderBy: { occurredAt: 'asc' },
    });

    const pauses: PauseInterval[] = [];
    let openPause: Date | null = null;
    for (const event of events) {
      if (event.type === 'TRACKING_PAUSED' && openPause === null) {
        openPause = event.occurredAt;
      } else if (event.type === 'TRACKING_RESUMED' && openPause !== null) {
        pauses.push({ startedAt: openPause, endedAt: event.occurredAt });
        openPause = null;
      }
    }
    if (openPause !== null) pauses.push({ startedAt: openPause, endedAt: null });
    return pauses;
  }
}

export class PrismaLocationPointRepository implements LocationPointRepository {
  constructor(private readonly db: DatabaseClient) {}

  async appendMany(input: {
    organizationId: OrganizationId;
    tripId: TripId;
    points: readonly AcceptedLocationPoint[];
  }): Promise<number> {
    const result = await this.db.tripLocationPoint.createMany({
      data: input.points.map((point) => ({
        organizationId: input.organizationId,
        tripId: input.tripId,
        timestamp: point.timestamp,
        latitude: point.latitude.toFixed(6),
        longitude: point.longitude.toFixed(6),
        accuracyMeters: point.accuracyMeters ?? null,
        speedMps: point.speedMps ?? null,
        heading: point.heading ?? null,
        altitude: point.altitude ?? null,
        source: point.source ?? 'GPS',
        isBackfilled: point.isBackfilled,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async listForTrip(organizationId: OrganizationId, tripId: TripId) {
    const points = await this.db.tripLocationPoint.findMany({
      where: { organizationId, tripId },
      select: {
        timestamp: true,
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        speedMps: true,
      },
      orderBy: { timestamp: 'asc' },
    });
    return points.map((point) => ({
      timestamp: point.timestamp,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      accuracyMeters: point.accuracyMeters === null ? null : Number(point.accuracyMeters),
      speedMps: point.speedMps === null ? null : Number(point.speedMps),
    }));
  }

  async lastPointAt(organizationId: OrganizationId, tripId: TripId): Promise<Date | null> {
    const point = await this.db.tripLocationPoint.findFirst({
      where: { organizationId, tripId },
      select: { timestamp: true },
      orderBy: { timestamp: 'desc' },
    });
    return point?.timestamp ?? null;
  }

  /**
   * Retention.
   *
   * Deletes raw points only. Trip summaries — distance, duration, gaps — survive, so a year-old
   * cost report still works after the coordinates behind it have been removed. That is the
   * whole point of keeping the two retention windows separate.
   */
  async deleteOlderThan(organizationId: OrganizationId, cutoff: Date): Promise<number> {
    const result = await this.db.tripLocationPoint.deleteMany({
      where: { organizationId, timestamp: { lt: cutoff } },
    });
    return result.count;
  }
}

export class PrismaTrackingEventRepository implements TrackingEventRepository {
  constructor(private readonly db: DatabaseClient) {}

  async record(input: {
    organizationId: OrganizationId;
    tripId: TripId;
    type: TrackingEventType;
    state: TrackingState;
    occurredAt: Date;
    recoveredAt?: Date | null;
    gapSeconds?: number | null;
    lastLatitude?: number | null;
    lastLongitude?: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.trackingEvent.create({
      data: {
        organizationId: input.organizationId,
        tripId: input.tripId,
        type: input.type,
        state: input.state,
        occurredAt: input.occurredAt,
        recoveredAt: input.recoveredAt ?? null,
        gapSeconds: input.gapSeconds ?? null,
        lastLatitude: input.lastLatitude?.toFixed(6) ?? null,
        lastLongitude: input.lastLongitude?.toFixed(6) ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async listForTrip(organizationId: OrganizationId, tripId: TripId) {
    return this.db.trackingEvent.findMany({
      where: { organizationId, tripId },
      select: {
        type: true,
        state: true,
        occurredAt: true,
        recoveredAt: true,
        gapSeconds: true,
      },
      orderBy: { occurredAt: 'asc' },
    }) as Promise<
      readonly {
        type: TrackingEventType;
        state: TrackingState;
        occurredAt: Date;
        recoveredAt: Date | null;
        gapSeconds: number | null;
      }[]
    >;
  }

  async latestState(organizationId: OrganizationId, tripId: TripId): Promise<TrackingState | null> {
    const event = await this.db.trackingEvent.findFirst({
      where: { organizationId, tripId },
      select: { state: true },
      orderBy: { occurredAt: 'desc' },
    });
    return (event?.state as TrackingState | undefined) ?? null;
  }
}

/**
 * Resolves the driver's vehicle from the assignment table.
 *
 * This is the port that keeps `drivers` independent of `fleet`: the drivers module declares
 * what it needs, and the adapter — which is allowed to know about vehicles — supplies it.
 */
export class PrismaDriverVehicleAccess implements DriverVehicleAccess {
  constructor(private readonly db: DatabaseClient) {}

  async currentVehicleId(
    organizationId: OrganizationId,
    driverId: DriverId,
  ): Promise<VehicleId | null> {
    const assignment = await this.db.vehicleAssignment.findFirst({
      where: { organizationId, driverId, endedAt: null },
      select: { vehicleId: true },
      orderBy: { startedAt: 'desc' },
    });
    return (assignment?.vehicleId as VehicleId | undefined) ?? null;
  }

  /**
   * Odometer only ever moves forward.
   *
   * A trip that ends with a lower reading than the vehicle already has is a typo, and silently
   * accepting it would corrupt every cost-per-km figure derived from it.
   */
  async recordOdometer(input: {
    organizationId: OrganizationId;
    vehicleId: VehicleId;
    odometer: string;
  }): Promise<void> {
    const vehicle = await this.db.vehicle.findFirst({
      where: { id: input.vehicleId, organizationId: input.organizationId },
      select: { odometerCurrent: true },
    });
    if (!vehicle) return;
    if (Number(input.odometer) <= Number(vehicle.odometerCurrent)) return;

    await this.db.vehicle.updateMany({
      where: { id: input.vehicleId, organizationId: input.organizationId },
      data: { odometerCurrent: input.odometer },
    });
  }
}

export class PrismaDriverTransactionRunner implements DriverTransactionRunner {
  constructor(private readonly prisma: PrismaClient) {}

  async run<T>(
    organizationId: OrganizationId,
    fn: (uow: DriverUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenant(this.prisma, organizationId, async (tx) =>
      fn({
        trips: new PrismaTripRepository(tx),
        locations: new PrismaLocationPointRepository(tx),
        trackingEvents: new PrismaTrackingEventRepository(tx),
      }),
    );
  }
}
