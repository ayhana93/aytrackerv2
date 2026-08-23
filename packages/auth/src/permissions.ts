/**
 * The single permission vocabulary.
 *
 * Nothing in the codebase may check a role name. Code checks permissions; roles are just named
 * bundles of permissions that an organization can edit. Adding a module means adding its
 * permission codes here and to the system roles below — nothing else changes.
 */

export const PERMISSIONS = {
  // --- organization & settings --------------------------------------------
  ORGANIZATION_READ: 'organization.read',
  ORGANIZATION_UPDATE: 'organization.update',
  SETTINGS_READ: 'settings.read',
  SETTINGS_UPDATE: 'settings.update',
  USERS_MANAGE: 'users.manage',
  BILLING_MANAGE: 'billing.manage',
  BRANDING_READ: 'branding.read',
  BRANDING_UPDATE: 'branding.update',
  AUDIT_READ: 'audit.read',

  // --- workforce -----------------------------------------------------------
  WORKERS_READ: 'workers.read',
  WORKERS_CREATE: 'workers.create',
  WORKERS_UPDATE: 'workers.update',
  WORKERS_DELETE: 'workers.delete',
  SITES_READ: 'sites.read',
  SITES_MANAGE: 'sites.manage',
  POSITIONS_READ: 'positions.read',
  POSITIONS_MANAGE: 'positions.manage',
  QUALIFICATIONS_READ: 'qualifications.read',
  QUALIFICATIONS_MANAGE: 'qualifications.manage',

  // --- shifts --------------------------------------------------------------
  SHIFTS_READ: 'shifts.read',
  SHIFTS_CREATE: 'shifts.create',
  SHIFTS_UPDATE: 'shifts.update',
  SHIFTS_DELETE: 'shifts.delete',
  /** Editing a historical shift, break or position session. Supervisor and above. */
  SHIFTS_CORRECT: 'shifts.correct',

  // --- worker self-service (held by a WORKER session, never by an admin user) ---
  WORKER_PORTAL_ACCESS: 'worker.portal.access',
  WORKER_SHIFT_START: 'worker.shift.start',
  WORKER_SHIFT_END: 'worker.shift.end',
  WORKER_BREAK_MANAGE: 'worker.break.manage',
  WORKER_POSITION_CHANGE: 'worker.position.change',
  WORKER_PRODUCTION_RECORD: 'worker.production.record',
  WORKER_HISTORY_READ: 'worker.history.read',

  // --- production ----------------------------------------------------------
  PRODUCTION_READ: 'production.read',
  PRODUCTION_CREATE: 'production.create',
  PRODUCTION_UPDATE: 'production.update',

  // --- reporting -----------------------------------------------------------
  REPORTS_READ: 'reports.read',
  REPORTS_EXPORT: 'reports.export',

  // --- drivers -------------------------------------------------------------
  DRIVERS_READ: 'drivers.read',
  DRIVERS_MANAGE: 'drivers.manage',

  /**
   * Driver self-service (held by a DRIVER session).
   *
   * There is deliberately no `driver.trip.pause`. A driver can start a trip and end a trip;
   * they cannot suspend the recording of one that is running. Pausing was the one control on
   * the driver's screen that let the vehicle keep moving while the record stopped — a hundred
   * kilometres of fuel with nothing to attribute it to. Standing still is already visible
   * without any button: it shows up as a stop on the route.
   */
  DRIVER_PORTAL_ACCESS: 'driver.portal.access',
  DRIVER_TRIP_START: 'driver.trip.start',
  DRIVER_TRIP_STOP: 'driver.trip.stop',
  /*
   * There is no `driver.location.submit`.
   *
   * It named a trip-scoped upload endpoint that no longer exists. Keeping a permission no route
   * checks would be worse than useless: a permission is a claim about what an actor may do, and
   * one nothing enforces is a claim that is not true. Reporting location is `tracking.submit`,
   * below, and it is held by workers and drivers alike because there is one stream.
   */
  /**
   * Reporting location into an open tracking session.
   *
   * Held by workers *and* drivers, because Option C is one stream: the same phone reports for
   * the working day and, when its owner is driving, for the trip inside it. Separate permissions
   * per context would have been separate pipelines wearing a permission's clothes.
   */
  TRACKING_SUBMIT: 'tracking.submit',
  DRIVER_TRIP_HISTORY: 'driver.trip.history',
  DRIVER_VEHICLE_VIEW: 'driver.vehicle.view',

  // --- fleet ---------------------------------------------------------------
  FLEET_READ: 'fleet.read',
  FLEET_CREATE: 'fleet.create',
  FLEET_UPDATE: 'fleet.update',
  FLEET_DELETE: 'fleet.delete',
  FLEET_ASSIGN: 'fleet.assign',
  FLEET_TRACKING_READ: 'fleet.tracking.read',
  FLEET_EXPENSES_READ: 'fleet.expenses.read',
  FLEET_EXPENSES_CREATE: 'fleet.expenses.create',
  FLEET_DOCUMENTS_MANAGE: 'fleet.documents.manage',

  // --- recommendations -----------------------------------------------------
  RECOMMENDATIONS_CREATE: 'recommendations.create',
  RECOMMENDATIONS_READ: 'recommendations.read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/** Rejects unknown permission codes when an organization edits a custom role. */
export function assertKnownPermissions(codes: readonly string[]): asserts codes is Permission[] {
  const unknown = codes.filter((code) => !PERMISSION_SET.has(code));
  if (unknown.length > 0) {
    throw new Error(`Unknown permission codes: ${unknown.join(', ')}`);
  }
}
