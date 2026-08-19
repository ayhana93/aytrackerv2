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
import {
  DrivingCommandService,
  PrismaShiftTransactionRunner,
  ShiftCommandService,
} from '@aytracker/module-shifts';
import type { OrganizationId, PositionId, SiteId, VehicleId, WorkerId } from '@aytracker/types';
import {
  createTestTenant,
  disconnectTestClient,
  getTestClient,
  resetDatabase,
  seedPlatformReferenceData,
  type TestTenant,
} from '../helpers/database.js';

/**
 * The worker → driver handoff, against a real database.
 *
 * The unit tests cover the rules; these cover the thing the rules cannot prove on their own —
 * that the position session, the vehicle assignment and the trip move together, and that leaving
 * the position puts all three back. A half-applied handoff is the state that makes position
 * utilization, trip distance and cost per kilometre quietly disagree with each other, so it is
 * worth a real transaction to rule out.
 *
 * See docs/driving-handoff.md.
 */

const prisma = getTestClient();
const NOW = new Date('2026-03-10T08:00:00Z');
const LATER = new Date('2026-03-10T12:00:00Z');

let tenant: TestTenant;
let events: { name: string; payload: unknown }[];

function buildWorkforce(): WorkforceQueryService {
  return new WorkforceQueryService(
    new PrismaWorkerRepository(prisma),
    new PrismaPositionRepository(prisma),
    new PrismaQualificationRepository(prisma),
    new PrismaEligibilityRepository(prisma),
    new PrismaOrganizationPolicyRepository(prisma),
  );
}

function buildServices(now: Date): { shifts: ShiftCommandService; driving: DrivingCommandService } {
  const runner = new PrismaShiftTransactionRunner(prisma);
  const workforce = buildWorkforce();
  const bus = new InProcessEventBus(() => {});
  bus.subscribe('driving.started', (event) => {
    events.push({ name: event.name, payload: event.payload });
  });
  return {
    shifts: new ShiftCommandService(runner, workforce, bus, fixedClock(now)),
    driving: new DrivingCommandService(runner, workforce, bus, fixedClock(now)),
  };
}

let shifts: ShiftCommandService;
let driving: DrivingCommandService;

beforeAll(async () => {
  await seedPlatformReferenceData();
});

afterAll(async () => {
  await disconnectTestClient();
});

beforeEach(async () => {
  await resetDatabase();
  await seedPlatformReferenceData();
  tenant = await createTestTenant('tenant-dh');
  events = [];
  ({ shifts, driving } = buildServices(NOW));
});

const POLICY = { maxShiftDurationMinutes: 960, allowWorkerSelfShiftStart: true };

async function startShift(): Promise<string> {
  const result = await shifts.startShift(
    {
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      siteId: tenant.siteId as SiteId,
      shiftTypeId: null,
      initialPositionId: tenant.positionIds.machine1 as PositionId,
      at: NOW,
      startedBySupervisor: false,
    },
    POLICY,
  );
  return result.shiftId;
}

function beginDriving(vehicleId: string, at = NOW) {
  return driving.beginDriving({
    organizationId: tenant.organizationId as OrganizationId,
    workerId: tenant.workerId as WorkerId,
    positionId: tenant.positionIds.driving as PositionId,
    vehicleId: vehicleId as VehicleId,
    label: 'София → Пловдив',
    startLatitude: 42.6977,
    startLongitude: 23.3219,
    at,
  });
}

/** Releases the fleet manager's standing assignment so the driver arrives holding nothing. */
async function releaseStandingAssignment(): Promise<void> {
  await prisma.vehicleAssignment.updateMany({
    where: { driverId: tenant.driverId, endedAt: null },
    data: { endedAt: NOW },
  });
}

