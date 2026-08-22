'use client';

import { apiRequest } from './api';

/**
 * `/api/v1/worker` — everything the worker portal can do.
 *
 * The types are written out by hand, like `lib/admin.ts`, because they are the contract the
 * screen depends on: a field the server stops sending should fail to typecheck rather than
 * arrive as `undefined` and render as an empty position name.
 *
 * Every mutation carries a `clientActionId`. It is not decoration — the server keys its
 * idempotency ledger on it, so a worker who taps "Започни смяна" twice on a slow connection
 * starts one shift and sees the same answer twice, rather than starting one and being told the
 * second time that they already have one.
 */

export type PositionKind = 'STANDARD' | 'DRIVING';
export type ShiftStatus = 'ACTIVE' | 'ON_BREAK' | 'COMPLETED' | 'CANCELLED';
export type BreakType = 'PAID' | 'UNPAID' | 'MEAL' | 'TECHNICAL';

export interface AvailablePosition {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly kind: PositionKind;
  readonly workArea: string | null;
  readonly requiresApproval: boolean;
  readonly isCurrent: boolean;
}

export interface WorkerState {
  /** The server's clock. Every elapsed time on screen is measured against this. */
  readonly serverTime: string;
  readonly worker: {
    readonly id: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly employeeNumber: string;
    readonly preferredLocale: string | null;
    readonly site: { readonly id: string; readonly name: string } | null;
    readonly isDriver: boolean;
  };
  readonly shift: {
    readonly id: string;
    readonly status: ShiftStatus;
    readonly actualStart: string | null;
    readonly currentPosition: {
      readonly sessionId: string;
      readonly positionId: string;
      readonly name: string;
      readonly kind: PositionKind;
      readonly workArea: string | null;
      readonly startedAt: string;
    } | null;
    readonly openBreak: {
      readonly id: string;
      readonly type: BreakType;
      readonly startedAt: string;
    } | null;
    /** Set while this worker is out in a vehicle. The portal hands them to the driver screen. */
    readonly activeTripId: string | null;
  } | null;
  /**
   * The working day's GPS stream, when the organization tracks it.
   *
   * Present only while a shift is open — closing the shift closes the session, and the server
   * then refuses points. The collector runs for exactly as long as this id exists.
   */
  readonly tracking: {
    readonly sessionId: string;
    readonly startedAt: string;
    readonly distanceMeters: number;
    readonly trackingState: string;
    readonly lastPointAt: string | null;
    readonly samplingPolicy: {
      readonly minIntervalSeconds: number;
      readonly minDistanceMeters: number;
    };
  } | null;
  readonly availablePositions: readonly AvailablePosition[];
  readonly policy: { readonly allowWorkerSelfShiftStart: boolean };
}

export interface SelectableVehicle {
  readonly id: string;
  readonly registrationNumber: string;
  readonly make: string;
  readonly model: string;
  readonly vehicleType: string;
  readonly fuelType: string;
  readonly odometer: string;
  readonly isCurrent: boolean;
}

export interface EndShiftResult {
  readonly shiftId: string;
  readonly workedSeconds: number;
  readonly breakSeconds: number;
}

/**
 * A fresh idempotency key per logical action.
 *
 * `crypto.randomUUID` is unavailable on http:// origins that are not localhost, which is exactly
 * how someone tries this on a factory tablet against a LAN address. The fallback is a v4-shaped
 * id from `getRandomValues`; it only has to be unique per action, and the server validates the
 * shape rather than the entropy.
 */
export function actionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PositionHistoryRow {
  readonly id: string;
  readonly positionId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationSeconds: number | null;
  readonly position: { readonly name: string; readonly code: string };
}

export const workerApi = {
  state: () => apiRequest<WorkerState>('/worker/state'),

  positionHistory: () => apiRequest<{ sessions: PositionHistoryRow[] }>('/worker/position/history'),

  startShift: (input: { initialPositionId?: string | null }) =>
    apiRequest<{ shiftId: string; trackingSessionId: string }>('/worker/shift/start', {
      method: 'POST',
      body: {
        clientActionId: actionId(),
        // The site is resolved from the worker's own record on the server. A phone has no
        // business naming one.
        initialPositionId: input.initialPositionId ?? null,
      },
    }),

  endShift: () =>
    apiRequest<EndShiftResult>('/worker/shift/end', {
      method: 'POST',
      body: { clientActionId: actionId() },
    }),

  startBreak: (type: BreakType) =>
    apiRequest<{ breakId: string }>('/worker/break/start', {
      method: 'POST',
      body: { clientActionId: actionId(), type },
    }),

  endBreak: () =>
    apiRequest<{ durationSeconds: number }>('/worker/break/end', {
      method: 'POST',
      body: { clientActionId: actionId() },
    }),

  changePosition: (positionId: string) =>
    apiRequest<{ shiftId: string; openedSessionId: string }>('/worker/position/change', {
      method: 'POST',
      body: { clientActionId: actionId(), positionId },
    }),

  vehiclesFor: (positionId: string) =>
    apiRequest<{ vehicles: SelectableVehicle[] }>(`/worker/positions/${positionId}/vehicles`),

  beginDriving: (input: {
    positionId: string;
    vehicleId: string;
    label: string | null;
    startLatitude: number | null;
    startLongitude: number | null;
  }) =>
    apiRequest<{ tripId: string; redirectTo: string }>('/worker/driving/begin', {
      method: 'POST',
      body: { clientActionId: actionId(), ...input },
    }),
};
