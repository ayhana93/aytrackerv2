import type { DatabaseClient, PrismaClient } from '@aytracker/database';
import { withTenant } from '@aytracker/database';
import type {
  ClientActionId,
  OrganizationId,
  PositionId,
  PositionSessionId,
  ShiftId,
  ShiftTypeId,
  SiteId,
  WorkerId,
} from '@aytracker/types';
import { ConflictError } from '@aytracker/domain';
import { createHash } from 'node:crypto';
import type { BreakInterval, BreakType, ShiftStatus } from '../domain/shift.js';
import type { PositionChangeSource, PositionSessionState } from '../domain/position-session.js';
import type {
  IdempotencyStore,
  PositionSessionRepository,
  ShiftBreakRepository,
  ShiftRecord,
  ShiftRepository,
  ShiftUnitOfWork,
  TransactionRunner,
} from '../domain/ports.js';

export class PrismaShiftRepository implements ShiftRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findById(organizationId: OrganizationId, shiftId: ShiftId): Promise<ShiftRecord | null> {
    const shift = await this.db.shift.findFirst({
      where: { id: shiftId, organizationId },
      select: SHIFT_SELECT,
    });
    return shift ? (shift as ShiftRecord) : null;
  }

  async findOpenForWorker(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<ShiftRecord | null> {
    const shift = await this.db.shift.findFirst({
      where: { organizationId, workerId, status: { in: ['ACTIVE', 'ON_BREAK'] } },
      select: SHIFT_SELECT,
    });
    return shift ? (shift as ShiftRecord) : null;
  }

  async create(input: {
    organizationId: OrganizationId;
    siteId: SiteId;
    workerId: WorkerId;
    shiftTypeId: ShiftTypeId | null;
    status: ShiftStatus;
    actualStart: Date;
    scheduledStart: Date | null;
    scheduledEnd: Date | null;
  }): Promise<ShiftRecord> {
    const shift = await this.db.shift.create({
      data: {
        organizationId: input.organizationId,
        siteId: input.siteId,
        workerId: input.workerId,
        shiftTypeId: input.shiftTypeId,
        status: input.status,
        actualStart: input.actualStart,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
      },
      select: SHIFT_SELECT,
    });
    return shift as ShiftRecord;
  }

  async updateStatus(
    organizationId: OrganizationId,
    shiftId: ShiftId,
    status: ShiftStatus,
  ): Promise<void> {
    await this.db.shift.updateMany({
      where: { id: shiftId, organizationId },
      data: { status },
    });
  }

  async close(input: {
    organizationId: OrganizationId;
    shiftId: ShiftId;
    actualEnd: Date;
    workedSeconds: number;
    breakSeconds: number;
    autoClosed: boolean;
  }): Promise<void> {
    await this.db.shift.updateMany({
      where: { id: input.shiftId, organizationId: input.organizationId },
      data: {
        status: 'COMPLETED',
        actualEnd: input.actualEnd,
        workedSeconds: input.workedSeconds,
        breakSeconds: input.breakSeconds,
        autoClosedAt: input.autoClosed ? new Date() : null,
      },
    });
  }

  async listForWorker(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<readonly ShiftRecord[]> {
    const shifts = await this.db.shift.findMany({
      where: {
        organizationId: input.organizationId,
        workerId: input.workerId,
        actualStart: { gte: input.from, lte: input.to },
      },
      select: SHIFT_SELECT,
      orderBy: { actualStart: 'desc' },
      take: input.limit,
    });
    return shifts as ShiftRecord[];
  }

  async listOverrunning(input: {
    organizationId: OrganizationId;
    olderThan: Date;
  }): Promise<readonly ShiftRecord[]> {
    const shifts = await this.db.shift.findMany({
      where: {
        organizationId: input.organizationId,
        status: { in: ['ACTIVE', 'ON_BREAK'] },
        actualStart: { lt: input.olderThan },
      },
      select: SHIFT_SELECT,
      take: 500,
    });
    return shifts as ShiftRecord[];
  }
}

const SHIFT_SELECT = {
  id: true,
  organizationId: true,
  siteId: true,
  workerId: true,
  shiftTypeId: true,
  status: true,
  scheduledStart: true,
  scheduledEnd: true,
  actualStart: true,
  actualEnd: true,
  workedSeconds: true,
  breakSeconds: true,
} as const;

export class PrismaShiftBreakRepository implements ShiftBreakRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findOpen(
    organizationId: OrganizationId,
    shiftId: ShiftId,
  ): Promise<{ id: string; startedAt: Date; type: BreakType } | null> {
    return this.db.shiftBreak.findFirst({
      where: { organizationId, shiftId, endedAt: null },
      select: { id: true, startedAt: true, type: true },
    });
  }

  async listForShift(
    organizationId: OrganizationId,
    shiftId: ShiftId,
  ): Promise<readonly BreakInterval[]> {
    const breaks = await this.db.shiftBreak.findMany({
      where: { organizationId, shiftId },
      select: { type: true, startedAt: true, endedAt: true },
      orderBy: { startedAt: 'asc' },
    });
    return breaks;
  }

  async open(input: {
    organizationId: OrganizationId;
    shiftId: ShiftId;
    type: BreakType;
    startedAt: Date;
  }): Promise<{ id: string }> {
    return this.db.shiftBreak.create({
      data: {
        organizationId: input.organizationId,
        shiftId: input.shiftId,
        type: input.type,
        startedAt: input.startedAt,
      },
      select: { id: true },
    });
  }

  async close(input: {
    organizationId: OrganizationId;
    breakId: string;
    endedAt: Date;
    durationSeconds: number;
  }): Promise<void> {
    await this.db.shiftBreak.updateMany({
      where: { id: input.breakId, organizationId: input.organizationId, endedAt: null },
      data: { endedAt: input.endedAt, durationSeconds: input.durationSeconds },
    });
  }
}

