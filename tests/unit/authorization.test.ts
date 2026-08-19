import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_DEFINITIONS,
  assertOwnDriver,
  assertOwnWorker,
  assertPermission,
  assertSameTenant,
  hasPermission,
  isTriviallyGuessablePin,
  assertPinPolicy,
  generatePin,
  isLockedOut,
  registerFailure,
  registerSuccess,
  secondsUntilUnlock,
  systemRole,
  validateSession,
  DEFAULT_PIN_LOCKOUT,
} from '@aytracker/auth';
import { Entitlements, FEATURES, isInRollout } from '@aytracker/billing';
import type { ActorContext, OrganizationId } from '@aytracker/types';

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorType: 'USER',
    organizationId: 'org-1' as OrganizationId,
    permissions: [PERMISSIONS.SHIFTS_READ],
    sessionId: 'session-1',
    isPlatformAdmin: false,
    ...overrides,
  };
}

describe('permission checks', () => {
  it('allows a held permission', () => {
    expect(hasPermission(actor(), PERMISSIONS.SHIFTS_READ)).toBe(true);
    expect(() => assertPermission(actor(), PERMISSIONS.SHIFTS_READ)).not.toThrow();
  });

  it('refuses a permission the actor does not hold', () => {
    expect(() => assertPermission(actor(), PERMISSIONS.SHIFTS_DELETE)).toThrowError(
      /missing permission/i,
    );
  });

  it('refuses cross-tenant access', () => {
    expect(() => assertSameTenant(actor(), 'org-2')).toThrowError(/different organization/i);
    expect(() => assertSameTenant(actor(), 'org-1')).not.toThrow();
  });
});

describe('self-service scoping', () => {
  const worker = actor({ actorType: 'WORKER', workerId: 'worker-1' as never, permissions: [] });
  const driver = actor({ actorType: 'DRIVER', driverId: 'driver-1' as never, permissions: [] });

  it('lets a worker act on their own record', () => {
    expect(() => assertOwnWorker(worker, 'worker-1')).not.toThrow();
  });

  it('refuses a worker acting on another worker', () => {
    expect(() => assertOwnWorker(worker, 'worker-2')).toThrowError(/own records/i);
  });

  it('refuses a non-worker session on a worker route', () => {
    expect(() => assertOwnWorker(actor(), 'worker-1')).toThrowError(/worker session/i);
  });

  it('refuses a driver reading another driver', () => {
    expect(() => assertOwnDriver(driver, 'driver-2')).toThrowError(/own records/i);
    expect(() => assertOwnDriver(driver, 'driver-1')).not.toThrow();
  });
});

describe('system roles', () => {
  it('gives the owner billing and the admin not', () => {
    expect(systemRole(SYSTEM_ROLES.OWNER).permissions).toContain(PERMISSIONS.BILLING_MANAGE);
    expect(systemRole(SYSTEM_ROLES.ADMIN).permissions).not.toContain(PERMISSIONS.BILLING_MANAGE);
  });

  it('gives a supervisor correction rights and a viewer none', () => {
    expect(systemRole(SYSTEM_ROLES.SUPERVISOR).permissions).toContain(PERMISSIONS.SHIFTS_CORRECT);
    expect(systemRole(SYSTEM_ROLES.VIEWER).permissions).not.toContain(PERMISSIONS.SHIFTS_CORRECT);
  });

  /**
   * The worker role must be strictly self-service. If an admin permission ever leaks into it,
   * every worker in every tenant gains it at once — so this is asserted, not assumed.
   */
  it('gives a worker only worker.* permissions', () => {
    const workerPermissions = systemRole(SYSTEM_ROLES.WORKER).permissions;
    expect(workerPermissions.every((permission) => permission.startsWith('worker.'))).toBe(true);
    expect(workerPermissions).not.toContain(PERMISSIONS.WORKERS_READ);
    expect(workerPermissions).not.toContain(PERMISSIONS.REPORTS_READ);
    expect(workerPermissions).not.toContain(PERMISSIONS.SHIFTS_CORRECT);
  });

  it('gives a driver only driver.* permissions', () => {
    const driverPermissions = systemRole(SYSTEM_ROLES.DRIVER).permissions;
    expect(driverPermissions.every((permission) => permission.startsWith('driver.'))).toBe(true);
    expect(driverPermissions).not.toContain(PERMISSIONS.FLEET_READ);
    expect(driverPermissions).not.toContain(PERMISSIONS.DRIVERS_READ);
  });

  it('never assigns worker or driver roles to a user session', () => {
    for (const role of SYSTEM_ROLE_DEFINITIONS) {
      if (role.actorType === 'USER') {
        expect(role.permissions.some((permission) => permission.startsWith('worker.'))).toBe(false);
        expect(role.permissions.some((permission) => permission.startsWith('driver.'))).toBe(false);
      }
    }
  });

  it('only grants permissions from the known vocabulary', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const role of SYSTEM_ROLE_DEFINITIONS) {
      for (const permission of role.permissions) {
        expect(known.has(permission)).toBe(true);
      }
    }
  });
});

