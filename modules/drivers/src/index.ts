/**
 * @aytracker/module-drivers — driver portal domain: trips, GPS ingestion and tracking state.
 *
 * Depends on @aytracker/tracking for the pure geometry and state rules, and on the fleet module
 * only through the DriverVehicleAccess port — which is why a driver's assigned vehicle can be
 * resolved without this module knowing what a vehicle table looks like.
 */

export {
  MAX_LOCATION_BATCH_SIZE,
  assertNoOpenTrip,
  assertTransition,
  canTransition,
  computeTripTotals,
  isTripOpen,
  isValidCoordinate,
  validateLocationBatch,
  type AcceptedLocationPoint,
  type LocationBatchResult,
  type PauseInterval,
  type RawLocationPoint,
  type TripState,
  type TripStatus,
  type TripTotals,
} from './domain/trip.js';

export type {
  DriverTransactionRunner,
  DriverUnitOfWork,
  DriverVehicleAccess,
  LocationPointRepository,
  TrackingEventRepository,
  TripRepository,
} from './domain/ports.js';

export { TripCommandService, assertDriverScope } from './application/trip-commands.js';

export {
  PrismaDriverTransactionRunner,
  PrismaDriverVehicleAccess,
  PrismaLocationPointRepository,
  PrismaTrackingEventRepository,
  PrismaTripRepository,
} from './infrastructure/prisma-repositories.js';
