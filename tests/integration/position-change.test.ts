import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InProcessEventBus, fixedClock } from '@aytracker/domain';
import {
  PrismaEligibilityRepository,
  PrismaOrganizationPolicyRepository,
  PrismaPositionRepository,
  PrismaQualificationRepository,
  PrismaWorkerRepository,
  WorkforceQueryService,
} from '@aytracker/module-workforce';
import { PrismaShiftTransactionRunner, ShiftCommandService } from '@aytracker/module-shifts';
import type { OrganizationId, PositionId, SiteId, WorkerId } from '@aytracker/types';
import {
  createTestTenant,
  disconnectTestClient,
  getTestClient,
  resetDatabase,
  seedPlatformReferenceData,
  type TestTenant,
} from '../helpers/database.js';

/**
 * The position-change transaction.
 *
 * These are the tests that justify the design: the close-and-open pair is atomic, a worker can
 * never hold two open sessions, and the database wins the race when the application check is
 * passed concurrently by two requests.
 */

const prisma = getTestClient();
const NOW = new Date('2026-03-10T08:00:00Z');

let tenant: TestTenant;
let shifts: ShiftCommandService;

function buildServices(now: Date): ShiftCommandService {
  const workforce = new WorkforceQueryService(
    new PrismaWorkerRepository(prisma),
    new PrismaPositionRepository(prisma),
    new PrismaQualificationRepository(prisma),
    new PrismaEligibilityRepository(prisma),
    new PrismaOrganizationPolicyRepository(prisma),
  );
  return new ShiftCommandService(
    new PrismaShiftTransactionRunner(prisma),
    workforce,
    new InProcessEventBus(() => {}),
    fixedClock(now),
  );
}

beforeAll(async () => {
  await seedPlatformReferenceData();
});

afterAll(async () => {
  await disconnectTestClient();
});

beforeEach(async () => {
  await resetDatabase();
  await seedPlatformReferenceData();
  tenant = await createTestTenant('tenant-pc');
  shifts = buildServices(NOW);
});

async function startShift(at = NOW): Promise<string> {
  const result = await shifts.startShift(
    {
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      siteId: tenant.siteId as SiteId,
      shiftTypeId: null,
      initialPositionId: tenant.positionIds.machine1 as PositionId,
      at,
      startedBySupervisor: false,
    },
    { maxShiftDurationMinutes: 960, allowWorkerSelfShiftStart: true },
  );
  return result.shiftId;
}