describe('PIN policy', () => {
  it('rejects repeated digits and simple sequences', () => {
    expect(isTriviallyGuessablePin('0000')).toBe(true);
    expect(isTriviallyGuessablePin('1111')).toBe(true);
    expect(isTriviallyGuessablePin('1234')).toBe(true);
    expect(isTriviallyGuessablePin('4321')).toBe(true);
    expect(isTriviallyGuessablePin('482913')).toBe(false);
  });

  it('enforces length and numeric-only', () => {
    expect(() => assertPinPolicy('123')).toThrowError(/between/i);
    expect(() => assertPinPolicy('123456789')).toThrowError(/between/i);
    expect(() => assertPinPolicy('12a4')).toThrowError(/digits only/i);
    expect(() => assertPinPolicy('482913')).not.toThrow();
  });

  it('generates PINs that satisfy the policy', () => {
    for (let i = 0; i < 50; i += 1) {
      const pin = generatePin(6);
      expect(pin).toMatch(/^\d{6}$/);
      expect(isTriviallyGuessablePin(pin)).toBe(false);
    }
  });
});

describe('lockout', () => {
  const now = new Date('2026-03-10T09:00:00Z');

  it('does not lock before the threshold', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < DEFAULT_PIN_LOCKOUT.threshold - 1; i += 1) {
      state = registerFailure(state, now, DEFAULT_PIN_LOCKOUT);
    }
    expect(isLockedOut(state, now)).toBe(false);
  });

  it('locks at the threshold and backs off exponentially', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < DEFAULT_PIN_LOCKOUT.threshold; i += 1) {
      state = registerFailure(state, now, DEFAULT_PIN_LOCKOUT);
    }
    expect(isLockedOut(state, now)).toBe(true);
    expect(secondsUntilUnlock(state, now)).toBe(60);

    state = registerFailure(state, now, DEFAULT_PIN_LOCKOUT);
    expect(secondsUntilUnlock(state, now)).toBe(120);
  });

  it('caps the lock duration', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < 40; i += 1) {
      state = registerFailure(state, now, DEFAULT_PIN_LOCKOUT);
    }
    expect(secondsUntilUnlock(state, now)).toBe(DEFAULT_PIN_LOCKOUT.maxLockSeconds);
  });

  it('clears on success', () => {
    expect(registerSuccess()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });

  it('expires the lock once the window passes', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < DEFAULT_PIN_LOCKOUT.threshold; i += 1) {
      state = registerFailure(state, now, DEFAULT_PIN_LOCKOUT);
    }
    expect(isLockedOut(state, new Date(now.getTime() + 61_000))).toBe(false);
  });
});

describe('session validation', () => {
  const now = new Date('2026-03-10T09:00:00Z');
  const base = {
    id: 'session-1',
    actorType: 'USER' as const,
    organizationId: 'org-1',
    userId: 'user-1',
    workerId: null,
    driverId: null,
    permissions: [],
    expiresAt: new Date('2026-03-10T20:00:00Z'),
    revokedAt: null as Date | null,
  };

  it('accepts a live session', () => {
    expect(validateSession(base, now)).toEqual({ valid: true });
  });

  it('rejects an expired session', () => {
    expect(
      validateSession({ ...base, expiresAt: new Date('2026-03-10T08:00:00Z') }, now),
    ).toEqual({ valid: false, reason: 'EXPIRED' });
  });

  it('rejects a revoked session', () => {
    expect(validateSession({ ...base, revokedAt: now }, now)).toEqual({
      valid: false,
      reason: 'REVOKED',
    });
  });

  it('rejects a worker session with no tenant', () => {
    expect(
      validateSession(
        { ...base, actorType: 'WORKER', workerId: 'worker-1', userId: null, organizationId: null },
        now,
      ),
    ).toEqual({ valid: false, reason: 'NO_TENANT' });
  });
});

