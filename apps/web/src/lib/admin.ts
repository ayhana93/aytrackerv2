'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest } from './api';

/**
 * Typed reads for the admin portal, plus the hook the screens use.
 *
 * The types are written here by hand rather than generated. They are the contract the screen
 * relies on, and writing them out means a field the API stops sending fails to typecheck instead
 * of arriving as `undefined` and rendering as "NaN км".
 */

export interface DashboardResponse {
  readonly range: { from: string; to: string };
  readonly totals: {
    producedGood: number;
    producedScrap: number;
    activeWorkers: number;
    trips: number;
    distanceMeters: number;
    untrackedSeconds: number;
  };
  readonly hourly: readonly { hour: string; good: number; scrap: number }[];
  readonly byWorkArea: readonly { name: string; produced: number }[];
  readonly activePositions: readonly {
    id: string;
    worker: string;
    position: string;
    kind: 'STANDARD' | 'DRIVING';
    startedAt: string;
    onBreak: boolean;
  }[];
  readonly warnings: readonly {
    id: string;
    kind: string;
    subject: string;
    detail: string;
    severity: 'WARNING' | 'CRITICAL';
  }[];
}

export type WorkerStatus = 'ACTIVE' | 'INACTIVE' | 'ON_LEAVE' | 'TERMINATED';

export interface WorkerRow {
  readonly id: string;
  readonly employeeNumber: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: WorkerStatus;
  /**
   * Whether a PIN exists. Never the PIN, and never its hash — the server does not send either,
   * and an admin who forgets one sets a new one rather than reading the old one back. That is
   * what makes it a credential rather than a note in a database.
   */
  readonly hasPin: boolean;
  /** Locked out by failed attempts, until this moment. Null when they can try again now. */
  readonly lockedUntil: string | null;
  readonly createdAt?: string;
  readonly driver: { id?: string; code: string; status?: string } | null;
}

export interface CreateWorkerInput {
  readonly employeeNumber: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone?: string | null;
  readonly pin?: string;
  readonly isDriver?: boolean;
  readonly driverCode?: string;
}

export interface UpdateWorkerInput {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phone?: string | null;
  readonly pin?: string;
  readonly status?: 'ACTIVE' | 'INACTIVE';
}

export type VehicleType = 'CAR' | 'VAN' | 'TRUCK' | 'BUS' | 'FORKLIFT' | 'OTHER';
export type FuelType = 'PETROL' | 'DIESEL' | 'LPG' | 'CNG' | 'ELECTRIC' | 'HYBRID' | 'OTHER';

export interface VehicleRow {
  readonly id: string;
  readonly registrationNumber: string;
  readonly make: string;
  readonly model: string;
  readonly vehicleType: VehicleType;
  readonly fuelType: FuelType;
  readonly status: 'ACTIVE' | 'IN_MAINTENANCE' | 'OUT_OF_SERVICE' | 'SOLD' | 'ARCHIVED';
  readonly odometer: string;
  readonly averageConsumption: string | null;
  readonly driver: { id: string; name: string; since: string; automatic: boolean } | null;
}

/**
 * What registering a vehicle needs.
 *
 * Decimals travel as strings, matching how they come back: `odometerCurrent` is a Decimal column,
 * and a number that goes out as a float and returns as a string is the kind of asymmetry that
 * produces a mileage rendered as `1.4832e5`.
 */
export interface CreateVehicleInput {
  readonly registrationNumber: string;
  readonly make: string;
  readonly model: string;
  readonly vehicleType: VehicleType;
  readonly fuelType: FuelType;
  readonly odometerCurrent?: string;
  /**
   * Litres per 100 km. Optional, and the one optional field worth asking for at registration:
   * without it no fuel figure can be produced for this vehicle at all — not on the driver's
   * screen, not in a cost report.
   */
  readonly averageConsumption?: string | null;
  readonly year?: number | null;
  readonly vin?: string | null;
  readonly notes?: string;
}

export interface TripRow {
  readonly id: string;
  readonly label: string | null;
  readonly status: 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly untrackedSeconds: number;
  readonly trackingState: string;
  readonly driver: string;
  readonly vehicle: string;
}

export interface TrackResponse {
  readonly trip: {
    id: string;
    label: string | null;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    distanceMeters: number;
    durationSeconds: number;
    pausedSeconds: number;
    untrackedSeconds: number;
    trackingState: string;
    driver: string;
    vehicle: { registrationNumber: string; make: string; model: string };
  };
  readonly track: {
    points: readonly { latitude: number; longitude: number }[];
    distanceMeters: number;
    /** Draw a break after each of these indices. Never a straight line across. */
    gapAfterIndices: readonly number[];
    pointCount: number;
  };
  /**
   * Where the vehicle stood still for twenty minutes or more.
   *
   * Computed on the server, from timestamps the browser is never sent. The threshold is the
   * server's to decide — and a figure a client can recompute is a figure a client can change.
   */
  readonly stops: readonly {
    latitude: number;
    longitude: number;
    startedAt: string;
    endedAt: string;
    seconds: number;
  }[];
  readonly gaps: readonly {
    startedAt: string;
    endedAt: string | null;
    seconds: number;
    isOpen: boolean;
  }[];
  readonly events: readonly {
    type: string;
    state: string;
    occurredAt: string;
    gapSeconds: number | null;
  }[];
}

