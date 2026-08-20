/**
 * @aytracker/module-shifts — shift lifecycle, breaks and position sessions.
 *
 * Depends on `workforce` for eligibility through its published query service. It does not read
 * workforce tables, and workforce has never heard of shifts.
 */

export {
  assertCanEndBreak,
  assertCanStartBreak,
  assertTransition,
  autoCloseAt,
  canTransition,
  computeShiftDuration,
  isDeductible,
  isOpen,
  reconcileClientTimestamp,
  shouldAutoClose,
  type BreakInterval,
  type BreakType,
  type ShiftDuration,
  type ShiftState,
  type ShiftStatus,
} from './domain/shift.js';

export {
  analyzeSwitching,
  planPositionChange,
  planSessionClose,
  summarizeByPosition,
  validateCorrection,
  type PositionChangePlan,
  type PositionChangeSource,
  type PositionSessionState,
  type PositionTotal,
  type SwitchingPattern,
} from './domain/position-session.js';

export type {
  IdempotencyStore,
  PositionSessionRepository,
  ShiftBreakRepository,
  ShiftRecord,
  ShiftRepository,
  ShiftUnitOfWork,
  TransactionRunner,
} from './domain/ports.js';

export {
  ShiftCommandService,
  type ChangePositionInput,
  type ShiftPolicy,
  type StartShiftInput,
} from './application/shift-commands.js';

export {
  PrismaIdempotencyStore,
  PrismaPositionSessionRepository,
  PrismaShiftBreakRepository,
  PrismaShiftRepository,
  PrismaShiftTransactionRunner,
  hashRequestBody,
} from './infrastructure/prisma-repositories.js';

export {
  DRIVING_SESSION_PERMISSIONS,
  assertCanDrive,
  assertCanEndDriving,
  isDrivingPosition,
  planAssignment,
  selectableVehicles,
  withDrivingPermissions,
  withoutDrivingPermissions,
  type AssignmentContext,
  type AssignmentPlan,
  type DriverProfile,
  type DrivingContext,
  type PositionKind,
  type SelectableVehicle,
} from './domain/driving.js';

export type { DrivingRepository } from './domain/ports.js';

export { DrivingCommandService } from './application/driving-commands.js';

export { PrismaDrivingRepository } from './infrastructure/prisma-driving-repository.js';