describe('beginning to drive', () => {
  it('moves the session, assigns the vehicle and opens the trip together', async () => {
    const shiftId = await startShift();
    await releaseStandingAssignment();

    const context = await beginDriving(tenant.freeVehicleId);

    // One open session, and it is the driving position.
    const open = await prisma.positionSession.findMany({ where: { shiftId, endedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0]!.positionId).toBe(tenant.positionIds.driving);
    expect(open[0]!.id).toBe(context.positionSessionId);

    // The session it replaced is closed, not abandoned.
    const closed = await prisma.positionSession.findMany({
      where: { shiftId, endedAt: { not: null } },
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.positionId).toBe(tenant.positionIds.machine1);
    expect(closed[0]!.endedAt?.getTime()).toBe(NOW.getTime());

    // The trip is open and linked to the session that owns it.
    const trip = await prisma.driverTrip.findUniqueOrThrow({ where: { id: context.tripId } });
    expect(trip.status).toBe('ACTIVE');
    expect(trip.positionSessionId).toBe(context.positionSessionId);
    expect(trip.vehicleId).toBe(tenant.freeVehicleId);
    expect(trip.driverId).toBe(tenant.driverId);
    expect(trip.startedAt?.getTime()).toBe(NOW.getTime());

    // And the vehicle is held, by an assignment marked as this flow's to release.
    const assignment = await prisma.vehicleAssignment.findFirstOrThrow({
      where: { vehicleId: tenant.freeVehicleId, endedAt: null },
    });
    expect(assignment.driverId).toBe(tenant.driverId);
    expect(assignment.isAutomatic).toBe(true);
  });

  it('publishes driving.started only after the transaction commits', async () => {
    await startShift();
    await releaseStandingAssignment();
    const context = await beginDriving(tenant.freeVehicleId);

    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('driving.started');
    // The payload names rows a subscriber can read, which is only true post-commit.
    expect(events[0]!.payload).toMatchObject({
      tripId: context.tripId,
      driverId: tenant.driverId,
      vehicleId: tenant.freeVehicleId,
    });
  });

  it('reuses the assignment the driver already holds instead of creating a second', async () => {
    await startShift();

    // The fleet manager's standing assignment on `vehicleId` is left in place.
    const context = await beginDriving(tenant.vehicleId);

    const assignments = await prisma.vehicleAssignment.findMany({
      where: { vehicleId: tenant.vehicleId, endedAt: null },
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.isAutomatic).toBe(false);

    const trip = await prisma.driverTrip.findUniqueOrThrow({ where: { id: context.tripId } });
    expect(trip.vehicleId).toBe(tenant.vehicleId);
  });

  it('refuses a vehicle another driver holds, and changes nothing', async () => {
    const shiftId = await startShift();
    await releaseStandingAssignment();

    await expect(beginDriving(tenant.otherVehicleId)).rejects.toThrowError(
      /assigned to another driver/i,
    );

    // Nothing half-applied: still on the original position, still no trip.
    const open = await prisma.positionSession.findMany({ where: { shiftId, endedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0]!.positionId).toBe(tenant.positionIds.machine1);
    expect(await prisma.driverTrip.count({ where: { driverId: tenant.driverId } })).toBe(0);
  });

  it('refuses when the driver already holds a different vehicle', async () => {
    await startShift();
    // The standing assignment on `vehicleId` is still open, so taking a second van is a conflict
    // rather than something to resolve silently.
    await expect(beginDriving(tenant.freeVehicleId)).rejects.toThrowError(
      /already holds a different vehicle/i,
    );
    expect(await prisma.driverTrip.count()).toBe(0);
  });

  it('refuses a worker who is not registered as a driver', async () => {
    await startShift();
    await releaseStandingAssignment();
    // Unlinking is what a fleet manager does when someone stops driving. It must take effect
    // immediately, not at the next login.
    await prisma.driver.update({ where: { id: tenant.driverId }, data: { workerId: null } });

    await expect(beginDriving(tenant.freeVehicleId)).rejects.toThrowError(
      /not registered as a driver/i,
    );
    expect(await prisma.driverTrip.count()).toBe(0);
  });

  it('refuses a driver whose licence has expired', async () => {
    await startShift();
    await releaseStandingAssignment();
    await prisma.driver.update({
      where: { id: tenant.driverId },
      data: { licenseExpiresAt: new Date('2026-03-09T00:00:00Z') },
    });

    await expect(beginDriving(tenant.freeVehicleId)).rejects.toThrowError(/licence has expired/i);
    expect(await prisma.driverTrip.count()).toBe(0);
  });

  it('refuses a vehicle that is out of service', async () => {
    await startShift();
    await releaseStandingAssignment();
    await prisma.vehicle.update({
      where: { id: tenant.freeVehicleId },
      data: { status: 'IN_MAINTENANCE' },
    });

    await expect(beginDriving(tenant.freeVehicleId)).rejects.toThrowError(/maintenance/i);
    expect(await prisma.driverTrip.count()).toBe(0);
  });

  it('refuses to begin driving without a shift', async () => {
    await releaseStandingAssignment();
    await expect(beginDriving(tenant.freeVehicleId)).rejects.toThrowError(/shift in progress/i);
  });

  it('refuses to begin driving while on a break', async () => {
    const shiftId = await startShift();
    await shifts.startBreak({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      type: 'MEAL',
      at: NOW,
    });
    await releaseStandingAssignment();

    await expect(beginDriving(tenant.freeVehicleId)).rejects.toThrowError(/break/i);
    expect(await prisma.driverTrip.count()).toBe(0);
  });

  /**
   * Two taps on Потвърди, or one tap and an offline replay that arrives after the network
   * recovered. The idempotency ledger sits above this service, so what is tested here is the
   * floor beneath it: whatever happens, the worker does not end up with two open sessions.
   */
  it('never leaves two open position sessions under a concurrent begin', async () => {
    const shiftId = await startShift();
    await releaseStandingAssignment();

    await Promise.allSettled([
      beginDriving(tenant.freeVehicleId),
      beginDriving(tenant.freeVehicleId),
    ]);

    const open = await prisma.positionSession.findMany({ where: { shiftId, endedAt: null } });
    expect(open).toHaveLength(1);
  });
});

describe('the vehicle picker', () => {
  it('offers free vehicles and the driver’s own, and hides everyone else’s', async () => {
    const { vehicles } = await driving.listSelectableVehicles({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      positionId: tenant.positionIds.driving as PositionId,
      siteId: tenant.siteId as SiteId,
    });

    const ids = vehicles.map((vehicle) => vehicle.vehicleId as string);
    expect(ids).toContain(tenant.vehicleId);
    expect(ids).toContain(tenant.freeVehicleId);
    expect(ids).not.toContain(tenant.otherVehicleId);
  });

  it('puts the driver’s own vehicle first', async () => {
    const { vehicles } = await driving.listSelectableVehicles({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      positionId: tenant.positionIds.driving as PositionId,
      siteId: tenant.siteId as SiteId,
    });
    expect(vehicles[0]?.vehicleId).toBe(tenant.vehicleId);
    expect(vehicles[0]?.assignedToSelf).toBe(true);
  });

  it('never lists another tenant’s vehicles', async () => {
    const other = await createTestTenant('tenant-dh-2');
    const { vehicles } = await driving.listSelectableVehicles({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      positionId: tenant.positionIds.driving as PositionId,
      siteId: tenant.siteId as SiteId,
    });
    const ids = vehicles.map((vehicle) => vehicle.vehicleId as string);
    expect(ids).not.toContain(other.freeVehicleId);
    expect(ids).not.toContain(other.vehicleId);
  });

  it('refuses to list the fleet for a position the worker cannot occupy', async () => {
    // Otherwise this endpoint becomes a way to enumerate an organization's vehicles by asking
    // about a driving position the caller has no business taking.
    await prisma.position.update({
      where: { id: tenant.positionIds.driving },
      data: { changeMode: 'QUALIFICATION_REQUIRED' },
    });
    await prisma.positionQualification.create({
      data: {
        organizationId: tenant.organizationId,
        positionId: tenant.positionIds.driving,
        qualificationId: tenant.qualificationIds.cutting,
      },
    });

    await expect(
      driving.listSelectableVehicles({
        organizationId: tenant.organizationId as OrganizationId,
        workerId: tenant.workerId as WorkerId,
        positionId: tenant.positionIds.driving as PositionId,
        siteId: tenant.siteId as SiteId,
      }),
    ).rejects.toThrowError();
  });

  it('refuses to list the fleet for a worker who is not a driver', async () => {
    await prisma.driver.update({ where: { id: tenant.driverId }, data: { workerId: null } });
    await expect(
      driving.listSelectableVehicles({
        organizationId: tenant.organizationId as OrganizationId,
        workerId: tenant.workerId as WorkerId,
        positionId: tenant.positionIds.driving as PositionId,
        siteId: tenant.siteId as SiteId,
      }),
    ).rejects.toThrowError(/not registered as a driver/i);
  });
});

describe('leaving the driving position', () => {
  async function driveThenChangeTo(positionId: string) {
    const shiftId = await startShift();
    await releaseStandingAssignment();
    const context = await beginDriving(tenant.freeVehicleId);

    const later = buildServices(LATER);
    const result = await later.shifts.changePosition({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      targetPositionId: positionId as PositionId,
      at: LATER,
      source: 'MANUAL',
    });
    return { shiftId, context, result };
  }

  it('closes the trip when the worker changes to a standing position', async () => {
    const { context, result } = await driveThenChangeTo(tenant.positionIds.packaging);

    const trip = await prisma.driverTrip.findUniqueOrThrow({ where: { id: context.tripId } });
    expect(trip.status).toBe('COMPLETED');
    expect(trip.endedAt?.getTime()).toBe(LATER.getTime());
    expect(result.endedDriving).not.toBeNull();
  });

  it('releases the assignment this flow created', async () => {
    await driveThenChangeTo(tenant.positionIds.packaging);

    const open = await prisma.vehicleAssignment.findMany({
      where: { vehicleId: tenant.freeVehicleId, endedAt: null },
    });
    expect(open).toHaveLength(0);
  });

  it('leaves a fleet manager’s standing assignment alone', async () => {
    // Same flow, but on the vehicle the driver already held long-term. Ending one trip must not
    // dissolve a decision somebody made deliberately.
    const shiftId = await startShift();
    await beginDriving(tenant.vehicleId);

    const later = buildServices(LATER);
    await later.shifts.changePosition({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      targetPositionId: tenant.positionIds.packaging as PositionId,
      at: LATER,
      source: 'MANUAL',
    });

    const standing = await prisma.vehicleAssignment.findFirstOrThrow({
      where: { vehicleId: tenant.vehicleId, endedAt: null },
    });
    expect(standing.isAutomatic).toBe(false);
    expect(standing.driverId).toBe(tenant.driverId);
    expect(shiftId).toBeTruthy();
  });

  it('records the trip duration from the session, not from the client', async () => {
    const { context } = await driveThenChangeTo(tenant.positionIds.packaging);
    const trip = await prisma.driverTrip.findUniqueOrThrow({ where: { id: context.tripId } });
    // Four hours between NOW and LATER, and no points were ever submitted — so the distance is
    // zero and the whole trip is untracked. Both are computed server-side.
    expect(trip.durationSeconds).toBe(4 * 3600);
    expect(trip.distanceMeters).toBe(0);
  });

  it('closes the trip when the shift ends while still driving', async () => {
    const shiftId = await startShift();
    await releaseStandingAssignment();
    const context = await beginDriving(tenant.freeVehicleId);

    const later = buildServices(LATER);
    const result = await later.shifts.endShift({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      at: LATER,
    });

    const trip = await prisma.driverTrip.findUniqueOrThrow({ where: { id: context.tripId } });
    expect(trip.status).toBe('COMPLETED');
    expect(result.endedDriving).not.toBeNull();

    const open = await prisma.vehicleAssignment.findMany({
      where: { vehicleId: tenant.freeVehicleId, endedAt: null },
    });
    expect(open).toHaveLength(0);

    // And nothing is left running: no open session, no open trip.
    expect(await prisma.positionSession.count({ where: { shiftId, endedAt: null } })).toBe(0);
    expect(await prisma.driverTrip.count({ where: { status: 'ACTIVE' } })).toBe(0);
  });

  it('lets the worker drive again after leaving, with a fresh trip', async () => {
    const { context: first } = await driveThenChangeTo(tenant.positionIds.packaging);

    const later = buildServices(LATER);
    const second = await later.driving.beginDriving({
      organizationId: tenant.organizationId as OrganizationId,
      workerId: tenant.workerId as WorkerId,
      positionId: tenant.positionIds.driving as PositionId,
      vehicleId: tenant.freeVehicleId as VehicleId,
      label: null,
      startLatitude: null,
      startLongitude: null,
      at: LATER,
    });

    expect(second.tripId).not.toBe(first.tripId);
    expect(await prisma.driverTrip.count({ where: { status: 'ACTIVE' } })).toBe(1);
  });
});
