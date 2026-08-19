import {
  DEFAULT_PASSWORD_LOCKOUT,
  DEFAULT_PIN_LOCKOUT,
  SYSTEM_ROLES,
  burnVerificationTime,
  isLockedOut,
  registerFailure,
  registerSuccess,
  secondsUntilUnlock,
  systemRole,
  verifyPassword,
  verifyPin,
} from '@aytracker/auth';
import type { PrismaClient } from '@aytracker/database';
import { ForbiddenError, RateLimitedError, UnauthenticatedError } from '@aytracker/domain';
import type { ActorType } from '@aytracker/types';

/**
 * Credential verification.
 *
 * Every failure path returns the same error and takes comparable time. An attacker must not be
 * able to tell "no such employee number" from "wrong PIN" from "that organization does not
 * exist" — otherwise the login form becomes an employee-directory oracle.
 */

const GENERIC_FAILURE = () =>
  new UnauthenticatedError('auth.invalid_credentials', 'Invalid credentials.');

export interface AuthenticatedActor {
  readonly actorType: ActorType;
  readonly organizationId: string | null;
  readonly userId: string | null;
  readonly workerId: string | null;
  readonly driverId: string | null;
  readonly permissions: readonly string[];
}

export class AuthService {
  constructor(private readonly prisma: PrismaClient) {}

