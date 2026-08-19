import { ForbiddenError, UnauthenticatedError } from '@aytracker/domain';
import type { ActorContext, DriverId, OrganizationId, WorkerId } from '@aytracker/types';
import type { Permission } from './permissions.js';

/**
 * Authorization primitives.
 *
 * Every check answers one of three questions, in this order:
 *   1. Is the caller inside the right tenant?      → assertSameTenant
 *   2. Does the caller hold the permission?        → assertPermission
 *   3. Is this the caller's own record?            → assertOwnWorker / assertOwnDriver
 *
 * Skipping (1) is how tenant leaks happen; skipping (3) is how a worker reads another worker's
 * shift. Both are cheap, so both run on every tenant-scoped route.
 */

export function hasPermission(actor: ActorContext, permission: Permission): boolean {
  return actor.permissions.includes(permission);
}

export function hasAnyPermission(actor: ActorContext, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => actor.permissions.includes(permission));
}

export function hasAllPermissions(
  actor: ActorContext,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((permission) => actor.permissions.includes(permission));
}

export function assertAuthenticated(
  actor: ActorContext | undefined,
): asserts actor is ActorContext {
  if (!actor) throw new UnauthenticatedError();
}

export function assertPermission(actor: ActorContext, permission: Permission): void {
  if (!hasPermission(actor, permission)) {
    throw new ForbiddenError('auth.permission_denied', `Missing permission: ${permission}`, {
      details: { required: permission },
    });
  }
}

export function assertAnyPermission(actor: ActorContext, permissions: readonly Permission[]): void {
  if (!hasAnyPermission(actor, permissions)) {
    throw new ForbiddenError(
      'auth.permission_denied',
      `Missing one of: ${permissions.join(', ')}`,
      {
        details: { requiredAnyOf: permissions },
      },
    );
  }
}

/**
 * Guards a resource's tenant against the caller's.
 *
 * Reported as FORBIDDEN here; the HTTP layer downgrades it to 404 so the response cannot be
 * used to probe for the existence of another tenant's rows.
 */
export function assertSameTenant(actor: ActorContext, resourceOrganizationId: string): void {
  if (actor.organizationId !== resourceOrganizationId) {
    throw new ForbiddenError('auth.cross_tenant', 'Resource belongs to a different organization.', {
      details: { resourceOrganizationId },
    });
  }
}

/** A worker session may only act on its own worker record. */
export function assertOwnWorker(actor: ActorContext, workerId: WorkerId | string): void {
  if (actor.actorType !== 'WORKER') {
    throw new ForbiddenError('auth.not_worker_session', 'This action requires a worker session.');
  }
  if (actor.workerId !== workerId) {
    throw new ForbiddenError('auth.not_own_worker', 'Workers may only act on their own records.');
  }
}

/** A driver session may only act on its own driver record — never another driver's trip. */
export function assertOwnDriver(actor: ActorContext, driverId: DriverId | string): void {
  if (actor.actorType !== 'DRIVER') {
    throw new ForbiddenError('auth.not_driver_session', 'This action requires a driver session.');
  }
  if (actor.driverId !== driverId) {
    throw new ForbiddenError('auth.not_own_driver', 'Drivers may only act on their own records.');
  }
}

export function assertActorType(
  actor: ActorContext,
  allowed: readonly ActorContext['actorType'][],
): void {
  if (!allowed.includes(actor.actorType)) {
    throw new ForbiddenError(
      'auth.wrong_actor_type',
      `Requires actor type: ${allowed.join(' | ')}`,
    );
  }
}

/**
 * The tenant scope every repository read must be given. Constructing it from anything but an
 * ActorContext is a code smell — that is the whole point of the type.
 */
export interface TenantScope {
  readonly organizationId: OrganizationId;
}

export function tenantScope(actor: ActorContext): TenantScope {
  return { organizationId: actor.organizationId };
}
