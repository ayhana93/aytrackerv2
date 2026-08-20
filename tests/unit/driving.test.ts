import { describe, expect, it } from 'vitest';
import {
  DRIVING_SESSION_PERMISSIONS,
  assertCanDrive,
  assertCanEndDriving,
  isDrivingPosition,
  planAssignment,
  selectableVehicles,
  withDrivingPermissions,
  withoutDrivingPermissions,
  type AssignmentContext,
  type DriverProfile,
  type SelectableVehicle,
} from '@aytracker/module-shifts';
import type { DriverId, VehicleId, WorkerId } from '@aytracker/types';

/**
 * The rules behind "tap Шофьор, pick a van, start driving".
 *
 * Handing someone a company vehicle is the highest-consequence thing a worker can do from their
 * own phone without anybody approving it, so these read as an adversarial checklist: every way in
 * that should be shut, and the one that should be open.
 */

const NOW = new Date('2026-03-10T06:00:00Z');
const WORKER = 'worker-1' as WorkerId;
const DRIVER = 'driver-1' as DriverId;
const OTHER_DRIVER = 'driver-2' as DriverId;
const VAN = 'vehicle-van' as VehicleId;
const TRUCK = 'vehicle-truck' as VehicleId;

function profile(overrides: Partial<DriverProfile> = {}): DriverProfile {
  return {
    driverId: DRIVER,
    workerId: WORKER,
    status: 'ACTIVE',
    licenseExpiresAt: new Date('2030-01-01T00:00:00Z'),
    ...overrides,
  };
}

function vehicle(overrides: Partial<SelectableVehicle> = {}): SelectableVehicle {
  return {
    vehicleId: VAN,
    registrationNumber: 'CA 1234 AB',
    make: 'Ford',
    model: 'Transit',
    vehicleType: 'VAN',
    fuelType: 'DIESEL',
    odometer: '184320',
    status: 'ACTIVE',
    assignedToDriverId: null,
    assignedToSelf: false,
    ...overrides,
  };
}

describe('who may take a vehicle', () => {
  it('allows an active driver with a valid licence', () => {
    expect(() => assertCanDrive(profile(), NOW)).not.toThrow();
  });

  it('refuses a worker who is not registered as a driver', () => {
    // The important half of this rule is what it does NOT do: there is no create-on-demand path,
    // because a driver record carries a licence and conjuring one would put an unlicensed person
    // behind a company vehicle with the system's blessing.
    expect(() => assertCanDrive(null, NOW)).toThrow(/not registered as a driver/i);
  });

  it('refuses an inactive driver profile', () => {
    expect(() => assertCanDrive(profile({ status: 'INACTIVE' }), NOW)).toThrow(/not active/i);
  });

  it('refuses a suspended driver profile', () => {
    expect(() => assertCanDrive(profile({ status: 'SUSPENDED' }), NOW)).toThrow(/not active/i);
  });

  it('refuses an expired licence rather than warning about it', () => {
    const expired = profile({ licenseExpiresAt: new Date('2026-03-09T23:59:59Z') });
    expect(() => assertCanDrive(expired, NOW)).toThrow(/licence has expired/i);
  });

  it('treats a licence expiring exactly now as expired', () => {
    // The boundary belongs on the safe side. A licence valid "until" a moment is not valid at it.
    const expiring = profile({ licenseExpiresAt: NOW });
    expect(() => assertCanDrive(expiring, NOW)).toThrow(/licence has expired/i);
  });

  it('allows a driver with no recorded expiry', () => {
    // Some licence categories genuinely have none. Absent is not the same as expired.
    expect(() => assertCanDrive(profile({ licenseExpiresAt: null }), NOW)).not.toThrow();
  });
});