export class PrismaPositionSessionRepository implements PositionSessionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findOpenForShift(
    organizationId: OrganizationId,
    shiftId: ShiftId,
  ): Promise<PositionSessionState | null> {
    const session = await this.db.positionSession.findFirst({
      where: { organizationId, shiftId, endedAt: null },
      select: SESSION_SELECT,
    });
    return session ? (session as PositionSessionState) : null;
  }

  async findById(
    organizationId: OrganizationId,
    sessionId: PositionSessionId,
  ): Promise<PositionSessionState | null> {
    const session = await this.db.positionSession.findFirst({
      where: { id: sessionId, organizationId },
      select: SESSION_SELECT,
    });
    return session ? (session as PositionSessionState) : null;
  }

  async listForShift(
    organizationId: OrganizationId,
    shiftId: ShiftId,
  ): Promise<readonly PositionSessionState[]> {
    const sessions = await this.db.positionSession.findMany({
      where: { organizationId, shiftId },
      select: SESSION_SELECT,
      orderBy: { startedAt: 'asc' },
    });
    return sessions as PositionSessionState[];
  }

  async open(input: {
    organizationId: OrganizationId;
    shiftId: ShiftId;
    workerId: WorkerId;
    positionId: PositionId;
    startedAt: Date;
    source: PositionChangeSource;
  }): Promise<PositionSessionState> {
    const session = await this.db.positionSession.create({
      data: {
        organizationId: input.organizationId,
        shiftId: input.shiftId,
        workerId: input.workerId,
        positionId: input.positionId,
        startedAt: input.startedAt,
        source: input.source,
      },
      select: SESSION_SELECT,
    });
    return session as PositionSessionState;
  }

  async close(input: {
    organizationId: OrganizationId;
    sessionId: PositionSessionId;
    endedAt: Date;
    durationSeconds: number;
  }): Promise<void> {
    const result = await this.db.positionSession.updateMany({
      // `endedAt: null` in the filter makes this a compare-and-set: a concurrent close writes
      // zero rows rather than silently overwriting the first one's end time.
      where: { id: input.sessionId, organizationId: input.organizationId, endedAt: null },
      data: { endedAt: input.endedAt, durationSeconds: input.durationSeconds },
    });
    if (result.count === 0) {
      throw new ConflictError(
        'position.session_already_closed',
        'That position session was already closed.',
      );
    }
  }

  async correct(input: {
    organizationId: OrganizationId;
    sessionId: PositionSessionId;
    startedAt: Date;
    endedAt: Date | null;
    durationSeconds: number | null;
    correctedAt: Date;
  }): Promise<void> {
    await this.db.positionSession.updateMany({
      where: { id: input.sessionId, organizationId: input.organizationId },
      data: {
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationSeconds: input.durationSeconds,
        correctedAt: input.correctedAt,
      },
    });
  }
}

