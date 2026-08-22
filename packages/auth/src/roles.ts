import { PERMISSIONS, type Permission } from './permissions.js';

/**
 * System roles. Seeded once, immutable, shared by every tenant.
 *
 * An organization may create custom roles, but never edit these — support needs a fixed point
 * of reference when a customer asks "why can my supervisor do X".
 */
export const SYSTEM_ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MANAGER: 'manager',
  SUPERVISOR: 'supervisor',
  VIEWER: 'viewer',
  /** Assigned to WORKER sessions. Never assignable to a user account. */
  WORKER: 'worker',
  /** Assigned to DRIVER sessions. Never assignable to a user account. */
  DRIVER: 'driver',
} as const;

export type SystemRoleCode = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

const P = PERMISSIONS;

const VIEWER_PERMISSIONS: Permission[] = [
  P.ORGANIZATION_READ,
  P.SETTINGS_READ,
  P.BRANDING_READ,
  P.WORKERS_READ,
  P.SITES_READ,
  P.POSITIONS_READ,
  P.QUALIFICATIONS_READ,
  P.SHIFTS_READ,
  P.PRODUCTION_READ,
  P.REPORTS_READ,
  P.DRIVERS_READ,
  P.FLEET_READ,
  P.FLEET_EXPENSES_READ,
  P.RECOMMENDATIONS_READ,
];

const SUPERVISOR_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  P.SHIFTS_CREATE,
  P.SHIFTS_UPDATE,
  P.SHIFTS_CORRECT,
  P.PRODUCTION_CREATE,
  P.PRODUCTION_UPDATE,
  P.WORKERS_UPDATE,
  P.QUALIFICATIONS_MANAGE,
  P.FLEET_TRACKING_READ,
  P.RECOMMENDATIONS_CREATE,
];

const MANAGER_PERMISSIONS: Permission[] = [
  ...SUPERVISOR_PERMISSIONS,
  P.WORKERS_CREATE,
  P.WORKERS_DELETE,
  P.SITES_MANAGE,
  P.POSITIONS_MANAGE,
  P.SHIFTS_DELETE,
  P.REPORTS_EXPORT,
  P.DRIVERS_MANAGE,
  P.FLEET_CREATE,
  P.FLEET_UPDATE,
  P.FLEET_DELETE,
  P.FLEET_ASSIGN,
  P.FLEET_EXPENSES_CREATE,
  P.FLEET_DOCUMENTS_MANAGE,
  P.AUDIT_READ,
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...MANAGER_PERMISSIONS,
  P.ORGANIZATION_UPDATE,
  P.SETTINGS_UPDATE,
  P.USERS_MANAGE,
  P.BRANDING_UPDATE,
];

const OWNER_PERMISSIONS: Permission[] = [...ADMIN_PERMISSIONS, P.BILLING_MANAGE];

/**
 * A worker gets exactly the self-service permissions. Notably absent: any `*.read` permission
 * that would expose another worker's data, and anything under `shifts.*` — a worker acts on
 * their own shift through the worker.* commands, which resolve the shift from the session.
 */
const WORKER_PERMISSIONS: Permission[] = [
  P.WORKER_PORTAL_ACCESS,
  P.WORKER_SHIFT_START,
  P.WORKER_SHIFT_END,
  P.WORKER_BREAK_MANAGE,
  P.WORKER_POSITION_CHANGE,
  P.WORKER_PRODUCTION_RECORD,
  P.WORKER_HISTORY_READ,
];

const DRIVER_PERMISSIONS: Permission[] = [
  P.DRIVER_PORTAL_ACCESS,
  P.DRIVER_TRIP_START,
  P.DRIVER_TRIP_STOP,
  P.DRIVER_LOCATION_SUBMIT,
  P.DRIVER_TRIP_HISTORY,
  P.DRIVER_VEHICLE_VIEW,
];

export interface SystemRoleDefinition {
  readonly code: SystemRoleCode;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly Permission[];
  /** Roles that may only back a session of this actor type. */
  readonly actorType: 'USER' | 'WORKER' | 'DRIVER';
}

export const SYSTEM_ROLE_DEFINITIONS: readonly SystemRoleDefinition[] = [
  {
    code: SYSTEM_ROLES.OWNER,
    name: 'Owner',
    description: 'Full access including billing.',
    permissions: dedupe(OWNER_PERMISSIONS),
    actorType: 'USER',
  },
  {
    code: SYSTEM_ROLES.ADMIN,
    name: 'Administrator',
    description: 'Full operational access; no billing.',
    permissions: dedupe(ADMIN_PERMISSIONS),
    actorType: 'USER',
  },
  {
    code: SYSTEM_ROLES.MANAGER,
    name: 'Manager',
    description: 'Manages workforce, fleet and reporting.',
    permissions: dedupe(MANAGER_PERMISSIONS),
    actorType: 'USER',
  },
  {
    code: SYSTEM_ROLES.SUPERVISOR,
    name: 'Supervisor',
    description: 'Runs the floor and corrects historical records.',
    permissions: dedupe(SUPERVISOR_PERMISSIONS),
    actorType: 'USER',
  },
  {
    code: SYSTEM_ROLES.VIEWER,
    name: 'Viewer',
    description: 'Read-only access.',
    permissions: dedupe(VIEWER_PERMISSIONS),
    actorType: 'USER',
  },
  {
    code: SYSTEM_ROLES.WORKER,
    name: 'Worker',
    description: 'Worker portal self-service.',
    permissions: dedupe(WORKER_PERMISSIONS),
    actorType: 'WORKER',
  },
  {
    code: SYSTEM_ROLES.DRIVER,
    name: 'Driver',
    description: 'Driver portal self-service.',
    permissions: dedupe(DRIVER_PERMISSIONS),
    actorType: 'DRIVER',
  },
];

export function systemRole(code: SystemRoleCode): SystemRoleDefinition {
  const found = SYSTEM_ROLE_DEFINITIONS.find((role) => role.code === code);
  if (!found) throw new Error(`Unknown system role: ${code}`);
  return found;
}

function dedupe(permissions: readonly Permission[]): readonly Permission[] {
  return [...new Set(permissions)].sort();
}
