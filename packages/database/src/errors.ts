import { ConflictError, DomainError, NotFoundError, ValidationError } from '@aytracker/domain';
import { isForeignKeyViolation, isNotFound, violatedConstraintName } from './client.js';

/**
 * Maps database constraint violations onto domain errors.
 *
 * Every entry here corresponds to a partial unique index or check constraint in
 * `invariants_and_rls/migration.sql`. Two transactions racing to open a second position session
 * both pass the application check; one of them loses at the index, and this is what turns that
 * loss into "you already have an open session" instead of a 500.
 */
const CONSTRAINT_TO_ERROR: Readonly<Record<string, () => DomainError>> = {
  shifts_one_open_per_worker: () =>
    new ConflictError('shift.already_active', 'Worker already has a shift in progress.'),
  shift_breaks_one_open_per_shift: () =>
    new ConflictError('shift.break_already_active', 'This shift already has an open break.'),
  position_sessions_one_open_per_shift: () =>
    new ConflictError(
      'position.session_already_open',
      'This shift already has an open position session.',
    ),
  position_sessions_one_open_per_worker: () =>
    new ConflictError(
      'position.session_already_open',
      'This worker already has an open position session.',
    ),
  driver_trips_one_open_per_driver: () =>
    new ConflictError('trip.already_active', 'Driver already has a trip in progress.'),
  driver_trips_one_open_per_vehicle: () =>
    new ConflictError('trip.vehicle_busy', 'This vehicle is already on an active trip.'),
  vehicle_assignments_one_open_per_vehicle: () =>
    new ConflictError('fleet.vehicle_already_assigned', 'This vehicle is already assigned.'),
  vehicle_assignments_one_open_per_driver: () =>
    new ConflictError('fleet.driver_already_assigned', 'This driver already has a vehicle.'),
  subscriptions_one_live_per_org: () =>
    new ConflictError('billing.subscription_exists', 'Organization already has a subscription.'),

  // Check constraints.
  shifts_end_after_start: () =>
    new ValidationError('shift.end_before_start', 'Shift end must not precede its start.'),
  position_sessions_end_after_start: () =>
    new ValidationError('position.end_before_start', 'Session end must not precede its start.'),
  production_entries_non_negative_quantities: () =>
    new ValidationError('production.negative_quantity', 'Quantities must not be negative.'),
  fuel_expenses_positive_liters: () =>
    new ValidationError('fuel.invalid_liters', 'Litres must be greater than zero.'),
  trip_location_points_valid_coordinates: () =>
    new ValidationError('tracking.invalid_coordinates', 'Coordinates are out of range.'),
  driver_trips_odometer_forward: () =>
    new ValidationError('trip.odometer_backwards', 'End odometer must not precede the start.'),
  sessions_actor_matches_type: () =>
    new ValidationError('auth.invalid_session_actor', 'Session actor does not match its type.'),

  // Composite tenant foreign keys — these firing means someone tried to reference another
  // tenant's row. That is a security event, not a validation nicety.
  work_areas_site_same_tenant: crossTenant,
  positions_site_same_tenant: crossTenant,
  positions_work_area_same_tenant: crossTenant,
  shifts_site_same_tenant: crossTenant,
  shifts_worker_same_tenant: crossTenant,
  position_sessions_position_same_tenant: crossTenant,
  position_sessions_worker_same_tenant: crossTenant,
  production_entries_position_same_tenant: crossTenant,
  driver_trips_driver_same_tenant: crossTenant,
  driver_trips_vehicle_same_tenant: crossTenant,
  vehicle_assignments_driver_same_tenant: crossTenant,
  vehicle_assignments_vehicle_same_tenant: crossTenant,
  fuel_expenses_vehicle_same_tenant: crossTenant,
};

function crossTenant(): DomainError {
  // Surfaced as NOT_FOUND at the HTTP edge; the specific code is what the security log records.
  return new NotFoundError('tenant.cross_reference', 'Referenced record is in another organization.');
}

/**
 * Translates a Prisma error into a domain error, or returns null when it is not one we
 * recognize — in which case the caller must let it propagate rather than swallow it.
 */
export function translateDatabaseError(error: unknown): DomainError | null {
  const constraint = violatedConstraintName(error);
  if (constraint) {
    const factory = CONSTRAINT_TO_ERROR[constraint];
    if (factory) return factory();
  }
  if (isNotFound(error)) {
    return new NotFoundError('record.not_found', 'Record not found.');
  }
  if (isForeignKeyViolation(error)) {
    return new ValidationError('record.invalid_reference', 'Referenced record does not exist.');
  }
  return null;
}

/** Runs `fn`, converting recognized database errors into domain errors. */
export async function withTranslatedErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const translated = translateDatabaseError(error);
    if (translated) throw translated;
    throw error;
  }
}
