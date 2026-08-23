import type { DatabaseClient, Prisma, PrismaClient } from '@aytracker/database';
import { withTenant } from '@aytracker/database';
import type { DriverId, OrganizationId, VehicleId, WorkerId } from '@aytracker/types';
import type { Geofence, TrackingEventType, TrackingState } from '@aytracker/tracking';
import type { AdmittedLocationPoint, TripWindow } from '../domain/admission.js';
import type {
  DeviceTelemetry,
  TrackingContext,
  TrackingSessionId,
  TrackingSessionState,
} from '../domain/session.js';
import type {
  ComputedVisit,
  GeofenceAccess,
  LocationPointRepository,
  TrackedPoint,
  TrackingEventRepository,
  TrackingSessionRepository,
  TrackingTransactionRunner,
  TrackingUnitOfWork,
  TripWindowAccess,
} from '../domain/ports.js';

/**
 * Prisma adapters for the tracking ports.
 *
 * Every query is scoped by `organizationId` in the `where` clause itself rather than filtered
 * afterwards, and every write runs inside `withTenant`, which sets the RLS variable. The
 * application layer never sees a query.
 */

const SESSION_SELECT = {
  id: true,
  organizationId: true,
  context: true,
  workerId: true,
  driverId: true,
  shiftId: true,
  tripId: true,
  vehicleId: true,
  startedAt: true,
  endedAt: true,
  distanceMeters: true,
  untrackedSeconds: true,
  trackingState: true,
  lastPointAt: true,
} as const;

type SessionRow = {
  id: string;
  organizationId: string;
  context: string;
  workerId: string | null;
  driverId: string | null;
  shiftId: string | null;
  tripId: string | null;
  vehicleId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  distanceMeters: number;
  untrackedSeconds: number;
  trackingState: string;
  lastPointAt: Date | null;
};

function toSession(row: SessionRow): TrackingSessionState {
  return {
    id: row.id as TrackingSessionId,
    organizationId: row.organizationId as OrganizationId,
    context: row.context as TrackingContext,
    workerId: (row.workerId as WorkerId | null) ?? null,
    driverId: (row.driverId as DriverId | null) ?? null,
    shiftId: row.shiftId,
    tripId: row.tripId,
    vehicleId: (row.vehicleId as VehicleId | null) ?? null,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    distanceMeters: row.distanceMeters,
    untrackedSeconds: row.untrackedSeconds,
    trackingState: row.trackingState,
    lastPointAt: row.lastPointAt,
  };
}