describe('start shift', () => {
  it('opens the shift and the first position session together', async () => {
    const shiftId = await startShift();

    const sessions = await prisma.positionSession.findMany({ where: { shiftId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.positionId).toBe(tenant.positionIds.machine1);
    expect(sessions[0]!.endedAt).toBeNull();
  });

  it('refuses a second shift while one is open', async () => {
    await startShift();
    await expect(startShift()).rejects.toThrowError(/already has a shift/i);
  });

  /**
   * Two devices tapping Start at the same moment. Both pass the application check; the partial
   * unique index `shifts_one_open_per_worker` is what makes exactly one of them win.
   */
  it('the database prevents two concurrent shift starts', async () => {
    const results = await Promise.allSettled([startShift(), startShift()]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const open = await prisma.shift.count({
      where: { workerId: tenant.workerId, status: { in: ['ACTIVE', 'ON_BREAK'] } },
    });
    expect(open).toBe(1);
  });

  it('an ineligible initial position leaves no shift behind', async () => {
    await expect(
      shifts.startShift(
        {
          organizationId: tenant.organizationId as OrganizationId,
          workerId: tenant.workerId as WorkerId,
          siteId: tenant.siteId as SiteId,
          shiftTypeId: null,
          initialPositionId: tenant.positionIds.restricted as PositionId,
          at: NOW,
          startedBySupervisor: false,
        },
        { maxShiftDurationMinutes: 960, allowWorkerSelfShiftStart: true },
      ),
    ).rejects.toThrow();

    expect(await prisma.shift.count({ where: { workerId: tenant.workerId } })).toBe(0);
  });
});

describe('change position', () => {
  it('closes the old session and opens the new one atomically', async () => {
    const shiftId = await startShift();
    const changeAt = new Date(NOW.getTime() + 32 * 60_000);

    const result = await shifts.changePosition({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      targetPositionId: tenant.positionIds.machine2 as PositionId,
      at: changeAt,
      source: 'MANUAL',
    });

    const sessions = await prisma.positionSession.findMany({
      where: { shiftId },
      orderBy: { startedAt: 'asc' },
    });

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.endedAt).toEqual(changeAt);
    expect(sessions[0]!.durationSeconds).toBe(32 * 60);
    expect(sessions[1]!.endedAt).toBeNull();
    expect(sessions[1]!.id).toBe(result.openedSessionId);
  });

  /** The invariant the whole design exists to protect. */
  it('never leaves a worker with two open sessions', async () => {
    await startShift();
    for (let i = 1; i <= 6; i += 1) {
      await shifts.changePosition({
        organizationId: tenant.organizationId as OrganizationId,
        workerId: tenant.workerId as WorkerId,
        targetPositionId: (i % 2 === 0
          ? tenant.positionIds.machine1
          : tenant.positionIds.machine2) as PositionId,
        at: new Date(NOW.getTime() + i * 10 * 60_000),
        source: 'MANUAL',
      });
    }

    const open = await prisma.positionSession.count({
      where: { workerId: tenant.workerId, endedAt: null },
    });
    expect(open).toBe(1);
    expect(await prisma.positionSession.count({ where: { workerId: tenant.workerId } })).toBe(7);
  });

  /**
   * Concurrent position changes.
   *
   * The guarantee is *not* that one request fails — two changes that the database happens to
   * serialize are both legitimate, and asserting a failure would be asserting a race. The
   * guarantee is that the history stays consistent however they interleave: exactly one open
   * session, and no two sessions overlapping. That is what the partial unique index and the
   * compare-and-set close buy us.
   */
  it('keeps position history consistent under concurrent changes', async () => {
    await startShift();
    const changeAt = new Date(NOW.getTime() + 60_000);

    await Promise.allSettled([
      shifts.changePosition({
        organizationId: tenant.organizationId as OrganizationId,
        workerId: tenant.workerId as WorkerId,
        targetPositionId: tenant.positionIds.machine2 as PositionId,
        at: changeAt,
        source: 'MANUAL',
      }),
      shifts.changePosition({
        organizationId: tenant.organizationId as OrganizationId,
        workerId: tenant.workerId as WorkerId,
        targetPositionId: tenant.positionIds.packaging as PositionId,
        at: changeAt,
        source: 'MANUAL',
      }),
    ]);

    const sessions = await prisma.positionSession.findMany({
      where: { workerId: tenant.workerId },
      orderBy: { startedAt: 'asc' },
    });

    expect(sessions.filter((session) => session.endedAt === null)).toHaveLength(1);

    // No overlap: each closed session ends no later than the next one starts.
    for (let i = 1; i < sessions.length; i += 1) {
      const previousEnd = sessions[i - 1]!.endedAt;
      expect(previousEnd).not.toBeNull();
      expect(previousEnd!.getTime()).toBeLessThanOrEqual(sessions[i]!.startedAt.getTime());
    }
  });

  it('refuses a change with no shift in progress', async () => {
    await expect(
      shifts.changePosition({
        organizationId: tenant.organizationId as OrganizationId,
        workerId: tenant.workerId as WorkerId,
        targetPositionId: tenant.positionIds.machine2 as PositionId,
        at: NOW,
        source: 'MANUAL',
      }),
    ).rejects.toThrowError(/does not have a shift in progress/i);
  });

  it('refuses a change while the worker is on a break', async () => {
    await startShift();
    await shifts.startBreak({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      type: 'UNPAID',
      at: new Date(NOW.getTime() + 60_000),
    });

    await expect(
      shifts.changePosition({
        organizationId: tenant.organizationId as OrganizationId,
        workerId: tenant.workerId as WorkerId,
        targetPositionId: tenant.positionIds.machine2 as PositionId,
        at: new Date(NOW.getTime() + 120_000),
        source: 'MANUAL',
      }),
    ).rejects.toThrowError(/end the break/i);
  });

  it('lets anyone onto an INSTANT position without a qualification', async () => {
    await startShift();
    await expect(
      shifts.changePosition({
        organizationId: tenant.organizationId as OrganizationId,
        workerId: tenant.workerId as WorkerId,
        targetPositionId: tenant.positionIds.packaging as PositionId,
        at: new Date(NOW.getTime() + 60_000),
        source: 'QR',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('breaks and shift end', () => {
  it('records the break and computes durations server-side', async () => {
    const shiftId = await startShift();

    await shifts.startBreak({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      type: 'MEAL',
      at: new Date(NOW.getTime() + 4 * 3600_000),
    });
    await shifts.endBreak({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      at: new Date(NOW.getTime() + 4.5 * 3600_000),
    });
    const result = await shifts.endShift({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      at: new Date(NOW.getTime() + 8 * 3600_000),
    });

    expect(result.breakSeconds).toBe(1800);
    expect(result.workedSeconds).toBe(8 * 3600 - 1800);

    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    expect(shift.status).toBe('COMPLETED');
    expect(shift.workedSeconds).toBe(8 * 3600 - 1800);

    // The final position session must be closed by the shift end, not left running.
    const open = await prisma.positionSession.count({ where: { shiftId, endedAt: null } });
    expect(open).toBe(0);
  });

  it('closes an open break when the shift ends while on break', async () => {
    const shiftId = await startShift();
    await shifts.startBreak({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      type: 'UNPAID',
      at: new Date(NOW.getTime() + 7.5 * 3600_000),
    });

    const result = await shifts.endShift({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      at: new Date(NOW.getTime() + 8 * 3600_000),
    });

    expect(result.breakSeconds).toBe(1800);
    expect(await prisma.shiftBreak.count({ where: { shiftId, endedAt: null } })).toBe(0);
  });

  it('refuses a second open break on one shift', async () => {
    await startShift();
    await shifts.startBreak({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      type: 'UNPAID',
      at: new Date(NOW.getTime() + 3600_000),
    });

    await expect(
      shifts.startBreak({
        organizationId: tenant.organizationId as OrganizationId,
        workerId: tenant.workerId as WorkerId,
        type: 'UNPAID',
        at: new Date(NOW.getTime() + 3700_000),
      }),
      // The shift is ON_BREAK, so it is refused at the status check before the open-break check
      // is reached — either rejection is correct, and this is the one that fires first.
    ).rejects.toThrowError(/active shift/i);
  });
});

describe('supervisor corrections', () => {
  it('records the before and after values with a reason', async () => {
    const shiftId = await startShift();
    await shifts.changePosition({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      targetPositionId: tenant.positionIds.machine2 as PositionId,
      at: new Date(NOW.getTime() + 32 * 60_000),
      source: 'MANUAL',
    });
    await shifts.endShift({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      at: new Date(NOW.getTime() + 8 * 3600_000),
    });

    const [first] = await prisma.positionSession.findMany({
      where: { shiftId },
      orderBy: { startedAt: 'asc' },
    });

    // The worker actually arrived five minutes after clocking in. Shrinking the first session
    // keeps it inside its slot, so the chain stays consistent.
    await shifts.correctPositionSession({
      organizationId: tenant.organizationId as OrganizationId,
      sessionId: first!.id as never,
      newStartedAt: new Date(NOW.getTime() + 5 * 60_000),
      newEndedAt: new Date(NOW.getTime() + 32 * 60_000),
      reason: 'Worker reached the machine five minutes after clocking in.',
      correctedByUserId: tenant.adminUserId,
    });

    const corrected = await prisma.positionSession.findUniqueOrThrow({ where: { id: first!.id } });
    expect(corrected.durationSeconds).toBe(27 * 60);
    expect(corrected.correctedAt).not.toBeNull();
  });

  /**
   * A correction that would extend a session into its neighbour is refused.
   *
   * This is a real product limitation, not an oversight: adjusting the *boundary* between two
   * adjacent sessions needs both rows moved together, and that is a separate command. Until it
   * exists, the guard is what stops a supervisor from silently creating overlapping history.
   */
  it('refuses to extend a session into the next one', async () => {
    const shiftId = await startShift();
    await shifts.changePosition({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      targetPositionId: tenant.positionIds.machine2 as PositionId,
      at: new Date(NOW.getTime() + 32 * 60_000),
      source: 'MANUAL',
    });
    await shifts.endShift({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      at: new Date(NOW.getTime() + 8 * 3600_000),
    });

    const [first] = await prisma.positionSession.findMany({
      where: { shiftId },
      orderBy: { startedAt: 'asc' },
    });

    await expect(
      shifts.correctPositionSession({
        organizationId: tenant.organizationId as OrganizationId,
        sessionId: first!.id as never,
        newStartedAt: NOW,
        newEndedAt: new Date(NOW.getTime() + 40 * 60_000),
        reason: 'Extending past the next session.',
        correctedByUserId: tenant.adminUserId,
      }),
    ).rejects.toThrowError(/overlap/i);
  });

  it('refuses a correction that would overlap the next session', async () => {
    const shiftId = await startShift();
    await shifts.changePosition({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      targetPositionId: tenant.positionIds.machine2 as PositionId,
      at: new Date(NOW.getTime() + 32 * 60_000),
      source: 'MANUAL',
    });
    await shifts.endShift({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      at: new Date(NOW.getTime() + 8 * 3600_000),
    });

    const [first] = await prisma.positionSession.findMany({
      where: { shiftId },
      orderBy: { startedAt: 'asc' },
    });

    await expect(
      shifts.correctPositionSession({
        organizationId: tenant.organizationId as OrganizationId,
        sessionId: first!.id as never,
        newStartedAt: NOW,
        newEndedAt: new Date(NOW.getTime() + 5 * 3600_000),
        reason: 'Attempting an overlap.',
        correctedByUserId: tenant.adminUserId,
      }),
    ).rejects.toThrowError(/overlap/i);
  });

  it('refuses a correction that would push a session outside its shift', async () => {
    const shiftId = await startShift();
    await shifts.endShift({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      at: new Date(NOW.getTime() + 8 * 3600_000),
    });

    const [session] = await prisma.positionSession.findMany({ where: { shiftId } });

    await expect(
      shifts.correctPositionSession({
        organizationId: tenant.organizationId as OrganizationId,
        sessionId: session!.id as never,
        newStartedAt: new Date(NOW.getTime() - 3600_000),
        newEndedAt: new Date(NOW.getTime() + 3600_000),
        reason: 'Attempting to start before the shift.',
        correctedByUserId: tenant.adminUserId,
      }),
    ).rejects.toThrowError(/before its shift/i);
  });
});
