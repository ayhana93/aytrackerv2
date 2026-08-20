import type { PrismaClient } from '@aytracker/database';
import {
  DEFAULT_SESSION_TTL_SECONDS,
  issueCsrfToken,
  issueSessionToken,
  type SessionRecord,
} from '@aytracker/auth';
import type { ActorType } from '@aytracker/types';

export interface StoredSession extends SessionRecord {
  readonly lastSeenAt: Date;
  readonly isPlatformAdmin: boolean;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

/**
 * Server-side session storage.
 *
 * The permission list is snapshotted onto the session at issue time. That makes the hot path a
 * single indexed read instead of a role join on every request; the cost is that a permission
 * change must invalidate the sessions it affects, which `revokeForActor` exists to do. The
 * tradeoff is deliberate and the invalidation path is the part that must not be forgotten.
 */
export class SessionService {
  constructor(private readonly prisma: PrismaClient) {}

  async findByTokenHash(tokenHash: string): Promise<StoredSession | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        actorType: true,
        organizationId: true,
        userId: true,
        workerId: true,
        driverId: true,
        permissions: true,
        expiresAt: true,
        revokedAt: true,
        lastSeenAt: true,
        createdAt: true,
        user: { select: { isPlatformAdmin: true, credentialsChangedAt: true } },
      },
    });
    if (!session) return null;

    // A password change invalidates every session issued before it, without a separate sweep:
    // any session older than `credentialsChangedAt` is simply not returned.
    if (
      session.user?.credentialsChangedAt &&
      session.createdAt.getTime() < session.user.credentialsChangedAt.getTime()
    ) {
      return null;
    }

    return {
      id: session.id,
      actorType: session.actorType,
      organizationId: session.organizationId,
      userId: session.userId,
      workerId: session.workerId,
      driverId: session.driverId,
      permissions: session.permissions,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      lastSeenAt: session.lastSeenAt,
      isPlatformAdmin: session.user?.isPlatformAdmin ?? false,
    };
  }

  async issue(input: {
    actorType: ActorType;
    organizationId: string | null;
    userId?: string | null;
    workerId?: string | null;
    driverId?: string | null;
    permissions: readonly string[];
    ipAddress?: string | null;
    userAgent?: string | null;
    ttlSeconds?: number;
    now: Date;
  }): Promise<IssuedSession> {
    const { token, tokenHash } = issueSessionToken();
    const ttl = input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS[input.actorType];
    const expiresAt = new Date(input.now.getTime() + ttl * 1000);

    const session = await this.prisma.session.create({
      data: {
        tokenHash,
        actorType: input.actorType,
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        workerId: input.workerId ?? null,
        driverId: input.driverId ?? null,
        permissions: [...input.permissions],
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        expiresAt,
        lastSeenAt: input.now,
      },
      select: { id: true },
    });

    return { sessionId: session.id, token, csrfToken: issueCsrfToken(), expiresAt };
  }

  async touch(sessionId: string, now: Date): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { lastSeenAt: now },
    });
  }

  async revoke(sessionId: string, reason: string, now: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
  }

  /**
   * Revokes every session for one actor.
   *
   * Called when a role changes, a PIN is reset, a worker is deactivated or a member is removed —
   * anything that would make the snapshotted permission list wrong.
   */
  async revokeForActor(
    input: {
      userId?: string;
      workerId?: string;
      driverId?: string;
    },
    reason: string,
    now: Date,
  ): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        revokedAt: null,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.workerId ? { workerId: input.workerId } : {}),
        ...(input.driverId ? { driverId: input.driverId } : {}),
      },
      data: { revokedAt: now, revokedReason: reason },
    });
    return result.count;
  }

  /**
   * Grants or revokes the driving context on a worker's own session.
   *
   * A worker who moves onto a driving position needs the driver portal. Rather than issuing a
   * second session or inventing a fourth actor type, their existing session gains the linked
   * driver profile plus the driver permission set — for exactly as long as the driving position
   * session is open.
   *
   * Because permissions are snapshotted onto the session, this is also the invalidation: passing
   * `driverId: null` strips both the identity and the permissions in one write, so the moment a
   * worker leaves the driving position their session can no longer reach a driver endpoint.
   */
  async setDrivingContext(input: {
    sessionId: string;
    driverId: string | null;
    permissions: readonly string[];
  }): Promise<void> {
    await this.prisma.session.updateMany({
      // `actorType: 'WORKER'` in the filter is load-bearing: this must never be able to attach a
      // driver identity to an admin session.
      where: { id: input.sessionId, actorType: 'WORKER', revokedAt: null },
      data: { driverId: input.driverId, permissions: [...input.permissions] },
    });
  }

  /** Housekeeping: removes sessions that expired long enough ago to be uninteresting. */
  async pruneExpired(before: Date): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return result.count;
  }
}
