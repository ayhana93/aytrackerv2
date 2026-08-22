'use client';

import type { RawPoint } from '@aytracker/tracking-client';
import { apiRequest } from './api';
import { actionId } from './worker';

/**
 * `/api/v1/driver` — everything the driver portal can do.
 *
 * There is deliberately no `pause` here. A trip records from the moment it starts until the
 * driver ends it; the control that used to sit between those two states is gone, because it was
 * a way to keep driving with the recording switched off.
 */

export type TripStatus = 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export interface DriverState {
  /** The server's clock. The trip timer is measured against this, never the device's. */
  readonly serverTime: string;
  readonly driver: {
    readonly id: string;
    readonly code: string;
    readonly firstName: string | null;
    readonly lastName: string | null;
  } | null;
  readonly vehicle: {
    readonly id: string;
    readonly registrationNumber: string;
    readonly make: string;
    readonly model: string;
    readonly fuelType: string;
    readonly odometerCurrent: string;
    readonly averageConsumption: string | null;
    readonly consumptionUnit: string;
    readonly assignedSince: string;
  } | null;
  readonly trip: {
    readonly id: string;
    readonly label: string | null;
    readonly plannedDistanceMeters: number | null;
    readonly status: TripStatus;
    readonly startedAt: string | null;
    readonly distanceMeters: number;
    readonly durationSeconds: number;
    readonly trackingState: string;
    readonly lastPointAt: string | null;
  } | null;
  /**
   * Fuel for the distance so far. Always an estimate, and null when the vehicle has no recorded
   * consumption — the screen then says nothing rather than showing a confident zero.
   */
  readonly fuel: {
    readonly liters: number;
    /** Null when the organization has not entered a fuel price. Litres still stand. */
    readonly cost: string | null;
    readonly currency: string;
    readonly pricePerLiter: string | null;
  } | null;
  readonly samplingPolicy: {
    readonly minIntervalSeconds: number;
    readonly minDistanceMeters: number;
  };
}

export interface DriverVehicle {
  readonly id: string;
  readonly registrationNumber: string;
  readonly make: string;
  readonly model: string;
  readonly vehicleType: string;
  readonly fuelType: string;
  readonly odometer: string;
  readonly isHeldByYou: boolean;
  readonly isYourUsual: boolean;
}

export interface TripSummary {
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly untrackedSeconds: number;
}

export interface TripHistoryRow {
  readonly id: string;
  readonly label: string | null;
  readonly plannedDistanceMeters: number | null;
  readonly status: TripStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly untrackedSeconds: number;
  readonly vehicle: { readonly registrationNumber: string };
}

export const driverApi = {
  state: () => apiRequest<DriverState>('/driver/state'),

  vehicles: () => apiRequest<{ vehicles: DriverVehicle[] }>('/driver/vehicles'),

  startTrip: (input: {
    vehicleId: string | null;
    label: string | null;
    plannedDistanceKm: number | null;
    startLatitude: number | null;
    startLongitude: number | null;
  }) =>
    apiRequest<{ tripId: string; vehicleId: string }>('/driver/trip/start', {
      method: 'POST',
      body: { clientActionId: actionId(), ...input },
    }),

  endTrip: (tripId: string, input: { endLatitude: number | null; endLongitude: number | null }) =>
    apiRequest<TripSummary>(`/driver/trip/${tripId}/end`, {
      method: 'POST',
      body: { clientActionId: actionId(), ...input },
    }),

  trips: () => apiRequest<{ trips: TripHistoryRow[] }>('/driver/trips', { query: { limit: 30 } }),

  /**
   * Uploads a batch of points.
   *
   * Called by the collector, which owns retry: this throws on failure and the points stay in the
   * device queue rather than being dropped. Timestamps go out as ISO strings because that is
   * what the server's schema accepts; the collector holds them as epoch milliseconds.
   */
  submitLocations: (tripId: string, points: readonly RawPoint[], online: boolean) =>
    apiRequest<{ accepted: number; rejected: number; state: string }>('/driver/location', {
      method: 'POST',
      body: {
        clientActionId: actionId(),
        tripId,
        deviceReported: online ? 'ONLINE' : 'OFFLINE',
        points: points.map((point) => ({
          timestamp: new Date(point.timestamp).toISOString(),
          latitude: point.latitude,
          longitude: point.longitude,
          accuracyMeters: point.accuracyMeters,
          speedMps: point.speedMps,
          heading: point.heading,
          altitude: point.altitude,
          source: point.source,
        })),
      },
    }),
};

/**
 * The device's current position, once, for the start or end of a trip.
 *
 * Resolves to null rather than rejecting. A driver who has not granted location yet must still
 * be able to start a trip — the trip is the record, and the first fix arrives moments later
 * through the collector. Refusing to start would mean the vehicle leaves untracked.
 */
export function currentPosition(timeoutMs = 8000): Promise<{ lat: number; lon: number } | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
    );
  });
}