describe('what the vehicle picker offers', () => {
  it('offers unassigned active vehicles', () => {
    const result = selectableVehicles([vehicle()]);
    expect(result).toHaveLength(1);
  });

  it.each(['IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD', 'ARCHIVED'] as const)(
    'hides a vehicle that is %s',
    (status) => {
      expect(selectableVehicles([vehicle({ status })])).toHaveLength(0);
    },
  );

  it('hides a vehicle held by another driver', () => {
    const taken = vehicle({ assignedToDriverId: OTHER_DRIVER, assignedToSelf: false });
    expect(selectableVehicles([taken])).toHaveLength(0);
  });

  it('offers the vehicle this driver already holds', () => {
    const own = vehicle({ assignedToDriverId: DRIVER, assignedToSelf: true });
    expect(selectableVehicles([own])).toHaveLength(1);
  });

  it("puts the driver's own vehicle first, then sorts by registration", () => {
    // On most mornings the driver wants the van that is already theirs, so putting it at the top
    // turns the picker into a confirmation instead of a search through forty registrations.
    const result = selectableVehicles([
      vehicle({ vehicleId: 'v-c' as VehicleId, registrationNumber: 'CA 3000 CC' }),
      vehicle({ vehicleId: 'v-a' as VehicleId, registrationNumber: 'CA 1000 AA' }),
      vehicle({
        vehicleId: TRUCK,
        registrationNumber: 'CA 9999 ZZ',
        assignedToDriverId: DRIVER,
        assignedToSelf: true,
      }),
      vehicle({ vehicleId: 'v-b' as VehicleId, registrationNumber: 'CA 2000 BB' }),
    ]);

    expect(result.map((v) => v.registrationNumber)).toEqual([
      'CA 9999 ZZ',
      'CA 1000 AA',
      'CA 2000 BB',
      'CA 3000 CC',
    ]);
  });

  it('does not mutate the list it was given', () => {
    // It sorts, and sorting in place would reorder whatever the caller still holds a reference to.
    const input = [
      vehicle({ vehicleId: 'v-b' as VehicleId, registrationNumber: 'CA 2000 BB' }),
      vehicle({ vehicleId: 'v-a' as VehicleId, registrationNumber: 'CA 1000 AA' }),
    ];
    selectableVehicles(input);
    expect(input.map((v) => v.registrationNumber)).toEqual(['CA 2000 BB', 'CA 1000 AA']);
  });
});

describe('assignment conflicts', () => {
  function context(overrides: Partial<AssignmentContext> = {}): AssignmentContext {
    return {
      vehicle: vehicle(),
      vehicleAssignment: null,
      driverAssignment: null,
      ...overrides,
    };
  }

  it('creates an assignment for a free vehicle', () => {
    expect(planAssignment(context(), DRIVER)).toEqual({ action: 'CREATE' });
  });

  it('reuses the assignment the driver already holds', () => {
    // Nothing to create, and nothing for the handoff to release later either — this is a fleet
    // manager's standing assignment, not one this flow made.
    const plan = planAssignment(
      context({
        vehicle: vehicle({ assignedToDriverId: DRIVER, assignedToSelf: true }),
        vehicleAssignment: { id: 'assignment-1', driverId: DRIVER },
        driverAssignment: { id: 'assignment-1', vehicleId: VAN },
      }),
      DRIVER,
    );
    expect(plan).toEqual({ action: 'REUSE', assignmentId: 'assignment-1' });
  });

  it('refuses a vehicle held by another driver instead of taking it', () => {
    expect(() =>
      planAssignment(
        context({ vehicleAssignment: { id: 'assignment-9', driverId: OTHER_DRIVER } }),
        DRIVER,
      ),
    ).toThrow(/assigned to another driver/i);
  });

  it('refuses when the driver already holds a different vehicle', () => {
    // Silently dropping the van they already have is the kind of helpfulness that loses a vehicle
    // at 06:00 and costs someone an hour finding out why.
    expect(() =>
      planAssignment(
        context({ driverAssignment: { id: 'assignment-2', vehicleId: TRUCK } }),
        DRIVER,
      ),
    ).toThrow(/already holds a different vehicle/i);
  });

  it('refuses a vehicle that is not active even if nobody holds it', () => {
    expect(() =>
      planAssignment(context({ vehicle: vehicle({ status: 'IN_MAINTENANCE' }) }), DRIVER),
    ).toThrow(/maintenance/i);
  });

  it('checks availability before ownership, so an out-of-service vehicle never looks free', () => {
    const plan = () =>
      planAssignment(
        context({
          vehicle: vehicle({ status: 'OUT_OF_SERVICE' }),
          vehicleAssignment: { id: 'assignment-3', driverId: DRIVER },
        }),
        DRIVER,
      );
    expect(plan).toThrow(/out of service/i);
  });
});