  async authenticateAdmin(input: {
    email: string;
    password: string;
    ipAddress: string | null;
    userAgent: string | null;
    now: Date;
  }): Promise<AuthenticatedActor> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        passwordHash: true,
        isActive: true,
        isPlatformAdmin: true,
        memberships: {
          where: { status: 'ACTIVE' },
          select: {
            organizationId: true,
            role: { select: { permissions: true } },
            organization: { select: { status: true } },
          },
          take: 2,
        },
      },
    });

    if (!user || !user.isActive) {
      await burnVerificationTime();
      await this.recordAttempt({
        actorType: 'USER',
        identifier: input.email,
        outcome: 'UNKNOWN_IDENTITY',
        ...input,
      });
      throw GENERIC_FAILURE();
    }

    const recentFailures = await this.countRecentFailures('USER', input.email, input.now);
    const lockout = {
      failedAttempts: recentFailures.count,
      lockedUntil: recentFailures.lockedUntil,
    };
    if (isLockedOut(lockout, input.now)) {
      throw new RateLimitedError('auth.account_locked', secondsUntilUnlock(lockout, input.now));
    }

    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid) {
      await this.recordAttempt({
        actorType: 'USER',
        identifier: input.email,
        outcome: 'BAD_CREDENTIALS',
        ...input,
      });
      throw GENERIC_FAILURE();
    }

    const membership = user.memberships[0];
    if (!membership) {
      // A valid user with no active membership can authenticate but has no tenant to act in.
      // Platform admins are the documented exception.
      if (!user.isPlatformAdmin) {
        throw new ForbiddenError(
          'auth.no_organization',
          'This account has no active organization.',
        );
      }
      await this.recordAttempt({
        actorType: 'USER',
        identifier: input.email,
        outcome: 'SUCCESS',
        ...input,
      });
      return {
        actorType: 'USER',
        organizationId: null,
        userId: user.id,
        workerId: null,
        driverId: null,
        permissions: [],
      };
    }

    if (
      membership.organization.status === 'SUSPENDED' ||
      membership.organization.status === 'CANCELLED'
    ) {
      throw new ForbiddenError(
        'auth.organization_suspended',
        'This organization is not currently active.',
      );
    }

    await this.recordAttempt({
      actorType: 'USER',
      identifier: input.email,
      outcome: 'SUCCESS',
      ...input,
    });

    return {
      actorType: 'USER',
      organizationId: membership.organizationId,
      userId: user.id,
      workerId: null,
      driverId: null,
      permissions: membership.role.permissions,
    };
  }

  /**
   * Worker PIN login.
   *
   * Scoped to one organization by slug, so the same employee number in two tenants is two
   * different people — and a PIN grinder has to know which tenant they are attacking.
   */
  async authenticateWorker(input: {
    organizationSlug: string;
    employeeNumber: string;
    pin: string;
    ipAddress: string | null;
    userAgent: string | null;
    now: Date;
  }): Promise<AuthenticatedActor> {
    const organization = await this.prisma.organization.findUnique({
      where: { slug: input.organizationSlug },
      select: { id: true, status: true },
    });
    if (
      !organization ||
      organization.status === 'CANCELLED' ||
      organization.status === 'SUSPENDED'
    ) {
      await burnVerificationTime();
      throw GENERIC_FAILURE();
    }

    const worker = await this.prisma.worker.findFirst({
      where: {
        organizationId: organization.id,
        employeeNumber: { equals: input.employeeNumber, mode: 'insensitive' },
        deletedAt: null,
      },
      select: {
        id: true,
        pinHash: true,
        status: true,
        failedPinAttempts: true,
        lockedUntil: true,
      },
    });

    if (!worker || !worker.pinHash || worker.status !== 'ACTIVE') {
      await burnVerificationTime();
      await this.recordAttempt({
        actorType: 'WORKER',
        identifier: input.employeeNumber,
        outcome: 'UNKNOWN_IDENTITY',
        organizationId: organization.id,
        ...input,
      });
      throw GENERIC_FAILURE();
    }

    const lockoutState = {
      failedAttempts: worker.failedPinAttempts,
      lockedUntil: worker.lockedUntil,
    };
    if (isLockedOut(lockoutState, input.now)) {
      await this.recordAttempt({
        actorType: 'WORKER',
        identifier: input.employeeNumber,
        outcome: 'LOCKED',
        organizationId: organization.id,
        ...input,
      });
      throw new RateLimitedError(
        'auth.account_locked',
        secondsUntilUnlock(lockoutState, input.now),
      );
    }

    const valid = await verifyPin(worker.pinHash, input.pin);
    if (!valid) {
      const next = registerFailure(lockoutState, input.now, DEFAULT_PIN_LOCKOUT);
      await this.prisma.worker.update({
        where: { id: worker.id },
        data: { failedPinAttempts: next.failedAttempts, lockedUntil: next.lockedUntil },
      });
      await this.recordAttempt({
        actorType: 'WORKER',
        identifier: input.employeeNumber,
        outcome: 'BAD_CREDENTIALS',
        organizationId: organization.id,
        ...input,
      });
      throw GENERIC_FAILURE();
    }

    const cleared = registerSuccess();
    await this.prisma.worker.update({
      where: { id: worker.id },
      data: { failedPinAttempts: cleared.failedAttempts, lockedUntil: cleared.lockedUntil },
    });
    await this.recordAttempt({
      actorType: 'WORKER',
      identifier: input.employeeNumber,
      outcome: 'SUCCESS',
      organizationId: organization.id,
      ...input,
    });

    return {
      actorType: 'WORKER',
      organizationId: organization.id,
      userId: null,
      workerId: worker.id,
      driverId: null,
      // Worker permissions come from the immutable system role, never from a stored list a
      // tenant admin could widen by accident.
      permissions: systemRole(SYSTEM_ROLES.WORKER).permissions,
    };
  }

  async authenticateDriver(input: {
    organizationSlug: string;
    driverCode: string;
    pin: string;
    ipAddress: string | null;
    userAgent: string | null;
    now: Date;
  }): Promise<AuthenticatedActor> {
    const organization = await this.prisma.organization.findUnique({
      where: { slug: input.organizationSlug },
      select: { id: true, status: true },
    });
    if (
      !organization ||
      organization.status === 'CANCELLED' ||
      organization.status === 'SUSPENDED'
    ) {
      await burnVerificationTime();
      throw GENERIC_FAILURE();
    }

    const driver = await this.prisma.driver.findFirst({
      where: {
        organizationId: organization.id,
        driverCode: { equals: input.driverCode, mode: 'insensitive' },
        deletedAt: null,
      },
      select: {
        id: true,
        pinHash: true,
        status: true,
        failedPinAttempts: true,
        lockedUntil: true,
      },
    });

    if (!driver || !driver.pinHash || driver.status !== 'ACTIVE') {
      await burnVerificationTime();
      throw GENERIC_FAILURE();
    }

    const lockoutState = {
      failedAttempts: driver.failedPinAttempts,
      lockedUntil: driver.lockedUntil,
    };
    if (isLockedOut(lockoutState, input.now)) {
      throw new RateLimitedError(
        'auth.account_locked',
        secondsUntilUnlock(lockoutState, input.now),
      );
    }

    const valid = await verifyPin(driver.pinHash, input.pin);
    if (!valid) {
      const next = registerFailure(lockoutState, input.now, DEFAULT_PIN_LOCKOUT);
      await this.prisma.driver.update({
        where: { id: driver.id },
        data: { failedPinAttempts: next.failedAttempts, lockedUntil: next.lockedUntil },
      });
      await this.recordAttempt({
        actorType: 'DRIVER',
        identifier: input.driverCode,
        outcome: 'BAD_CREDENTIALS',
        organizationId: organization.id,
        ...input,
      });
      throw GENERIC_FAILURE();
    }

    const cleared = registerSuccess();
    await this.prisma.driver.update({
      where: { id: driver.id },
      data: { failedPinAttempts: cleared.failedAttempts, lockedUntil: cleared.lockedUntil },
    });
    await this.recordAttempt({
      actorType: 'DRIVER',
      identifier: input.driverCode,
      outcome: 'SUCCESS',
      organizationId: organization.id,
      ...input,
    });

    return {
      actorType: 'DRIVER',
      organizationId: organization.id,
      userId: null,
      workerId: null,
      driverId: driver.id,
      permissions: systemRole(SYSTEM_ROLES.DRIVER).permissions,
    };
  }

  private async recordAttempt(input: {
    actorType: ActorType;
    identifier: string;
    outcome: 'SUCCESS' | 'BAD_CREDENTIALS' | 'LOCKED' | 'UNKNOWN_IDENTITY' | 'RATE_LIMITED';
    organizationId?: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<void> {
    await this.prisma.authAttempt.create({
      data: {
        actorType: input.actorType,
        identifier: input.identifier.toLowerCase().slice(0, 200),
        outcome: input.outcome,
        organizationId: input.organizationId ?? null,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
      },
    });
  }

  /**
   * Failure count for an identifier over the lockout window.
   *
   * Used for email/password, where there is no per-row counter (a user may be a member of
   * several organizations, and locking the row would lock all of them).
   */
  private async countRecentFailures(
    actorType: ActorType,
    identifier: string,
    now: Date,
  ): Promise<{ count: number; lockedUntil: Date | null }> {
    const windowStart = new Date(now.getTime() - DEFAULT_PASSWORD_LOCKOUT.maxLockSeconds * 1000);
    const attempts = await this.prisma.authAttempt.findMany({
      where: {
        actorType,
        identifier: identifier.toLowerCase(),
        outcome: { in: ['BAD_CREDENTIALS', 'LOCKED'] },
        createdAt: { gte: windowStart },
      },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: DEFAULT_PASSWORD_LOCKOUT.threshold * 4,
    });

    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (const attempt of [...attempts].reverse()) {
      state = registerFailure(state, attempt.createdAt, DEFAULT_PASSWORD_LOCKOUT);
    }
    return { count: state.failedAttempts, lockedUntil: state.lockedUntil };
  }
}
