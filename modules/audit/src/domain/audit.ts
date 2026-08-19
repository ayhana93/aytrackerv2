import type { OrganizationId } from '@aytracker/types';

/**
 * Audit vocabulary and redaction.
 *
 * Two rules govern what goes into an audit entry:
 *   1. Enough to answer "who changed what, when, and from where" months later.
 *   2. Never a secret. A hash, a PIN, a session token or a card number in an audit log is a
 *      breach waiting to be discovered — so redaction happens here, on the way in, rather than
 *      being left to each caller to remember.
 */

export const AUDIT_ACTIONS = {
  // authentication
  LOGIN_SUCCEEDED: 'auth.login_succeeded',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  SESSION_REVOKED: 'auth.session_revoked',
  PIN_CHANGED: 'auth.pin_changed',
  PASSWORD_CHANGED: 'auth.password_changed',

  // access control
  ROLE_ASSIGNED: 'access.role_assigned',
  ROLE_UPDATED: 'access.role_updated',
  MEMBER_INVITED: 'access.member_invited',
  MEMBER_REMOVED: 'access.member_removed',

  // workforce
  WORKER_CREATED: 'worker.created',
  WORKER_UPDATED: 'worker.updated',
  WORKER_DELETED: 'worker.deleted',
  QUALIFICATION_GRANTED: 'worker.qualification_granted',
  ELIGIBILITY_CHANGED: 'worker.eligibility_changed',

  // shifts & production
  SHIFT_CORRECTED: 'shift.corrected',
  POSITION_SESSION_CORRECTED: 'position.session_corrected',
  PRODUCTION_CORRECTED: 'production.corrected',

  // drivers & fleet
  TRIP_CORRECTED: 'trip.corrected',
  VEHICLE_CREATED: 'fleet.vehicle_created',
  VEHICLE_UPDATED: 'fleet.vehicle_updated',
  VEHICLE_ASSIGNED: 'fleet.vehicle_assigned',
  VEHICLE_UNASSIGNED: 'fleet.vehicle_unassigned',
  EXPENSE_CREATED: 'fleet.expense_created',
  EXPENSE_UPDATED: 'fleet.expense_updated',

  // platform
  BRANDING_UPDATED: 'branding.updated',
  SETTINGS_UPDATED: 'settings.updated',
  BILLING_CHANGED: 'billing.changed',
  ENTITLEMENT_GRANTED: 'billing.entitlement_granted',
  DATA_EXPORTED: 'data.exported',
  DATA_IMPORTED: 'data.imported',

  // security
  CROSS_TENANT_ATTEMPT: 'security.cross_tenant_attempt',
  RATE_LIMIT_TRIPPED: 'security.rate_limit_tripped',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  readonly organizationId: OrganizationId;
  readonly action: AuditAction | string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorUserId: string | null;
  readonly actorWorkerId: string | null;
  readonly actorDriverId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly createdAt: Date;
}

/** Keys never written to an audit entry, whatever a caller passes. */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'pin',
  'pinhash',
  'token',
  'tokenhash',
  'secret',
  'apikey',
  'authorization',
  'cookie',
  'sessiontoken',
  'csrftoken',
  'cardnumber',
  'cvv',
  'iban',
]);

export const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * Strips secrets from an arbitrary metadata object, recursively.
 *
 * Matching is on the lowercased key with separators removed, so `pin_hash`, `pinHash` and
 * `PIN-HASH` are all caught.
 */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED_PLACEHOLDER;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactMetadata(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    result[key] = REDACTED_KEYS.has(normalized)
      ? REDACTED_PLACEHOLDER
      : redactMetadata(entry, depth + 1);
  }
  return result;
}

/**
 * Truncates an IP address for storage.
 *
 * The last octet (IPv4) or the interface identifier (IPv6) is dropped: enough to investigate a
 * pattern of access, not enough to be a precise location record of an employee. Full addresses
 * live only in short-retention security logs.
 */
export function truncateIpAddress(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (ip.includes(':')) {
    const groups = ip.split(':');
    return `${groups.slice(0, 4).join(':')}::`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  return `${octets.slice(0, 3).join('.')}.0`;
}

export function buildAuditEntry(input: {
  organizationId: OrganizationId;
  action: AuditAction | string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  actorWorkerId?: string | null;
  actorDriverId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  now: Date;
}): AuditEntry {
  return {
    organizationId: input.organizationId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    actorUserId: input.actorUserId ?? null,
    actorWorkerId: input.actorWorkerId ?? null,
    actorDriverId: input.actorDriverId ?? null,
    metadata: (redactMetadata(input.metadata ?? {}) as Record<string, unknown>) ?? {},
    ipAddress: truncateIpAddress(input.ipAddress),
    userAgent: input.userAgent?.slice(0, 512) ?? null,
    requestId: input.requestId ?? null,
    createdAt: input.now,
  };
}

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
  writeMany(entries: readonly AuditEntry[]): Promise<void>;
}
