/**
 * English message catalog — the reference catalog.
 *
 * Every other language is typed against `MessageCatalog`, so a missing or misspelled key is a
 * compile error rather than a `[object Object]` in front of a customer.
 *
 * Keys are dotted and grouped by domain. Error keys mirror the `code` on DomainError, which is
 * how a machine-readable error becomes a translated sentence without business logic ever
 * touching a user-facing string.
 */
export const en = {
  // --- generic ------------------------------------------------------------
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.offline': 'Offline',
  'common.online': 'Online',
  'common.syncing': 'Syncing…',
  'common.synced': 'All changes saved',

  // --- authentication ------------------------------------------------------
  'auth.login': 'Log in',
  'auth.logout': 'Log out',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.employee_number': 'Employee ID',
  'auth.driver_code': 'Driver ID',
  'auth.pin': 'PIN',
  'auth.welcome': 'Welcome',
  'auth.unauthenticated': 'Please log in to continue.',
  'auth.invalid_credentials': 'Those details do not match. Please try again.',
  'auth.account_locked': 'Too many attempts. Try again in {seconds} seconds.',
  'auth.permission_denied': 'You do not have permission to do that.',
  'auth.session_expired': 'Your session has ended. Please log in again.',
  'auth.pin_too_weak': 'Choose a PIN that is not a repeated digit or a simple sequence.',
  'auth.pin_invalid_length': 'The PIN must be between {min} and {max} digits.',

  // --- shifts --------------------------------------------------------------
  'shift.start': 'Start shift',
  'shift.end': 'End shift',
  'shift.active': 'Shift in progress',
  'shift.on_break': 'On break',
  'shift.break_start': 'Start break',
  'shift.break_end': 'End break',
  'shift.duration': 'Duration',
  'shift.already_active': 'You already have a shift in progress.',
  'shift.not_active': 'You do not have a shift in progress.',
  'shift.ended': 'Shift ended',

  // --- positions -----------------------------------------------------------
  'position.change': 'Change position',
  'position.current': 'Current position',
  'position.available': 'Available positions',
  'position.confirm_change': 'Move from {from} to {to}?',
  'position.changed': 'Position changed',
  'position.not_eligible': 'You are not currently assigned to that position.',
  'position.qualification_required': 'That position requires a qualification you do not hold.',
  'position.supervisor_approval_required': 'That position needs supervisor approval.',
  'position.inactive': 'That position is not currently in use.',
  'position.history': 'Position history',
  'position.scan_qr': 'Scan position code',

  // --- production ----------------------------------------------------------
  'production.record': 'Record production',
  'production.good_quantity': 'Good',
  'production.defect_quantity': 'Defects',
  'production.recorded': 'Production recorded',

  // --- driver & tracking ---------------------------------------------------
  'driver.assigned_vehicle': 'Assigned vehicle',
  'driver.no_vehicle': 'No vehicle assigned',
  'driver.start_trip': 'Start trip',
  'driver.pause_trip': 'Pause',
  'driver.resume_trip': 'Resume',
  'driver.end_trip': 'End trip',
  'driver.trip_history': 'Trip history',
  'driver.distance': 'Distance',
  'driver.duration': 'Duration',

  'tracking.active': 'Location tracking active',
  'tracking.started_at': 'Tracking started {time}',
  'tracking.state.ACTIVE': 'Tracking active',
  'tracking.state.DEGRADED': 'Weak location signal',
  'tracking.state.PAUSED': 'Tracking paused',
  'tracking.state.INTERRUPTED': 'Tracking interrupted',
  'tracking.state.OFFLINE': 'Device offline',
  'tracking.state.STOPPED': 'Tracking stopped',

  // Neutral by design: these describe what was observed, never why.
  'tracking.event.started': 'Tracking started',
  'tracking.event.stopped': 'Tracking stopped',
  'tracking.event.paused': 'Tracking paused',
  'tracking.event.resumed': 'Tracking resumed',
  'tracking.event.signal_degraded': 'Location signal weak',
  'tracking.event.location_unavailable': 'Location unavailable',
  'tracking.event.permission_disabled': 'Location permission not granted',
  'tracking.event.device_offline': 'Device offline',
  'tracking.event.app_not_reporting': 'App no longer reporting',
  'tracking.event.reporting_recovered': 'Location updates resumed',
  'tracking.event.geofence_enter': 'Entered {name}',
  'tracking.event.geofence_exit': 'Left {name}',
  'tracking.event.speed_exceeded': 'Speed {peak} km/h over a {limit} km/h limit',
  'tracking.gap': 'No location data between {from} and {to}',
  'tracking.permission_prompt': 'AYtracker needs location access to record this trip.',

  // --- fleet ---------------------------------------------------------------
  'fleet.vehicles': 'Vehicles',
  'fleet.drivers': 'Drivers',
  'fleet.assignments': 'Assignments',
  'fleet.trips': 'Trips',
  'fleet.fuel': 'Fuel',
  'fleet.expenses': 'Costs',
  'fleet.documents': 'Documents',
  'fleet.odometer': 'Odometer',
  'fleet.cost_per_km': 'Cost per km',
  'fleet.estimated_fuel_cost': 'Estimated fuel cost',
  'fleet.actual_fuel_cost': 'Actual fuel cost',
  'fleet.document_expiring': '{document} expires in {days} days',
  'fleet.document_expired': '{document} expired {days} days ago',

  // --- recommendations -----------------------------------------------------
  'recommendations.title': 'Have an idea?',
  'recommendations.field_title': 'Title',
  'recommendations.field_description': 'Description',
  'recommendations.category': 'Category',
  'recommendations.priority': 'Priority',
  'recommendations.submit': 'Submit',
  'recommendations.submitted': 'Thank you — we have received your suggestion.',
  'recommendations.status.SUBMITTED': 'Submitted',
  'recommendations.status.UNDER_REVIEW': 'Under review',
  'recommendations.status.PLANNED': 'Planned',
  'recommendations.status.IN_DEVELOPMENT': 'In development',
  'recommendations.status.RELEASED': 'Released',
  'recommendations.status.DECLINED': 'Declined',
  'recommendations.status.DUPLICATE': 'Duplicate',

  // --- billing & entitlements ----------------------------------------------
  'billing.plan': 'Plan',
  'billing.upgrade': 'Upgrade',
  'entitlement.required': 'This feature is not included in your current plan.',

  // --- errors --------------------------------------------------------------
  'error.generic': 'Something went wrong. Please try again.',
  'error.network': 'No connection. Your changes are saved and will sync automatically.',
  'error.not_found': 'Not found.',
  'error.conflict': 'That has already been done.',
  'error.rate_limited': 'Too many requests. Please wait a moment.',
  'error.validation': 'Please check the highlighted fields.',
} as const;

export type MessageKey = keyof typeof en;
export type MessageCatalog = Readonly<Record<MessageKey, string>>;
