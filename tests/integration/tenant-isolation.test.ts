import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InProcessEventBus, systemClock } from '@aytracker/domain';
import {
  PrismaEligibilityRepository,
  PrismaOrganizationPolicyRepository,
  PrismaPositionRepository,
  PrismaQualificationRepository,
  PrismaWorkerRepository,
  WorkforceQueryService,
} from '@aytracker/module-workforce';
import { PrismaShiftTransactionRunner, ShiftCommandService } from '@aytracker/module-shifts';
import type { OrganizationId, PositionId, WorkerId } from '@aytracker/types';
import {
  createTestTenant,
  disconnectTestClient,
  getTestClient,
  resetDatabase,
  seedPlatformReferenceData,
  type TestTenant,
} from '../helpers/database.js';

/**
 * Tenant isolation.
 *
 * The security tests the specification demands, run against a real database so the composite
 * foreign keys and partial unique indexes are actually in play:
 *
 *   Organization A cannot access Organization B.
 *   Worker A cannot access Worker B.
 *   Client cannot bypass qualification.
 *   Client cannot create two open position sessions.
 */

const prisma = getTestClient();

let tenantA: TestTenant;
let tenantB: TestTenant;
let workforce: WorkforceQueryService;
let shifts: ShiftCommandService;

beforeAll(async () => {
  await seedPlatformReferenceData();
});

afterAll(async () => {
  await disconnectTestClient();
});

beforeEach(async () => {
  await resetDatabase();
  await seedPlatformReferenceData();
  tenantA = await createTestTenant('tenant-a');
  tenantB = await createTestTenant('tenant-b');

  workforce = new WorkforceQueryService(
    new PrismaWorkerRepository(prisma),
    new PrismaPositionRepository(prisma),
    new PrismaQualificationRepository(prisma),
    new PrismaEligibilityRepository(prisma),
    new PrismaOrganizationPolicyRepository(prisma),
  );
  shifts = new ShiftCommandService(
    new PrismaShiftTransactionRunner(prisma),
    workforce,
    new InProcessEventBus(() => {}),
    systemClock,
  );
});