describe('ending the driving context', () => {
  const STARTED = new Date('2026-03-10T07:00:00Z');
  const ENDED = new Date('2026-03-10T11:30:00Z');

  it('allows closing an active trip', () => {
    expect(() =>
      assertCanEndDriving({ tripStatus: 'ACTIVE', at: ENDED, tripStartedAt: STARTED }),
    ).not.toThrow();
  });

  it.each(['COMPLETED', 'CANCELLED'] as const)('accepts an already %s trip', (tripStatus) => {
    // Idempotent on purpose: the caller may be finishing a partially-applied handoff, and
    // throwing here would leave a worker stuck in a position they cannot leave.
    expect(() => assertCanEndDriving({ tripStatus, at: ENDED, tripStartedAt: null })).not.toThrow();
  });

  it('refuses a trip with no start time', () => {
    expect(() =>
      assertCanEndDriving({ tripStatus: 'ACTIVE', at: ENDED, tripStartedAt: null }),
    ).toThrow(/no start time/i);
  });

  it('refuses an end before the start', () => {
    // Reachable through a replayed offline action with a skewed device clock, which is exactly
    // why the check is here and not only in the UI.
    expect(() =>
      assertCanEndDriving({
        tripStatus: 'ACTIVE',
        at: new Date('2026-03-10T06:59:00Z'),
        tripStartedAt: STARTED,
      }),
    ).toThrow(/cannot end before it began/i);
  });

  it('allows a zero-length trip', () => {
    // A driver who confirms and immediately changes their mind. Odd, not invalid.
    expect(() =>
      assertCanEndDriving({ tripStatus: 'ACTIVE', at: STARTED, tripStartedAt: STARTED }),
    ).not.toThrow();
  });
});

describe('session elevation', () => {
  const BASE = ['worker.portal.access', 'worker.position.change'];

  it('adds every driving permission', () => {
    const elevated = withDrivingPermissions(BASE);
    for (const permission of DRIVING_SESSION_PERMISSIONS) {
      expect(elevated).toContain(permission);
    }
  });

  it('keeps the permissions the worker already had', () => {
    const elevated = withDrivingPermissions(BASE);
    expect(elevated).toContain('worker.portal.access');
    expect(elevated).toContain('worker.position.change');
  });

  it('does not duplicate a permission the session already carried', () => {
    const elevated = withDrivingPermissions([...BASE, 'driver.portal.access']);
    expect(elevated.filter((p) => p === 'driver.portal.access')).toHaveLength(1);
  });

  it('removes exactly what it added, and nothing else', () => {
    // The stripping runs in the same transaction that closes the driving session. If it removed
    // more than it added, leaving a driving position would quietly cost the worker access to
    // their own portal.
    const restored = withoutDrivingPermissions(withDrivingPermissions(BASE));
    expect([...restored].sort()).toEqual([...BASE].sort());
  });

  it('is a no-op on a session that never drove', () => {
    expect(withoutDrivingPermissions(BASE)).toEqual(BASE);
  });

  it('does not mutate the array it was given', () => {
    const base = [...BASE];
    withDrivingPermissions(base);
    withoutDrivingPermissions(base);
    expect(base).toEqual(BASE);
  });
});

describe('position kind', () => {
  it('routes only DRIVING positions through the vehicle picker', () => {
    expect(isDrivingPosition('DRIVING')).toBe(true);
    expect(isDrivingPosition('STANDARD')).toBe(false);
  });
});