export type PositionKind = 'STANDARD' | 'DRIVING';
export type RecordStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

export interface PositionRow {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly kind: PositionKind;
  readonly capacity: number | null;
  readonly status: RecordStatus;
  /** How many people are standing on it right now. */
  readonly occupied: number;
}

export interface WorkAreaRow {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly description: string | null;
  readonly status: RecordStatus;
  readonly positions: readonly PositionRow[];
}

export interface HistoryRow {
  readonly id: string;
  readonly worker: string;
  readonly workerId: string;
  readonly employeeNumber: string;
  readonly position: string;
  readonly positionKind: PositionKind;
  readonly workArea: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly seconds: number;
  /** Still running: the duration is "so far", not a total. */
  readonly isOpen: boolean;
  readonly source: string;
  readonly wasCorrected: boolean;
}

export interface HistoryResponse {
  readonly range: { from: string; to: string };
  readonly sessions: readonly HistoryRow[];
  /**
   * Totals per person, computed server-side over the whole range.
   *
   * Not derived from `sessions`: that list is capped, so summing it in the browser would under-
   * report the moment an organization crosses the cap.
   */
  readonly byWorker: readonly {
    workerId: string;
    worker: string;
    seconds: number;
    sessions: number;
    open: boolean;
  }[];
  readonly truncated: boolean;
}

/**
 * How this organization is configured to behave.
 *
 * `fuelPricePerLiter` is a string, like every decimal that crosses the wire: it is money, and a
 * float that survives one round trip does not survive three.
 */
export interface SettingsResponse {
  readonly fuelPricePerLiter: string | null;
  readonly currency: string;
  readonly timezone: string;
  readonly allowWorkerSelfShiftStart: boolean;
  readonly maxShiftDurationMinutes: number;
  readonly gpsMinIntervalSeconds: number;
  readonly gpsMinDistanceMeters: number;
}

export interface UpdateSettingsInput {
  readonly fuelPricePerLiter?: string | null;
  readonly allowWorkerSelfShiftStart?: boolean;
  readonly maxShiftDurationMinutes?: number;
  readonly gpsMinIntervalSeconds?: number;
  readonly gpsMinDistanceMeters?: number;
}

/**
 * One person or vehicle currently being tracked.
 *
 * Everything here is the server's: the state, the speed, how stale the last fix is. The browser
 * places a marker and renders a label — it does not decide whether somebody counts as "live".
 */
export interface LiveSubject {
  readonly id: string;
  readonly context: 'WORK' | 'DRIVER_TRIP';
  readonly name: string;
  readonly employeeNumber: string | null;
  readonly position: string | null;
  readonly onBreak: boolean;
  readonly startedAt: string;
  readonly distanceMeters: number;
  readonly trackingState: string;
  readonly lastPointAt: string | null;
  readonly secondsSinceFix: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly speedKph: number | null;
  readonly accuracyMeters: number | null;
  readonly batteryLevel: number | null;
  readonly devicePermission: string | null;
  readonly vehicle: {
    readonly registrationNumber: string;
    readonly make: string;
    readonly model: string;
  } | null;
  readonly trip: {
    readonly id: string;
    readonly label: string | null;
    readonly startedAt: string | null;
    readonly distanceMeters: number;
  } | null;
  /**
   * Whether the position is the vehicle's or the phone's.
   *
   * A phone in a driver's pocket is not the van. Saying which is which is the difference between
   * a fact and an assumption somebody will act on.
   */
  readonly positionSource: 'DEVICE';
}

export interface LiveResponse {
  readonly serverTime: string;
  readonly subjects: readonly LiveSubject[];
}

/** One employee's day: the working route, with the driver trips inside it marked. */
export interface LiveTrackResponse {
  readonly session: {
    readonly id: string;
    readonly context: 'WORK' | 'DRIVER_TRIP';
    readonly worker: string | null;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly distanceMeters: number;
    readonly untrackedSeconds: number;
  };
  readonly track: {
    readonly points: readonly { latitude: number; longitude: number }[];
    readonly distanceMeters: number;
    readonly gapAfterIndices: readonly number[];
    readonly pointCount: number;
  };
  readonly segments: readonly {
    readonly context: 'WORK' | 'DRIVER_TRIP';
    readonly tripId: string | null;
    readonly from: string;
    readonly to: string;
    readonly pointCount: number;
  }[];
  readonly stops: readonly {
    readonly latitude: number;
    readonly longitude: number;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly seconds: number;
  }[];
  readonly gaps: readonly {
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly seconds: number;
    readonly isOpen: boolean;
  }[];
}

