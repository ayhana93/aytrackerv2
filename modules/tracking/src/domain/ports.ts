import type { DriverId, OrganizationId, VehicleId, WorkerId } from '@aytracker/types';
import type { TrackingEventType, TrackingState } from '@aytracker/tracking';
import type { AdmittedLocationPoint, TripWindow } from './admission.js';
import type {
  DeviceTelemetry,
  TrackingContext,
  TrackingSessionId,
  TrackingSessionState,
} from './session.js';

/**
 * Ports for the tracking module.
 *
 * Declared here rather than in infrastructure so the application layer states what it needs and
 * the Prisma adapter supplies it — which is what keeps `admitPoints` and the session rules
 * testable without a database, and what stops a query shape leaking into a domain decision.
 */

export interface TrackingSessionRepository {
  findById(
    organizationId: OrganizationId,
    sessionId: TrackingSessionId,
  ): Promise<TrackingSessionState | null>;

  /** The open WORK session for a worker, if the organization tracks their day. */
  findOpenWorkForWorker(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<TrackingSessionState | null>;

  /** The open DRIVER_TRIP session for a driver, if one is running. */
  findOpenTripForDriver(
    organizationId: OrganizationId,
    driverId: DriverId,
  ): Promise<TrackingSessionState | null>;

  findByTripId(
    organizationId: OrganizationId,
    tripId: string,
  ): Promise<TrackingSessionState | null>;

  open(input: {
    organizationId: OrganizationId;
    context: TrackingContext;
    workerId: WorkerId | null;
    driverId: DriverId | null;
    shiftId: string | null;
    tripId: string | null;
    vehicleId: VehicleId | null;
    startedAt: Date;
  }): Promise<TrackingSessionState>;

  close(input: {
    organizationId: OrganizationId;
    sessionId: TrackingSessionId;
    endedAt: Date;
    distanceMeters: number;
    untrackedSeconds: number;
  }): Promise<void>;

  /** The live row the admin map reads. Written on every accepted batch. */
  updateLiveState(input: {
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
  }): Promise<void>;

  /** Every session still open in this organization. The live map's one query. */
  listOpen(organizationId: OrganizationId): Promise<readonly TrackingSessionState[]>;
}

export interface TrackedPoint {
  readonly timestamp: Date;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number | null;
  readonly speedMps: number | null;
  readonly tripId: string | null;
}

export interface LocationPointRepository {
  appendMany(input: {
    organizationId: OrganizationId;
    trackingSessionId: TrackingSessionId;
    points: readonly AdmittedLocationPoint[];
  }): Promise<number>;

  /** Every point in a session, oldest first. The input to distance and gap reconstruction. */
  listForSession(
    organizationId: OrganizationId,
    sessionId: TrackingSessionId,
  ): Promise<readonly TrackedPoint[]>;

  /** Every point tagged with this trip. The same rows, read through the trip overlay. */
  listForTrip(organizationId: OrganizationId, tripId: string): Promise<readonly TrackedPoint[]>;

  lastPointAt(organizationId: OrganizationId, sessionId: TrackingSessionId): Promise<Date | null>;
}

export interface TrackingEventRepository {
  record(input: {
    organizationId: OrganizationId;
    trackingSessionId: TrackingSessionId;
    tripId: string | null;
    type: TrackingEventType;
    state: TrackingState;
    occurredAt: Date;
    gapSeconds?: number | null;
    lastLatitude?: number | null;
    lastLongitude?: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  latestState(
    organizationId: OrganizationId,
    sessionId: TrackingSessionId,
  ): Promise<TrackingState | null>;
}

/**
 * The trip a session's points may currently be attributed to, and its running totals.
 *
 * The trip row carries its own live distance because that is what the driver's screen and the
 * admin trip list read — one indexed row rather than a scan of the day's points. Keeping it
 * current is this module's job now, since this module is the only thing that writes points.
 */
export interface TripWindowAccess {
  openTripForSession(
    organizationId: OrganizationId,
    session: TrackingSessionState,
  ): Promise<TripWindow | null>;

  /**
   * Refreshes a trip's running numbers from the points tagged with it.
   *
   * Recomputed rather than accumulated: a batch that arrives after an offline stretch can land
   * out of order, and adding to a running total would bake that in permanently.
   */
  updateLiveMetrics(input: {
    organizationId: OrganizationId;
    tripId: string;
    distanceMeters: number;
    lastPointAt: Date;
    trackingState: TrackingState;
  }): Promise<void>;
}

export interface TrackingUnitOfWork {
  readonly sessions: TrackingSessionRepository;
  readonly points: LocationPointRepository;
  readonly events: TrackingEventRepository;
  readonly trips: TripWindowAccess;
}

export interface TrackingTransactionRunner {
  run<T>(organizationId: OrganizationId, fn: (uow: TrackingUnitOfWork) => Promise<T>): Promise<T>;
}
