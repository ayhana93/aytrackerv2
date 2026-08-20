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

export interface VehicleRow {
  readonly id: string;
  readonly registrationNumber: string;
  readonly make: string;
  readonly model: string;
  readonly vehicleType: string;
  readonly fuelType: string;
  readonly status: 'ACTIVE' | 'IN_MAINTENANCE' | 'OUT_OF_SERVICE' | 'SOLD' | 'ARCHIVED';
  readonly odometer: string;
  readonly averageConsumption: string | null;
  readonly driver: { id: string; name: string; since: string; automatic: boolean } | null;
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
  trips: (query?: { from?: string; to?: string; limit?: number }) =>
    apiRequest<{ trips: TripRow[] }>('/admin/trips', { query }),
  track: (tripId: string) => apiRequest<TrackResponse>(`/admin/trips/${tripId}/track`),
  branding: () => apiRequest<BrandingResponse>('/admin/branding'),
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