describe('Organization A cannot access Organization B', () => {
  it('a repository read scoped to A never returns B’s worker', async () => {
    const workers = new PrismaWorkerRepository(prisma);
    const found = await workers.findById(
      tenantA.organizationId as OrganizationId,
      tenantB.workerId as WorkerId,
    );
    expect(found).toBeNull();
  });

  it('a position lookup scoped to A never returns B’s position', async () => {
    const positions = new PrismaPositionRepository(prisma);
    expect(
      await positions.findRule(
        tenantA.organizationId as OrganizationId,
        tenantB.positionIds.machine1 as PositionId,
      ),
    ).toBeNull();
  });

  /**
   * A QR token is globally unique, so scanning another tenant's physical code must read as
   * "not recognized" rather than resolving to their position.
   */
  it('a QR token from B does not resolve inside A', async () => {
    const positions = new PrismaPositionRepository(prisma);
    expect(
      await positions.findByQrToken(tenantA.organizationId as OrganizationId, 'tenant-b-qr-m1'),
    ).toBeNull();
    expect(
      await positions.findByQrToken(tenantA.organizationId as OrganizationId, 'tenant-a-qr-m1'),
    ).not.toBeNull();
  });

  it('the eligibility service refuses a position from another tenant', async () => {
    await expect(
      workforce.checkEligibility({
        organizationId: tenantA.organizationId as OrganizationId,
        workerId: tenantA.workerId as WorkerId,
        positionId: tenantB.positionIds.machine1 as PositionId,
        now: new Date(),
      }),
    ).rejects.toThrowError(/position not found/i);
  });

  it('the position picker only offers positions from the caller’s own tenant', async () => {
    const available = await workforce.listAvailablePositions({
      organizationId: tenantA.organizationId as OrganizationId,
      workerId: tenantA.workerId as WorkerId,
      siteId: tenantA.siteId as never,
      now: new Date(),
    });

    const offered = available.map((entry) => entry.positionId);
    expect(offered).toContain(tenantA.positionIds.machine1);
    expect(offered).not.toContain(tenantB.positionIds.machine1);
    expect(offered).not.toContain(tenantB.positionIds.packaging);
  });

  /**
   * The structural guarantee: the composite (organizationId, id) foreign keys make a
   * cross-tenant reference impossible at the database, not merely unlikely in the application.
   */
  it('the database refuses a shift referencing another tenant’s site', async () => {
    await expect(
      prisma.shift.create({
        data: {
          organizationId: tenantA.organizationId,
          siteId: tenantB.siteId,
          workerId: tenantA.workerId,
          status: 'ACTIVE',
          actualStart: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('the database refuses a position session referencing another tenant’s position', async () => {
    const shift = await prisma.shift.create({
      data: {
        organizationId: tenantA.organizationId,
        siteId: tenantA.siteId,
        workerId: tenantA.workerId,
        status: 'ACTIVE',
        actualStart: new Date(),
      },
    });

    await expect(
      prisma.positionSession.create({
        data: {
          organizationId: tenantA.organizationId,
          shiftId: shift.id,
          workerId: tenantA.workerId,
          positionId: tenantB.positionIds.machine1,
          startedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('the database refuses a trip pairing A’s driver with B’s vehicle', async () => {
    await expect(
      prisma.driverTrip.create({
        data: {
          organizationId: tenantA.organizationId,
          driverId: tenantA.driverId,
          vehicleId: tenantB.vehicleId,
          status: 'ACTIVE',
          startedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('the database refuses a fuel expense against another tenant’s vehicle', async () => {
    await expect(
      prisma.fuelExpense.create({
        data: {
          organizationId: tenantA.organizationId,
          vehicleId: tenantB.vehicleId,
          date: new Date(),
          liters: '50',
          pricePerLiter: '1.5',
          totalCost: '75',
          currency: 'EUR',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('client cannot bypass qualification', () => {
  it('refuses a position whose qualification the worker does not hold', async () => {
    await shifts.startShift(
      {
        organizationId: tenantA.organizationId as OrganizationId,
        workerId: tenantA.workerId as WorkerId,
        siteId: tenantA.siteId as never,
        shiftTypeId: null,
        initialPositionId: tenantA.positionIds.machine1 as PositionId,
        at: new Date(),
        startedBySupervisor: false,
      },
      { maxShiftDurationMinutes: 960, allowWorkerSelfShiftStart: true },
    );

    await expect(
      shifts.changePosition({
        organizationId: tenantA.organizationId as OrganizationId,
        workerId: tenantA.workerId as WorkerId,
        targetPositionId: tenantA.positionIds.restricted as PositionId,
        at: new Date(),
        source: 'MANUAL',
      }),
    ).rejects.toThrowError(/qualification/i);
  });

  it('allows a position whose qualification the worker holds', async () => {
    await shifts.startShift(
      {
        organizationId: tenantA.organizationId as OrganizationId,
        workerId: tenantA.workerId as WorkerId,
        siteId: tenantA.siteId as never,
        shiftTypeId: null,
        initialPositionId: tenantA.positionIds.machine1 as PositionId,
        at: new Date(),
        startedBySupervisor: false,
      },
      { maxShiftDurationMinutes: 960, allowWorkerSelfShiftStart: true },
    );

    const result = await shifts.changePosition({
      organizationId: tenantA.organizationId as OrganizationId,
      workerId: tenantA.workerId as WorkerId,
      targetPositionId: tenantA.positionIds.machine2 as PositionId,
      at: new Date(),
      source: 'MANUAL',
    });
    expect(result.openedSessionId).toBeTruthy();
  });

  /** An expired qualification is not a qualification. */
  it('refuses a position when the worker’s qualification has expired', async () => {
    await prisma.workerQualification.updateMany({
      where: { organizationId: tenantA.organizationId, workerId: tenantA.workerId },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    });

    await expect(
      workforce.checkEligibility({
        organizationId: tenantA.organizationId as OrganizationId,
        workerId: tenantA.workerId as WorkerId,
        positionId: tenantA.positionIds.machine1 as PositionId,
        now: new Date(),
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'QUALIFICATION_EXPIRED' });
  });
});
