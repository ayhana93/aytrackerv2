/**
 * @aytracker/module-tracking — one GPS engine, two contexts.
 *
 * Everything that writes or reads a location point goes through here. `modules/drivers` owns
 * what a trip *is*; this module owns when a device may report, where the points land, and what
 * the resulting numbers are. That split is what stops the product growing a second pipeline the
 * day somebody needs to track an employee who is not driving.
 *
 * The privacy rule is structural, not documentary: a point requires an open session, and a
 * session requires a shift or a trip.
 */

export {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MAX_LOCATION_BATCH_SIZE,
  admitPoints,
  isValidCoordinate,
  type AdmissionResult,
  type AdmittedLocationPoint,
  type RawLocationPoint,
  type TripWindow,
} from './domain/admission.js';

export {
  assertCloseAfterStart,
  assertNoOpenSession,
  assertSessionOpen,
  isOpen,
  normalizeTelemetry,
  tripForTimestamp,
  type DevicePermission,
  type DeviceTelemetry,
  type TrackingContext,
  type TrackingSessionId,
  type TrackingSessionState,
} from './domain/session.js';

export type {
  ComputedVisit,
  GeofenceAccess,
  LocationPointRepository,
  TrackedPoint,
  TrackingEventRepository,
  TrackingSessionRepository,
  TrackingTransactionRunner,
  TrackingUnitOfWork,
  TripWindowAccess,
} from './domain/ports.js';

export { TrackingCommandService } from './application/tracking-commands.js';

export {
  PrismaGeofenceAccess,
  PrismaLocationPointRepository,
  PrismaTrackingEventRepository,
  PrismaTrackingSessionRepository,
  PrismaTrackingTransactionRunner,
  PrismaTripWindowAccess,
} from './infrastructure/prisma-repositories.js';