const SESSION_SELECT = {
  id: true,
  shiftId: true,
  workerId: true,
  positionId: true,
  startedAt: true,
  endedAt: true,
} as const;

/**
 * Transaction runner backed by `withTenant`, so every command runs with the RLS tenant GUC set
 * for the duration of its transaction.
 */
export class PrismaShiftTransactionRunner implements TransactionRunner {
  constructor(private readonly prisma: PrismaClient) {}

  async run<T>(
    organizationId: OrganizationId,
    fn: (uow: ShiftUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenant(this.prisma, organizationId, async (tx) =>
      fn({
        shifts: new PrismaShiftRepository(tx),
        breaks: new PrismaShiftBreakRepository(tx),
        positionSessions: new PrismaPositionSessionRepository(tx),
      }),
    );
  }
}

/**
 * Idempotency ledger.
 *
 * The unique index on (organizationId, actorType, actorId, clientActionId) is what makes the
 * claim atomic: two concurrent replays of the same action both try to insert, one gets a unique
 * violation and is told the action is already in flight.
 */
export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(input: {
    organizationId: OrganizationId;
    actorType: 'USER' | 'WORKER' | 'DRIVER';
    actorId: string;
    clientActionId: ClientActionId;
    endpoint: string;
    requestHash: string;
    ttlSeconds: number;
  }): Promise<{ replayed: true; response: unknown } | { replayed: false }> {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: {
        organizationId_actorType_actorId_clientActionId: {
          organizationId: input.organizationId,
          actorType: input.actorType,
          actorId: input.actorId,
          clientActionId: input.clientActionId,
        },
      },
      select: { state: true, responseBody: true, requestHash: true },
    });

    if (existing) {
      // Same key, different body: the client reused an idempotency key for a different action.
      // Replaying the stored response would be wrong, so this is a hard conflict.
      if (existing.requestHash !== input.requestHash) {
        throw new ConflictError(
          'idempotency.key_reused',
          'This idempotency key was already used for a different request.',
        );
      }
      if (existing.state === 'COMPLETED') {
        return { replayed: true, response: existing.responseBody };
      }
      throw new ConflictError(
        'idempotency.in_progress',
        'This action is already being processed.',
      );
    }

    await this.prisma.idempotencyKey.create({
      data: {
        organizationId: input.organizationId,
        actorType: input.actorType,
        actorId: input.actorId,
        clientActionId: input.clientActionId,
        endpoint: input.endpoint,
        requestHash: input.requestHash,
        state: 'PENDING',
        expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
      },
    });
    return { replayed: false };
  }

  async complete(input: {
    organizationId: OrganizationId;
    actorType: 'USER' | 'WORKER' | 'DRIVER';
    actorId: string;
    clientActionId: ClientActionId;
    response: unknown;
    status: number;
  }): Promise<void> {
    await this.prisma.idempotencyKey.updateMany({
      where: {
        organizationId: input.organizationId,
        actorType: input.actorType,
        actorId: input.actorId,
        clientActionId: input.clientActionId,
      },
      data: {
        state: 'COMPLETED',
        responseStatus: input.status,
        responseBody: input.response as never,
      },
    });
  }

  async release(input: {
    organizationId: OrganizationId;
    actorType: 'USER' | 'WORKER' | 'DRIVER';
    actorId: string;
    clientActionId: ClientActionId;
  }): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({
      where: {
        organizationId: input.organizationId,
        actorType: input.actorType,
        actorId: input.actorId,
        clientActionId: input.clientActionId,
        state: 'PENDING',
      },
    });
  }
}

/** Stable hash of a request body, so a replay with different content is detectable. */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}