describe('entitlements', () => {
  const snapshot = {
    organizationId: 'org-1' as OrganizationId,
    entitlements: [
      { featureCode: FEATURES.WORKFORCE, isEnabled: true, limit: null, expiresAt: null },
      { featureCode: FEATURES.FLEET_MANAGEMENT, isEnabled: true, limit: 5, expiresAt: null },
      { featureCode: FEATURES.GPS_TRACKING, isEnabled: false, limit: null, expiresAt: null },
      {
        featureCode: FEATURES.AI_ASSISTANT,
        isEnabled: true,
        limit: null,
        expiresAt: new Date('2026-01-01T00:00:00Z'),
      },
    ],
    marketBlockedFeatures: [] as string[],
    resolvedAt: new Date('2026-03-10T09:00:00Z'),
  };
  const now = new Date('2026-03-10T09:00:00Z');

  it('allows a granted feature and refuses an ungranted one', () => {
    const entitlements = new Entitlements(snapshot, now);
    expect(entitlements.can(FEATURES.WORKFORCE)).toBe(true);
    expect(entitlements.can(FEATURES.GPS_TRACKING)).toBe(false);
    expect(entitlements.can(FEATURES.INTEGRATIONS)).toBe(false);
  });

  it('refuses an expired grant', () => {
    expect(new Entitlements(snapshot, now).can(FEATURES.AI_ASSISTANT)).toBe(false);
  });

  it('throws with the feature code so the client can offer the right upgrade', () => {
    expect(() => new Entitlements(snapshot, now).require(FEATURES.GPS_TRACKING)).toThrowError(
      /fleet.gps_tracking/,
    );
  });

  it('enforces a metered limit', () => {
    const entitlements = new Entitlements(snapshot, now);
    expect(entitlements.canAdd(FEATURES.FLEET_MANAGEMENT, 4)).toBe(true);
    expect(entitlements.canAdd(FEATURES.FLEET_MANAGEMENT, 5)).toBe(false);
    expect(() => entitlements.requireCapacity(FEATURES.FLEET_MANAGEMENT, 5)).toThrowError(
      /fleet.management/,
    );
  });

  /** A market block beats a plan grant — it exists for regulatory carve-outs. */
  it('lets a market block override a plan grant', () => {
    const blocked = new Entitlements(
      { ...snapshot, marketBlockedFeatures: [FEATURES.WORKFORCE] },
      now,
    );
    expect(blocked.can(FEATURES.WORKFORCE)).toBe(false);
  });
});

describe('feature-flag rollout', () => {
  it('is stable for the same organization', () => {
    const first = isInRollout('new-dashboard', 'org-1', 50);
    for (let i = 0; i < 20; i += 1) {
      expect(isInRollout('new-dashboard', 'org-1', 50)).toBe(first);
    }
  });

  it('honours the 0 % and 100 % edges', () => {
    expect(isInRollout('flag', 'org-1', 0)).toBe(false);
    expect(isInRollout('flag', 'org-1', 100)).toBe(true);
  });

  it('does not put the same organizations in every 10 % rollout', () => {
    const orgs = Array.from({ length: 200 }, (_, index) => `org-${index}`);
    const a = orgs.filter((org) => isInRollout('flag-a', org, 10));
    const b = orgs.filter((org) => isInRollout('flag-b', org, 10));
    expect(a).not.toEqual(b);
  });

  it('lands roughly on the requested percentage', () => {
    const orgs = Array.from({ length: 2000 }, (_, index) => `org-${index}`);
    const included = orgs.filter((org) => isInRollout('flag', org, 25)).length;
    expect(included / orgs.length).toBeGreaterThan(0.2);
    expect(included / orgs.length).toBeLessThan(0.3);
  });
});
