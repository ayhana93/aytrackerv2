/**
 * @aytracker/module-drivers — the trip lifecycle.
 *
 * What a trip is, when one may start and end, and what its final numbers are. It does **not**
 * own location collection: `@aytracker/module-tracking` owns the single ingestion path for the
 * whole product, because an employee's working day needs the same admission rules and is not a
 * trip. This module reads a trip's points back through a narrow port when it closes one.
 *
 * Depends on @aytracker/tracking for the pure geometry, and on the fleet module only through the
 * DriverVehicleAccess port — which is why a driver's assigned vehicle can be resolved without
 * this module knowing what a vehicle table looks like.
 */

export {
  assertNoOpenTrip,
  assertTransition,
  canTransition,
  computeTripTotals,
  isTripOpen,
  type PauseInterval,
  type TripState,
  type TripStatus,
  type TripTotals,
} from './domain/trip.js';

export type {
  DriverTransactionRunner,
  DriverUnitOfWork,
  DriverVehicleAccess,
  TripPointAccess,
  TripRepository,
} from './domain/ports.js';

export { TripCommandService, assertDriverScope } from './application/trip-commands.js';

export {
  PrismaDriverTransactionRunner,
  PrismaDriverVehicleAccess,
  PrismaTripPointAccess,
  PrismaTripRepository,
} from './infrastructure/prisma-repositories.js';
