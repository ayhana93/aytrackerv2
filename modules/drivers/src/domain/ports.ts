import type { DriverId, OrganizationId, TripId, VehicleId } from '@aytracker/types';
import type { TrackingEventType, TrackingState } from '@aytracker/tracking';
import type { AcceptedLocationPoint, PauseInterval, TripState } from './trip.js';

export interface TripRepository {
  findById(organizationId: OrganizationId, tripId: TripId): Promise<TripState | null>;
  findOpenForDriver(organizationId: OrganizationId, driverId: DriverId): Promise<TripState | null>;
  create(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    label: string | null;
    plannedDistanceMeters: number | null;
    startedAt: Date;
    startLatitude: number | null;
    startLongitude: number | null;
    startOdometer: string | null;
  }): Promise<TripState>;
  close(input: {
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
  }): Promise<void>;
  updateLiveMetrics(input: {
    organizationId: OrganizationId;
    tripId: TripId;
    distanceMeters: number;
    lastPointAt: Date;
    trackingState: TrackingState;
  }): Promise<void>;
  listForDriver(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<readonly TripState[]>;
  listActive(organizationId: OrganizationId): Promise<readonly TripState[]>;
  listPauses(organizationId: OrganizationId, tripId: TripId): Promise<readonly PauseInterval[]>;
}

export interface LocationPointRepository {
  appendMany(input: {
    organizationId: OrganizationId;
    tripId: TripId;
    points: readonly AcceptedLocationPoint[];
  }): Promise<number>;
  listForTrip(
    organizationId: OrganizationId,
    tripId: TripId,
  ): Promise<
    readonly {
      timestamp: Date;
      latitude: number;
      longitude: number;
      accuracyMeters: number | null;
      speedMps: number | null;
    }[]
  >;
  lastPointAt(organizationId: OrganizationId, tripId: TripId): Promise<Date | null>;
  /** Retention: deletes raw points older than the cutoff. Trip summaries are kept. */
  deleteOlderThan(organizationId: OrganizationId, cutoff: Date): Promise<number>;
}

export interface TrackingEventRepository {
  record(input: {
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
  }): Promise<void>;
  listForTrip(
    organizationId: OrganizationId,
    tripId: TripId,
  ): Promise<
    readonly {
      type: TrackingEventType;
      state: TrackingState;
      occurredAt: Date;
      recoveredAt: Date | null;
      gapSeconds: number | null;
    }[]
  >;
  latestState(organizationId: OrganizationId, tripId: TripId): Promise<TrackingState | null>;
}

export interface DriverVehicleAccess {
  /** The vehicle currently assigned to this driver, or null. Never client-supplied. */
  currentVehicleId(organizationId: OrganizationId, driverId: DriverId): Promise<VehicleId | null>;
  /** Recorded when a trip closes, so odometer history stays consistent with the fleet module. */
  recordOdometer(input: {
    organizationId: OrganizationId;
    vehicleId: VehicleId;
    odometer: string;
  }): Promise<void>;
  /**
   * Takes a vehicle for the duration of a trip.
   *
   * Marked automatic, so ending the trip hands it back. An assignment a fleet manager made by
   * hand is a decision and is never touched by this. Refuses rather than steals: a vehicle
   * another driver is holding stays with them.
   */
  claimForTrip(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    at: Date;
  }): Promise<void>;
  /** Hands back an automatic assignment. A no-op when the assignment was a manual one. */
  releaseAutomatic(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    endedAt: Date;
  }): Promise<void>;
}

export interface DriverUnitOfWork {
  readonly trips: TripRepository;
  readonly locations: LocationPointRepository;
  readonly trackingEvents: TrackingEventRepository;
}

export interface DriverTransactionRunner {
  run<T>(organizationId: OrganizationId, fn: (uow: DriverUnitOfWork) => Promise<T>): Promise<T>;
}