export class PrismaTrackingSessionRepository implements TrackingSessionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findById(
    organizationId: OrganizationId,
    sessionId: TrackingSessionId,
  ): Promise<TrackingSessionState | null> {
    const row = await this.db.trackingSession.findFirst({
      where: { id: sessionId, organizationId },
      select: SESSION_SELECT,
    });
    return row ? toSession(row) : null;
  }

  async findOpenWorkForWorker(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<TrackingSessionState | null> {
    const row = await this.db.trackingSession.findFirst({
      where: { organizationId, workerId, context: 'WORK', endedAt: null },
      select: SESSION_SELECT,
    });
    return row ? toSession(row) : null;
  }

  async findOpenTripForDriver(
    organizationId: OrganizationId,
    driverId: DriverId,
  ): Promise<TrackingSessionState | null> {
    const row = await this.db.trackingSession.findFirst({
      where: { organizationId, driverId, context: 'DRIVER_TRIP', endedAt: null },
      select: SESSION_SELECT,
    });
    return row ? toSession(row) : null;
  }

  async findByTripId(
    organizationId: OrganizationId,
    tripId: string,
  ): Promise<TrackingSessionState | null> {
    const row = await this.db.trackingSession.findFirst({
      where: { organizationId, tripId },
      select: SESSION_SELECT,
    });
    return row ? toSession(row) : null;
  }

  async open(input: {
    organizationId: OrganizationId;
    context: TrackingContext;
    workerId: WorkerId | null;
    driverId: DriverId | null;
    shiftId: string | null;
    tripId: string | null;
    vehicleId: VehicleId | null;
    startedAt: Date;
  }): Promise<TrackingSessionState> {
    const row = await this.db.trackingSession.create({
      data: {
        organizationId: input.organizationId,
        context: input.context,
        workerId: input.workerId,
        driverId: input.driverId,
        shiftId: input.shiftId,
        tripId: input.tripId,
        vehicleId: input.vehicleId,
        startedAt: input.startedAt,
        trackingState: 'ACTIVE',
      },
      select: SESSION_SELECT,
    });
    return toSession(row);
  }

  async close(input: {
    organizationId: OrganizationId;
    sessionId: TrackingSessionId;
    endedAt: Date;
    distanceMeters: number;
    untrackedSeconds: number;
  }): Promise<void> {
    await this.db.trackingSession.updateMany({
      // `endedAt: null` in the filter is what makes closing idempotent under a race: the second
      // writer updates nothing rather than overwriting the first one's totals.
      where: { id: input.sessionId, organizationId: input.organizationId, endedAt: null },
      data: {
        endedAt: input.endedAt,
        distanceMeters: input.distanceMeters,
        untrackedSeconds: input.untrackedSeconds,
        trackingState: 'STOPPED',
      },
    });
  }

  async updateLiveState(input: {
    organizationId: OrganizationId;
    sessionId: TrackingSessionId;
    distanceMeters: number;
    lastPointAt: Date | null;
    lastLatitude: number | null;
    lastLongitude: number | null;
    lastSpeedMps: number | null;
    lastAccuracyMeters: number | null;
    trackingState: TrackingState;
    telemetry: DeviceTelemetry;
  }): Promise<void> {
    await this.db.trackingSession.updateMany({
      where: { id: input.sessionId, organizationId: input.organizationId },
      data: {
        distanceMeters: input.distanceMeters,
        lastPointAt: input.lastPointAt,
        // Decimals go in as fixed strings. A float here loses the last digit of a coordinate,
        // which is about ten centimetres — invisible until two tracks disagree on a map.
        lastLatitude: input.lastLatitude?.toFixed(6) ?? null,
        lastLongitude: input.lastLongitude?.toFixed(6) ?? null,
        lastSpeedMps: input.lastSpeedMps?.toFixed(3) ?? null,
        lastAccuracyMeters: input.lastAccuracyMeters?.toFixed(2) ?? null,
        trackingState: input.trackingState,
        ...(input.telemetry.batteryLevel !== null
          ? { batteryLevel: input.telemetry.batteryLevel.toFixed(3) }
          : {}),
        ...(input.telemetry.isCharging !== null ? { isCharging: input.telemetry.isCharging } : {}),
        ...(input.telemetry.permission !== null
          ? { devicePermission: input.telemetry.permission }
          : {}),
      },
    });
  }

  async listOpen(organizationId: OrganizationId): Promise<readonly TrackingSessionState[]> {
    const rows = await this.db.trackingSession.findMany({
      where: { organizationId, endedAt: null },
      select: SESSION_SELECT,
      orderBy: { startedAt: 'asc' },
      take: 1000,
    });
    return rows.map(toSession);
  }
}

export class PrismaLocationPointRepository implements LocationPointRepository {
  constructor(private readonly db: DatabaseClient) {}

  async appendMany(input: {
    organizationId: OrganizationId;
    trackingSessionId: TrackingSessionId;
    points: readonly AdmittedLocationPoint[];
  }): Promise<number> {
    const result = await this.db.locationPoint.createMany({
      data: input.points.map((point) => ({
        organizationId: input.organizationId,
        trackingSessionId: input.trackingSessionId,
        tripId: point.tripId,
        timestamp: point.timestamp,
        latitude: point.latitude.toFixed(6),
        longitude: point.longitude.toFixed(6),
        accuracyMeters: point.accuracyMeters?.toFixed(2) ?? null,
        speedMps: point.speedMps?.toFixed(3) ?? null,
        heading: point.heading?.toFixed(2) ?? null,
        altitude: point.altitude?.toFixed(2) ?? null,
        source: point.source ?? 'GPS',
        isBackfilled: point.isBackfilled,
      })),
      /**
       * A point already stored for this session at this instant is the same point.
       *
       * The device queue drops a point only once the server acknowledges it, so a response lost
       * to a dropped connection leaves the batch queued and it arrives again — and every point in
       * it is then at or before the newest stored one, which routes it through the offline-replay
       * bucket that is thinned only against itself. Skipping is the right answer rather than
       * failing: the driver's connection is already bad, and refusing their upload for being a
       * retry would lose the points that genuinely are new in the same batch.
       */
      skipDuplicates: true,
    });
    return result.count;
  }