export interface BrandingResponse {
  readonly companyName: string;
  readonly slug: string;
  readonly primaryColor: string | null;
  readonly loginMessage: string | null;
  readonly customDomain: string | null;
  readonly logoUrl: string | null;
}

export const adminApi = {
  dashboard: (query?: { from?: string; to?: string }) =>
    apiRequest<DashboardResponse>('/admin/dashboard', { query }),
  vehicles: () => apiRequest<{ vehicles: VehicleRow[] }>('/admin/vehicles'),
  createVehicle: (body: CreateVehicleInput) =>
    apiRequest<{ vehicle: VehicleRow }>('/admin/vehicles', { method: 'POST', body }),
  trips: (query?: { from?: string; to?: string; limit?: number }) =>
    apiRequest<{ trips: TripRow[] }>('/admin/trips', { query }),
  track: (tripId: string) => apiRequest<TrackResponse>(`/admin/trips/${tripId}/track`),
  branding: () => apiRequest<BrandingResponse>('/admin/branding'),

  live: () => apiRequest<LiveResponse>('/admin/live'),
  liveTrack: (sessionId: string) => apiRequest<LiveTrackResponse>(`/admin/live/${sessionId}/track`),

  settings: () => apiRequest<SettingsResponse>('/admin/settings'),
  updateSettings: (body: UpdateSettingsInput) =>
    apiRequest<SettingsResponse>('/admin/settings', { method: 'PATCH', body }),

  workers: () => apiRequest<{ workers: WorkerRow[] }>('/admin/workers'),
  createWorker: (body: CreateWorkerInput) =>
    apiRequest<{ worker: WorkerRow }>('/admin/workers', { method: 'POST', body }),
  updateWorker: (workerId: string, body: UpdateWorkerInput) =>
    apiRequest<{ worker: WorkerRow }>(`/admin/workers/${workerId}`, { method: 'PATCH', body }),

  areas: () => apiRequest<{ areas: WorkAreaRow[] }>('/admin/areas'),
  createArea: (body: { name: string; description?: string }) =>
    apiRequest<{ area: WorkAreaRow }>('/admin/areas', { method: 'POST', body }),
  updateArea: (areaId: string, body: { name?: string; status?: 'ACTIVE' | 'ARCHIVED' }) =>
    apiRequest<{ area: WorkAreaRow }>(`/admin/areas/${areaId}`, { method: 'PATCH', body }),

  createPosition: (body: {
    workAreaId: string;
    name: string;
    kind: PositionKind;
    capacity?: number | null;
  }) => apiRequest<{ position: PositionRow }>('/admin/positions', { method: 'POST', body }),
  updatePosition: (
    positionId: string,
    body: { name?: string; kind?: PositionKind; status?: 'ACTIVE' | 'ARCHIVED' },
  ) =>
    apiRequest<{ position: PositionRow }>(`/admin/positions/${positionId}`, {
      method: 'PATCH',
      body,
    }),

  history: (query?: { from?: string; to?: string; workAreaId?: string; limit?: number }) =>
    apiRequest<HistoryResponse>('/admin/history', { query }),
};

export type LoadState<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ApiError };

/**
 * Loads once and reports all three states.
 *
 * Three, not two: a screen that models only "loading" and "data" renders an empty dashboard when
 * the request fails, which reads as "the factory produced nothing today" rather than "we could
 * not ask". Those are very different things to tell a plant manager.
 */
export function useApi<T>(load: () => Promise<T>, deps: readonly unknown[] = []): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });

  /**
   * The loader is kept in a ref and the caller's `deps` are the only trigger.
   *
   * Callers pass an inline arrow, so `load` is a different function on every render; depending
   * on it directly would refetch forever. Holding it in a ref and keying the effect on `deps`
   * says exactly what is meant — reload when these values change — without a lint suppression
   * standing in for the explanation.
   */
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    loadRef
      .current()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, 'network.unreachable', 'NETWORK', String(error)),
        });
      });

    // Guards against a slow first request resolving after a fast second one and overwriting it.
    return () => {
      cancelled = true;
    };
  }, deps);

  return state;
}

/** What to tell someone when a request failed, by cause rather than by status code. */
export function describeError(error: ApiError): string {
  if (error.isUnauthenticated) return 'Сесията изтече. Влезте отново.';
  if (error.isEntitlement) return 'Тази функция не е включена във вашия абонамент.';
  if (error.isForbidden) return 'Нямате достъп до тези данни.';
  if (error.kind === 'NETWORK') return 'Няма връзка със сървъра.';
  return 'Данните не можаха да се заредят.';
}
