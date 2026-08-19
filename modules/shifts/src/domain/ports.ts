import type {
  ClientActionId,
  DriverId,
  OrganizationId,
  PositionId,
  PositionSessionId,
  ShiftId,
  ShiftTypeId,
  SiteId,
  TripId,
  VehicleId,
  WorkerId,
} from '@aytracker/types';
import type { BreakInterval, BreakType, ShiftStatus } from './shift.js';
import type { AssignmentContext, DriverProfile, SelectableVehicle } from './driving.js';
import type { PositionChangeSource, PositionSessionState } from './position-session.js';

export interface ShiftRecord {
  readonly id: ShiftId;
  readonly organizationId: OrganizationId;
  readonly siteId: SiteId;
  readonly workerId: WorkerId;
  readonly shiftTypeId: ShiftTypeId | null;
  readonly status: ShiftStatus;
  readonly scheduledStart: Date | null;
  readonly scheduledEnd: Date | null;
  readonly actualStart: Date | null;
  readonly actualEnd: Date | null;
  readonly workedSeconds: number | null;
  readonly breakSeconds: number | null;
}

export interface ShiftRepository {
  findById(organizationId: OrganizationId, shiftId: ShiftId): Promise<ShiftRecord | null>;
  /** The worker's ACTIVE or ON_BREAK shift, if any. At most one exists by database constraint. */
  findOpenForWorker(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<ShiftRecord | null>;
  create(input: {
    organizationId: OrganizationId;
    siteId: SiteId;
    workerId: WorkerId;
    shiftTypeId: ShiftTypeId | null;
    status: ShiftStatus;
    actualStart: Date;
    scheduledStart: Date | null;
    scheduledEnd: Date | null;
  }): Promise<ShiftRecord>;
  updateStatus(
    organizationId: OrganizationId,
    shiftId: ShiftId,
    status: ShiftStatus,
  ): Promise<void>;
  close(input: {
    organizationId: OrganizationId;
    shiftId: ShiftId;
    actualEnd: Date;
    workedSeconds: number;
    breakSeconds: number;
    autoClosed: boolean;
  }): Promise<void>;
  listForWorker(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<readonly ShiftRecord[]>;
  /** Shifts still open past their maximum duration — input to the auto-close job. */
  listOverrunning(input: {
    organizationId: OrganizationId;
    olderThan: Date;
  }): Promise<readonly ShiftRecord[]>;
}

export interface ShiftBreakRepository {
  findOpen(
    organizationId: OrganizationId,
    shiftId: ShiftId,
  ): Promise<{ id: string; startedAt: Date; type: BreakType } | null>;
  listForShift(organizationId: OrganizationId, shiftId: ShiftId): Promise<readonly BreakInterval[]>;
  open(input: {
    organizationId: OrganizationId;
    shiftId: ShiftId;
    type: BreakType;
    startedAt: Date;
  }): Promise<{ id: string }>;
  close(input: {
    organizationId: OrganizationId;
    breakId: string;
    endedAt: Date;
    durationSeconds: number;
  }): Promise<void>;
}

export interface PositionSessionRepository {
  findOpenForShift(
    organizationId: OrganizationId,
    shiftId: ShiftId,
  ): Promise<PositionSessionState | null>;
  findById(
    organizationId: OrganizationId,
    sessionId: PositionSessionId,
  ): Promise<PositionSessionState | null>;
  listForShift(
    organizationId: OrganizationId,
    shiftId: ShiftId,
  ): Promise<readonly PositionSessionState[]>;
  open(input: {
    organizationId: OrganizationId;
    shiftId: ShiftId;
    workerId: WorkerId;
    positionId: PositionId;
    startedAt: Date;
    source: PositionChangeSource;
  }): Promise<PositionSessionState>;
  close(input: {
    organizationId: OrganizationId;
    sessionId: PositionSessionId;
    endedAt: Date;
    durationSeconds: number;
  }): Promise<void>;
  correct(input: {
    organizationId: OrganizationId;
    sessionId: PositionSessionId;
    startedAt: Date;
    endedAt: Date | null;
    durationSeconds: number | null;
    correctedAt: Date;
  }): Promise<void>;
}

/**
 * Idempotency ledger.
 *
 * Every offline-capable mutation carries a client-generated `clientActionId`. A replay returns
 * the stored response instead of executing the command a second time — which is what stops a
 * flaky connection from producing two shifts, two position changes or two trips.
 */
export interface IdempotencyStore {
  /**
   * Claims the key. Returns the stored response when this action already completed, or null
   * when the caller now owns execution.
   *
   * A key already claimed but not finished (a concurrent duplicate in flight) must raise a
   * conflict rather than execute again.
   */
  claim(input: {
    organizationId: OrganizationId;
    actorType: 'USER' | 'WORKER' | 'DRIVER';
    actorId: string;
    clientActionId: ClientActionId;
    endpoint: string;
    requestHash: string;
    ttlSeconds: number;
  }): Promise<{ replayed: true; response: unknown } | { replayed: false }>;

  complete(input: {
    organizationId: OrganizationId;
    actorType: 'USER' | 'WORKER' | 'DRIVER';
    actorId: string;
    clientActionId: ClientActionId;
    response: unknown;
    status: number;
  }): Promise<void>;

  /** Releases a claim so a failed command can be retried rather than being wedged. */
  release(input: {
    organizationId: OrganizationId;
    actorType: 'USER' | 'WORKER' | 'DRIVER';
    actorId: string;
    clientActionId: ClientActionId;
  }): Promise<void>;
}

/** Unit of work: everything a command touches commits or rolls back together. */
export interface ShiftUnitOfWork {
  readonly shifts: ShiftRepository;
  readonly breaks: ShiftBreakRepository;
  readonly positionSessions: PositionSessionRepository;
  readonly driving: DrivingRepository;
}

export interface TransactionRunner {
  run<T>(organizationId: OrganizationId, fn: (uow: ShiftUnitOfWork) => Promise<T>): Promise<T>;
}

/**
 * The driving handoff.
 *
 * Defined here, in the module that orchestrates the position change, and implemented by an
 * adapter that is allowed to touch the fleet and driver tables. The alternative — calling the
 * drivers and fleet modules' own services — would mean three transactions where the whole point
 * is that the position change, the vehicle assignment and the trip commit together.
 *
 * This is the one place the shifts module reaches beyond its own tables, and it does so through
 * a contract it owns. See docs/driving-handoff.md.
 */
export interface DrivingRepository {
  /** The driver profile linked to this worker, if there is one. */
  findDriverForWorker(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<DriverProfile | null>;

  /** Every vehicle at the site, with its current assignment, for the picker to filter. */
  listVehiclesForSelection(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    siteId: SiteId | null;
  }): Promise<readonly SelectableVehicle[]>;

  /** The open assignments relevant to one selection decision. */
  loadAssignmentContext(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
  }): Promise<AssignmentContext>;

  createAssignment(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    startedAt: Date;
    isAutomatic: boolean;
  }): Promise<{ assignmentId: string }>;

  /** Closes an assignment only if it was created automatically by a previous handoff. */
  closeAutomaticAssignment(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    endedAt: Date;
  }): Promise<{ closed: boolean }>;

  startTrip(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    vehicleId: VehicleId;
    positionSessionId: PositionSessionId;
    label: string | null;
    startedAt: Date;
    startLatitude: number | null;
    startLongitude: number | null;
  }): Promise<{ tripId: TripId }>;

  /** The open trip attached to a position session, if any. */
  findTripForSession(
    organizationId: OrganizationId,
    positionSessionId: PositionSessionId,
  ): Promise<{
    tripId: TripId;
    driverId: DriverId;
    vehicleId: VehicleId;
    status: 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
    startedAt: Date | null;
  } | null>;

  /** Closes the trip, computing its distance from the stored points. */
  closeTrip(input: {
    organizationId: OrganizationId;
    tripId: TripId;
    endedAt: Date;
  }): Promise<{ distanceMeters: number; durationSeconds: number; untrackedSeconds: number }>;
}
