import type { DriverId, OrganizationId, TripId, VehicleId } from '@aytracker/types';
import type { TrackingState } from '@aytracker/tracking';
import type { PauseInterval, TripState } from './trip.js';

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

/**
 * Reading a trip's own points.
 *
 * Writing them is not this module's job — `@aytracker/module-tracking` owns the single
 * ingestion path, for both a working day and a trip inside one. What the trip lifecycle still
 * needs is to read back what was recorded against it, so `endTrip` can recompute distance from
 * the stored points rather than trusting a running total.
 */
export interface TripPointAccess {
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
  readonly points: TripPointAccess;
}

export interface DriverTransactionRunner {
  run<T>(organizationId: OrganizationId, fn: (uow: DriverUnitOfWork) => Promise<T>): Promise<T>;
}