  async listForSession(
    organizationId: OrganizationId,
    sessionId: TrackingSessionId,
  ): Promise<readonly TrackedPoint[]> {
    return this.read({ organizationId, trackingSessionId: sessionId });
  }

  async listForTrip(
    organizationId: OrganizationId,
    tripId: string,
  ): Promise<readonly TrackedPoint[]> {
    return this.read({ organizationId, tripId });
  }

  async lastPointAt(
    organizationId: OrganizationId,
    sessionId: TrackingSessionId,
  ): Promise<Date | null> {
    const point = await this.db.locationPoint.findFirst({
      where: { organizationId, trackingSessionId: sessionId },
      select: { timestamp: true },
      orderBy: { timestamp: 'desc' },
    });
    return point?.timestamp ?? null;
  }

  /**
   * Retention. Raw points expire long before the trip summaries derived from them, which is the
   * whole point of keeping the two windows separate.
   */
  async deleteOlderThan(organizationId: OrganizationId, cutoff: Date): Promise<number> {
    const result = await this.db.locationPoint.deleteMany({
      where: { organizationId, timestamp: { lt: cutoff } },
    });
    return result.count;
  }

  private async read(where: {
    organizationId: string;
    trackingSessionId?: string;
    tripId?: string;
  }): Promise<readonly TrackedPoint[]> {
    const points = await this.db.locationPoint.findMany({
      where,
      select: {
        timestamp: true,
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        speedMps: true,
        tripId: true,
      },
      orderBy: { timestamp: 'asc' },
    });
    return points.map((point) => ({
      timestamp: point.timestamp,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      accuracyMeters: point.accuracyMeters === null ? null : Number(point.accuracyMeters),
      speedMps: point.speedMps === null ? null : Number(point.speedMps),
      tripId: point.tripId,
    }));
  }
}

export class PrismaTrackingEventRepository implements TrackingEventRepository {
  constructor(private readonly db: DatabaseClient) {}

