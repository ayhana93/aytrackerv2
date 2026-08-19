/**
 * @aytracker/module-fleet — vehicles, assignments, expenses and document expiration.
 *
 * Depends on `drivers` for the driver-side vocabulary, never the other way round: the drivers
 * module reaches fleet only through the DriverVehicleAccess port it defines itself.
 */

export {
  compareFuel,
  summarizeVehicleCosts,
  type ExpenseCategory,
  type ExpenseLine,
  type FuelComparison,
  type VehicleCostBreakdown,
} from './domain/expenses.js';

export {
  CRITICAL_THRESHOLD_DAYS,
  evaluateExpiration,
  pendingExpirations,
  type ExpirableItem,
  type ExpirationSeverity,
  type ExpirationStatus,
} from './domain/expiration.js';

export {
  assertCanAssign,
  assertCanUnassign,
  isOpenAssignment,
  type AssignmentState,
} from './domain/assignment.js';