  async record(input: {
    organizationId: OrganizationId;
    trackingSessionId: TrackingSessionId;
    tripId: string | null;
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
        trackingSessionId: input.trackingSessionId,
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

  async latestState(
    organizationId: OrganizationId,
    sessionId: TrackingSessionId,
  ): Promise<TrackingState | null> {
    const event = await this.db.trackingEvent.findFirst({
      where: { organizationId, trackingSessionId: sessionId },
      select: { state: true },
      orderBy: { occurredAt: 'desc' },
    });
    return (event?.state as TrackingState | undefined) ?? null;
  }

  async occurrencesOf(
    organizationId: OrganizationId,
    sessionId: TrackingSessionId,
    type: TrackingEventType,
  ): Promise<readonly Date[]> {
    const rows = await this.db.trackingEvent.findMany({
      where: { organizationId, trackingSessionId: sessionId, type },
      select: { occurredAt: true },
    });
    return rows.map((row) => row.occurredAt);
  }
}

/**
 * Geofences, and the visits derived from a session's points.
 *
 * `syncVisits` is the interesting half. It makes the stored rows equal the computed ones and
 * reports the difference, which is what lets the caller log an arrival once rather than on every
 * batch that re-derives it.
 */
export class PrismaGeofenceAccess implements GeofenceAccess {
  constructor(private readonly db: DatabaseClient) {}

  async listActive(organizationId: OrganizationId): Promise<readonly Geofence[]> {
    const rows = await this.db.geofence.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        centerLatitude: true,
        centerLongitude: true,
        radiusMeters: true,
      },
      take: 500,
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      center: { latitude: Number(row.centerLatitude), longitude: Number(row.centerLongitude) },
      radiusMeters: row.radiusMeters,
    }));
  }

  async syncVisits(input: {
    organizationId: OrganizationId;
    trackingSessionId: TrackingSessionId;
    visits: readonly ComputedVisit[];
  }): Promise<{
    readonly entered: readonly ComputedVisit[];
    readonly exited: readonly ComputedVisit[];
  }> {
    const stored = await this.db.geofenceVisit.findMany({
      where: {
        organizationId: input.organizationId,
        trackingSessionId: input.trackingSessionId,
      },
      select: { id: true, geofenceId: true, enteredAt: true, exitedAt: true },
    });

    const key = (geofenceId: string, enteredAt: Date) => `${geofenceId}@${enteredAt.getTime()}`;
    const storedByKey = new Map(stored.map((row) => [key(row.geofenceId, row.enteredAt), row]));

    const entered: ComputedVisit[] = [];
    const exited: ComputedVisit[] = [];

    for (const visit of input.visits) {
      const existing = storedByKey.get(key(visit.geofenceId, visit.enteredAt));
      if (!existing) {
        await this.db.geofenceVisit.create({
          data: {
            organizationId: input.organizationId,
            geofenceId: visit.geofenceId,
            trackingSessionId: input.trackingSessionId,
            tripId: visit.tripId,
            enteredAt: visit.enteredAt,
            exitedAt: visit.exitedAt,
            dwellSeconds: visit.dwellSeconds,
            entryLatitude: visit.entryLatitude.toFixed(6),
            entryLongitude: visit.entryLongitude.toFixed(6),
          },
        });
        entered.push(visit);
        // A visit that arrived already closed — a short stop confirmed by one late batch — is
        // both an arrival and a departure, and both deserve their event.
        if (visit.exitedAt) exited.push(visit);
        continue;
      }

      const newlyClosed = existing.exitedAt === null && visit.exitedAt !== null;
      await this.db.geofenceVisit.update({
        where: { id: existing.id },
        data: {
          exitedAt: visit.exitedAt,
          dwellSeconds: visit.dwellSeconds,
          tripId: visit.tripId,
        },
      });
      if (newlyClosed) exited.push(visit);
    }

    /*
     * Rows the points no longer support.
     *
     * This is the price of recomputation, and it is the right price: a replay that fills in the
     * gap between two fixes can show that what looked like a visit was a phone losing signal at
     * a red light. Leaving the row would keep a visit nobody made on a customer's report.
     */
    const computedKeys = new Set(
      input.visits.map((visit) => key(visit.geofenceId, visit.enteredAt)),
    );
    const orphans = stored.filter((row) => !computedKeys.has(key(row.geofenceId, row.enteredAt)));
    if (orphans.length > 0) {
      await this.db.geofenceVisit.deleteMany({
        where: {
          organizationId: input.organizationId,
          id: { in: orphans.map((row) => row.id) },
        },
      });
    }

    return { entered, exited };
  }
}

/**
 * Which trip a session's points may currently be attributed to.
 *
 * A DRIVER_TRIP session is bound to exactly one trip for its whole life. A WORK session picks up
 * whichever trip its worker happens to be running — which is how one phone produces both the
 * working day's route and the trip's without collecting anything twice.
 */
export class PrismaTripWindowAccess implements TripWindowAccess {
  constructor(private readonly db: DatabaseClient) {}

  async openTripForSession(
    organizationId: OrganizationId,
    session: TrackingSessionState,
  ): Promise<TripWindow | null> {
    if (session.tripId) {
      const trip = await this.db.driverTrip.findFirst({
        where: { id: session.tripId, organizationId },
        select: { id: true, startedAt: true, endedAt: true },
      });
      return trip ?? null;
    }
    if (!session.driverId) return null;

    const trip = await this.db.driverTrip.findFirst({
      where: { organizationId, driverId: session.driverId, status: { in: ['ACTIVE', 'PAUSED'] } },
      select: { id: true, startedAt: true, endedAt: true },
      orderBy: { startedAt: 'desc' },
    });
    return trip ?? null;
  }

  async updateLiveMetrics(input: {
    organizationId: OrganizationId;
    tripId: string;
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
}

export class PrismaTrackingTransactionRunner implements TrackingTransactionRunner {
  constructor(private readonly prisma: PrismaClient) {}

  async run<T>(
    organizationId: OrganizationId,
    fn: (uow: TrackingUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenant(this.prisma, organizationId, async (tx) =>
      fn({
        sessions: new PrismaTrackingSessionRepository(tx),
        points: new PrismaLocationPointRepository(tx),
        events: new PrismaTrackingEventRepository(tx),
        trips: new PrismaTripWindowAccess(tx),
        geofences: new PrismaGeofenceAccess(tx),
      }),
    );
  }
}
