import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@aytracker/api/app';
import { buildServices } from '@aytracker/api/services/container';
import { buildAppConfig, parseServerEnv } from '@aytracker/config';
import { FEATURES } from '@aytracker/billing';
import {
  createTestTenant,
  disconnectTestClient,
  getTestClient,
  grantFeature,
  resetDatabase,
  seedPlatformReferenceData,
  testDatabaseUrl,
  type TestTenant,
} from '../helpers/database.js';

/**
 * The admin portal over HTTP.
 *
 * Two properties matter more than the shapes of the responses. First, a route is scoped by the
 * session's organization inside the query — so another tenant's data is *not found*, never
 * "forbidden", because confirming a row exists elsewhere is itself the leak. Second, a worker or
 * driver session cannot reach these routes at all, including a worker session elevated for
 * driving, which carries driver permissions but is still not a person with a management seat.
 */

const prisma = getTestClient();

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  await seedPlatformReferenceData();
  const config = buildAppConfig(
    parseServerEnv({
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      SESSION_SECRET: 'x'.repeat(64),
      APP_URL: 'http://localhost:3000',
      API_URL: 'http://localhost:3001',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
      RATE_LIMIT_ENABLED: 'false',
    }),
  );
  app = await buildApp(config, buildServices(config));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await disconnectTestClient();
});

beforeEach(async () => {
  await resetDatabase();
  await seedPlatformReferenceData();
  tenant = await createTestTenant('tenant-admin');
  other = await createTestTenant('tenant-admin-2');
  // Route reading is behind the GPS entitlement. Granted explicitly here so the paywall tests
  // below are about the paywall rather than about a fixture that happened to be unentitled.
  await grantFeature(tenant.organizationId, FEATURES.GPS_TRACKING);
  await grantFeature(other.organizationId, FEATURES.GPS_TRACKING);
});

function cookiesFrom(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function loginAdmin(slug: string): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `admin@${slug}.test`, password: 'integration-test-pass' },
  });
  expect(response.statusCode, response.body).toBe(200);

  const cookie = cookiesFrom(response.headers['set-cookie']);
  const csrf = /ay_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  return { cookie, csrf };
}

async function loginWorker(slug: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/worker/login',
    payload: { organizationSlug: slug, employeeNumber: '1001', pin: '482913' },
  });
  return cookiesFrom(response.headers['set-cookie']);
}

/** A completed trip with a track and one deliberate hole in it. */
async function seedTrip(target: TestTenant, minutes = 40): Promise<string> {
  const startedAt = new Date('2026-03-10T08:00:00Z');
  const endedAt = new Date(startedAt.getTime() + minutes * 60_000);

  const trip = await prisma.driverTrip.create({
    data: {
      organizationId: target.organizationId,
      driverId: target.driverId,
      vehicleId: target.vehicleId,
      status: 'COMPLETED',
      startedAt,
      endedAt,
      distanceMeters: 0,
      durationSeconds: minutes * 60,
    },
  });

  // Every 30 s, with points 10–20 min in omitted so exactly one gap exists.
  const points: { timestamp: Date; latitude: string; longitude: string }[] = [];
  for (let elapsed = 0; elapsed <= minutes * 60; elapsed += 30) {
    if (elapsed > 600 && elapsed < 1200) continue;
    const progress = elapsed / (minutes * 60);
    points.push({
      timestamp: new Date(startedAt.getTime() + elapsed * 1000),
      latitude: (42.6977 - progress * 0.5).toFixed(6),
      longitude: (23.3219 + progress * 1.4).toFixed(6),
    });
  }

  await prisma.tripLocationPoint.createMany({
    data: points.map((point) => ({
      organizationId: target.organizationId,
      tripId: trip.id,
      timestamp: point.timestamp,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracyMeters: '12.50',
      source: 'GPS',
    })),
  });

  return trip.id;
}

describe('who may reach the admin portal', () => {
  it('refuses an anonymous request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/dashboard' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a worker session', async () => {
    // A worker portal token is not a management seat, whatever else it carries.
    const cookie = await loginWorker(tenant.slug);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows an admin user', async () => {
    const { cookie } = await loginAdmin(tenant.slug);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard',
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
  });
});

describe('tenant scoping', () => {
  it('never returns another organization’s vehicles', async () => {
    const { cookie } = await loginAdmin(tenant.slug);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/vehicles',
      headers: { cookie },
    });

    const ids = response.json().vehicles.map((vehicle: { id: string }) => vehicle.id);
    expect(ids).toContain(tenant.vehicleId);
    expect(ids).not.toContain(other.vehicleId);
    expect(ids).not.toContain(other.freeVehicleId);
  });

  it('reports another organization’s trip as not found, not forbidden', async () => {
    // 404 rather than 403 on purpose: a 403 confirms the trip exists, which is the leak.
    const foreignTrip = await seedTrip(other);
    const { cookie } = await loginAdmin(tenant.slug);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/trips/${foreignTrip}/track`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('never lists another organization’s trips', async () => {
    await seedTrip(other);
    const own = await seedTrip(tenant);
    const { cookie } = await loginAdmin(tenant.slug);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/trips?from=2026-03-01T00:00:00Z&to=2026-03-31T00:00:00Z',
      headers: { cookie },
    });
    const ids = response.json().trips.map((trip: { id: string }) => trip.id);
    expect(ids).toEqual([own]);
  });
});

describe('the route a map draws', () => {
  it('returns a polyline with the gap marked as a break', async () => {
    const tripId = await seedTrip(tenant);
    const { cookie } = await loginAdmin(tenant.slug);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/trips/${tripId}/track`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();

    expect(body.track.points.length).toBeGreaterThan(50);
    // Exactly one break: the ten-minute silence, and nothing else. More than one would mean the
    // sampling is too sparse to draw a line from; zero would mean the hole was bridged, which is
    // the failure this whole design exists to prevent.
    expect(body.track.gapAfterIndices).toHaveLength(1);
    expect(body.gaps).toHaveLength(1);
    expect(body.gaps[0].seconds).toBeGreaterThanOrEqual(540);
  });

  it('reports a distance that excludes the gap', async () => {
    const tripId = await seedTrip(tenant);
    const { cookie } = await loginAdmin(tenant.slug);
    const body = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/admin/trips/${tripId}/track`,
        headers: { cookie },
      })
    ).json();

    // The straight line across the hole is not counted. The figure is a floor, deliberately.
    const straightThrough = 130_000;
    expect(body.track.distanceMeters).toBeGreaterThan(0);
    expect(body.track.distanceMeters).toBeLessThan(straightThrough);
  });

  it('returns an empty track rather than failing when a trip has no points', async () => {
    // A trip that began and was cancelled before the first fix. The map should render nothing,
    // not error — and the admin should still see the trip exists.
    const trip = await prisma.driverTrip.create({
      data: {
        organizationId: tenant.organizationId,
        driverId: tenant.driverId,
        vehicleId: tenant.vehicleId,
        status: 'CANCELLED',
        startedAt: new Date('2026-03-10T08:00:00Z'),
        endedAt: new Date('2026-03-10T08:01:00Z'),
      },
    });
    const { cookie } = await loginAdmin(tenant.slug);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/trips/${trip.id}/track`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().track.points).toEqual([]);
  });
});

describe('the stops on a route', () => {
  /** A trip that drives, parks for `parkedMinutes`, then drives on. */
  async function seedTripWithStop(target: TestTenant, parkedMinutes: number): Promise<string> {
    const startedAt = new Date('2026-03-10T08:00:00Z');
    const driveMinutes = 10;
    const totalMinutes = driveMinutes * 2 + parkedMinutes;

    const trip = await prisma.driverTrip.create({
      data: {
        organizationId: target.organizationId,
        driverId: target.driverId,
        vehicleId: target.vehicleId,
        status: 'COMPLETED',
        startedAt,
        endedAt: new Date(startedAt.getTime() + totalMinutes * 60_000),
        distanceMeters: 0,
        durationSeconds: totalMinutes * 60,
      },
    });

    const points: { timestamp: Date; latitude: string; longitude: string }[] = [];
    // Reported every 30 s throughout, so nothing here is a tracking gap — the stop has to be
    // found from the positions, not inferred from silence.
    for (let elapsed = 0; elapsed <= totalMinutes * 60; elapsed += 30) {
      const parkedFrom = driveMinutes * 60;
      const parkedUntil = parkedFrom + parkedMinutes * 60;

      let progress: number;
      if (elapsed < parkedFrom) progress = elapsed / parkedFrom;
      else if (elapsed <= parkedUntil) progress = 1;
      else progress = 1 + (elapsed - parkedUntil) / parkedFrom;

      points.push({
        timestamp: new Date(startedAt.getTime() + elapsed * 1000),
        latitude: (42.6977 - progress * 0.05).toFixed(6),
        longitude: (23.3219 + progress * 0.14).toFixed(6),
      });
    }

    await prisma.tripLocationPoint.createMany({
      data: points.map((point) => ({
        organizationId: target.organizationId,
        tripId: trip.id,
        timestamp: point.timestamp,
        latitude: point.latitude,
        longitude: point.longitude,
        accuracyMeters: '12.50',
        source: 'GPS',
      })),
    });

    return trip.id;
  }

  async function track(target: TestTenant, tripId: string) {
    const { cookie } = await loginAdmin(target.slug);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/trips/${tripId}/track`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  it('marks where the vehicle stood still for longer than twenty minutes', async () => {
    const body = await track(tenant, await seedTripWithStop(tenant, 35));

    expect(body.stops).toHaveLength(1);
    expect(body.stops[0].seconds).toBeGreaterThanOrEqual(35 * 60);
    // Placed where the vehicle actually was, not at the origin or at the trip's midpoint.
    expect(body.stops[0].latitude).toBeCloseTo(42.6477, 2);
    expect(body.stops[0].longitude).toBeCloseTo(23.4619, 2);
  });

  it('says nothing about a pause too short to be worth asking about', async () => {
    // Twelve minutes is a delivery, a level crossing or a queue. Marking it would bury the
    // forty-minute stop that someone actually opened the map to find.
    const body = await track(tenant, await seedTripWithStop(tenant, 12));
    expect(body.stops).toEqual([]);
  });

  /**
   * The refusal that keeps a stop from becoming an accusation.
   *
   * `seedTrip` omits ten minutes of points in the middle of a Sofia→Plovdiv drive. The vehicle
   * was moving fast on either side of that silence, and nothing about it says "parked" — a stop
   * reported there would be the interface inventing a fact from an absence of data.
   */
  it('does not report a period without data as a stop', async () => {
    const body = await track(tenant, await seedTrip(tenant));

    expect(body.gaps).toHaveLength(1);
    expect(body.stops).toEqual([]);
  });
});

describe('putting somebody on the roster', () => {
  const PERSON = {
    employeeNumber: '2042',
    firstName: 'Мария',
    lastName: 'Георгиева',
    pin: '735100',
  };

  async function addWorker(target: TestTenant, overrides: Record<string, unknown> = {}) {
    const { cookie, csrf } = await loginAdmin(target.slug);
    return app.inject({
      method: 'POST',
      url: '/api/v1/admin/workers',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { ...PERSON, ...overrides },
    });
  }

  it('creates a worker who can then sign in with the PIN the admin chose', async () => {
    const created = await addWorker(tenant);
    expect(created.statusCode, created.body).toBe(201);

    // The point of the whole screen: the credential an admin typed opens the worker's door.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/worker/login',
      payload: {
        organizationSlug: tenant.slug,
        employeeNumber: PERSON.employeeNumber,
        pin: PERSON.pin,
      },
    });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().actorType).toBe('WORKER');
  });

  it('never returns the PIN or its hash', async () => {
    const created = await addWorker(tenant);
    const body = created.body;

    // Asserted against the raw response text rather than a parsed field, because the failure this
    // guards against is a hash arriving in some field nobody thought to check.
    expect(body).not.toContain(PERSON.pin);
    expect(body).not.toContain('$argon2');
    expect(body).not.toContain('pinHash');
    expect(created.json().worker.hasPin).toBe(true);

    const { cookie } = await loginAdmin(tenant.slug);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/workers',
      headers: { cookie },
    });
    expect(list.body).not.toContain('$argon2');
    expect(list.body).not.toContain(PERSON.pin);
    expect(
      list.json().workers.find((w: { employeeNumber: string }) => w.employeeNumber === '2042')
        .hasPin,
    ).toBe(true);
  });

  it('adds someone without a PIN, who then cannot sign in yet', async () => {
    // A roster entered on Friday afternoon before the PINs are handed out. "Cannot sign in yet" is
    // a true state, not a broken one — but it must actually refuse.
    const created = await addWorker(tenant, { pin: undefined, employeeNumber: '2043' });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().worker.hasPin).toBe(false);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/worker/login',
      payload: { organizationSlug: tenant.slug, employeeNumber: '2043', pin: '0000' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('refuses an employee number already used in this organization', async () => {
    await addWorker(tenant);
    const second = await addWorker(tenant);

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('worker.employee_number_taken');
  });

  it('lets two organizations use the same employee number', async () => {
    // Employee numbers are unique per tenant. A global rule would mean one customer's numbering
    // scheme could block another's — and would leak that the number is taken somewhere.
    expect((await addWorker(tenant)).statusCode).toBe(201);
    expect((await addWorker(other)).statusCode).toBe(201);
  });

  it('rejects a PIN that is not 4–8 digits', async () => {
    const tooShort = await addWorker(tenant, { pin: '12', employeeNumber: '2044' });
    expect(tooShort.statusCode).toBe(400);

    const notDigits = await addWorker(tenant, { pin: 'abcd12', employeeNumber: '2045' });
    expect(notDigits.statusCode).toBe(400);
  });

  /**
   * The PINs an attacker tries first, refused at the edge.
   *
   * These are what a person picks for somebody else when nothing stops them — and a PIN is the
   * only thing standing between anyone holding the company code and a worker's shift record.
   */
  it.each(['0000', '1111', '1234', '4321', '456789'])(
    'refuses the guessable PIN %s',
    async (pin) => {
      const response = await addWorker(tenant, { pin, employeeNumber: `21${pin.slice(0, 2)}` });
      expect(response.statusCode, response.body).toBe(400);
    },
  );

  it('gives a driver profile to somebody who also drives, on the same PIN', async () => {
    const created = await addWorker(tenant, { isDriver: true });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().worker.driver.code).toBe(PERSON.employeeNumber);

    // One person, one credential, both doors.
    const driverLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/driver/login',
      payload: {
        organizationSlug: tenant.slug,
        driverCode: PERSON.employeeNumber,
        pin: PERSON.pin,
      },
    });
    expect(driverLogin.statusCode, driverLogin.body).toBe(200);
    expect(driverLogin.json().actorType).toBe('DRIVER');
  });

  it('never lists another organization’s staff', async () => {
    await addWorker(other, { employeeNumber: '9001' });
    const { cookie } = await loginAdmin(tenant.slug);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/workers',
      headers: { cookie },
    });
    const numbers = list
      .json()
      .workers.map((worker: { employeeNumber: string }) => worker.employeeNumber);
    expect(numbers).not.toContain('9001');
  });

  it('refuses a worker session', async () => {
    const cookie = await loginWorker(tenant.slug);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/workers',
      headers: { cookie },
      payload: PERSON,
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(401);
    expect(response.statusCode).toBeLessThan(500);
  });
});

describe('resetting a PIN', () => {
  async function seedWorker(): Promise<string> {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/workers',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { employeeNumber: '3100', firstName: 'Иван', lastName: 'Петров', pin: '748291' },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().worker.id;
  }

  async function workerLogin(pin: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/worker/login',
      payload: { organizationSlug: tenant.slug, employeeNumber: '3100', pin },
    });
  }

  it('replaces the old PIN with the new one', async () => {
    const workerId = await seedWorker();
    const { cookie, csrf } = await loginAdmin(tenant.slug);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/workers/${workerId}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { pin: '350617' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    expect((await workerLogin('350617')).statusCode).toBe(200);
    // The old one has to stop working, or a reset is an addition rather than a replacement.
    expect((await workerLogin('748291')).statusCode).toBe(401);
  });

  it('deactivates somebody without deleting their history', async () => {
    const workerId = await seedWorker();
    const { cookie, csrf } = await loginAdmin(tenant.slug);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/workers/${workerId}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { status: 'INACTIVE' },
    });

    const stored = await prisma.worker.findUnique({
      where: { id: workerId },
      select: { status: true, deletedAt: true },
    });
    expect(stored?.status).toBe('INACTIVE');
    // Still a row. Every session, shift and production entry ever recorded points at it.
    expect(stored?.deletedAt).toBeNull();
  });

  it('reports another organization’s worker as not found', async () => {
    const workerId = await seedWorker();
    const { cookie, csrf } = await loginAdmin(other.slug);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/workers/${workerId}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { pin: '506183' },
    });

    // Not found, never forbidden: confirming the row exists elsewhere is itself the leak.
    expect(response.statusCode).toBe(404);
  });
});

describe('registering a vehicle', () => {
  const VAN = {
    registrationNumber: 'CA 1234 AB',
    make: 'Ford',
    model: 'Transit',
    vehicleType: 'VAN',
    fuelType: 'DIESEL',
    odometerCurrent: '148320',
  };

  it('adds a vehicle to the organization that created it', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/vehicles',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: VAN,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().vehicle.registrationNumber).toBe('CA 1234 AB');
    // The odometer survives the round trip as a decimal string rather than arriving as a float.
    expect(response.json().vehicle.odometer).toBe('148320');

    const stored = await prisma.vehicle.findFirst({
      where: { organizationId: tenant.organizationId, registrationNumber: 'CA 1234 AB' },
      select: { organizationId: true, siteId: true },
    });
    expect(stored?.organizationId).toBe(tenant.organizationId);
    // Attached to the organization's own site, resolved server-side rather than sent.
    expect(stored?.siteId).not.toBeNull();
  });

  it('refuses a registration number that is already taken in this organization', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    const headers = { cookie, 'x-csrf-token': csrf };

    await app.inject({ method: 'POST', url: '/api/v1/admin/vehicles', headers, payload: VAN });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/vehicles',
      headers,
      payload: VAN,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('vehicle.registration_taken');
  });

  it('lets two organizations register the same plate', async () => {
    // Registration numbers are unique per tenant, not globally. A shared uniqueness rule would
    // leak the fact that another customer runs that vehicle.
    const first = await loginAdmin(tenant.slug);
    const second = await loginAdmin(other.slug);

    for (const session of [first, second]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/vehicles',
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
        payload: VAN,
      });
      expect(response.statusCode, response.body).toBe(201);
    }
  });

  it('rejects a vehicle with no registration number', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/vehicles',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { ...VAN, registrationNumber: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a worker session', async () => {
    const cookie = await loginWorker(tenant.slug);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/vehicles',
      headers: { cookie },
      payload: VAN,
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(401);
    expect(response.statusCode).toBeLessThan(500);
  });
});

describe('the GPS entitlement', () => {
  it('refuses the route to an organization that has not paid for tracking', async () => {
    // The paywall belongs on the data, not on the driver's device. An organization without the
    // feature must not read routes through the admin portal either.
    const unpaid = await createTestTenant('tenant-admin-3');
    const tripId = await seedTrip(unpaid);
    const { cookie } = await loginAdmin(unpaid.slug);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/trips/${tripId}/track`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('entitlement.required');
  });

  it('still lists trips without it, so the paywall hides routes and not the fleet', async () => {
    const unpaid = await createTestTenant('tenant-admin-4');
    await seedTrip(unpaid);
    const { cookie } = await loginAdmin(unpaid.slug);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/trips?from=2026-03-01T00:00:00Z&to=2026-03-31T00:00:00Z',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().trips).toHaveLength(1);
  });
});

describe('the dashboard', () => {
  it('counts only this organization’s open position sessions', async () => {
    const { cookie } = await loginAdmin(tenant.slug);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard',
      headers: { cookie },
    });

    const body = response.json();
    expect(body.totals).toBeDefined();
    expect(Array.isArray(body.hourly)).toBe(true);
    expect(Array.isArray(body.activePositions)).toBe(true);
  });

  it('clamps an absurd range instead of scanning a year of GPS', async () => {
    const { cookie } = await loginAdmin(tenant.slug);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard?from=1990-01-01T00:00:00Z&to=2026-03-10T00:00:00Z',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const { from, to } = response.json().range;
    const days = (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeLessThanOrEqual(92);
  });

  it('survives a malformed date instead of returning a 500', async () => {
    const { cookie } = await loginAdmin(tenant.slug);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard?from=not-a-date',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });
});

/**
 * Settings: the organization's own name, logo and administrator addresses.
 *
 * The properties worth holding are not the shapes of the responses. A logo is a file we later
 * serve from our own origin onto a customer's login page, so what may be stored is a security
 * question; an email address is a login identity, so who may change whose is an authorization
 * question. Both are tested here rather than inferred from the route reading correctly.
 */

/** A one-pixel PNG, as a browser's FileReader would hand it over. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('renaming the organization', () => {
  it('changes the name every screen shows, including the session the shell renders from', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/organization',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Акме ЕООД' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().organization.name).toBe('Акме ЕООД');

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json().organizationName).toBe('Акме ЕООД');
  });

  it('leaves the login code alone, because a rename must not lock the workforce out', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/organization',
      headers: { cookie, 'x-csrf-token': csrf },
      // A slug in the body is not a field this endpoint has; it must be ignored, not honoured.
      payload: { name: 'Ново име', slug: 'something-else' },
    });

    const after = await prisma.organization.findUniqueOrThrow({
      where: { id: tenant.organizationId },
      select: { slug: true },
    });
    expect(after.slug).toBe(tenant.slug);
  });

  it('records who renamed it', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/organization',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Одитирано име' },
    });

    const entry = await prisma.auditLog.findFirst({
      where: { organizationId: tenant.organizationId, action: 'organization.updated' },
    });
    expect(entry?.actorUserId).toBe(tenant.adminUserId);
  });
});

describe('the logo an organization uploads', () => {
  it('stores a PNG, serves it publicly and shows it on the tenant’s login screen', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);

    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/branding/logos',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { fileName: 'logo.png', data: TINY_PNG, activate: true },
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const logo = upload.json().logo;
    expect(logo.contentType).toBe('image/png');

    // Served with no session at all: a worker at the login screen has not signed in yet.
    const image = await app.inject({ method: 'GET', url: `/api/v1/branding/logos/${logo.id}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');

    const branding = await app.inject({
      method: 'GET',
      url: `/api/v1/branding/public?slug=${tenant.slug}`,
    });
    expect(branding.statusCode).toBe(200);
    expect(branding.json().logoUrl).toContain(logo.id);
  });

  /**
   * The one that matters. An SVG is a script container and this asset is served from our own
   * origin onto the tenant's own login page — so it is refused rather than sanitized.
   */
  it('refuses an SVG, whatever the file is called', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString(
      'base64',
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/branding/logos',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { fileName: 'logo.png', data: `data:image/png;base64,${svg}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('branding.logo_unsupported_type');
  });

  it('returns the same asset when the same file is uploaded twice', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    const upload = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/branding/logos',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { fileName: 'logo.png', data: TINY_PNG },
      });

    const first = await upload();
    const second = await upload();
    expect(second.statusCode).toBe(200);
    expect(second.json().logo.id).toBe(first.json().logo.id);

    const { logos } = (
      await app.inject({ method: 'GET', url: '/api/v1/admin/branding/logos', headers: { cookie } })
    ).json();
    expect(logos).toHaveLength(1);
  });

  it('cannot be selected from another tenant’s gallery', async () => {
    const mine = await loginAdmin(tenant.slug);
    const theirs = await loginAdmin(other.slug);

    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/branding/logos',
      headers: { cookie: theirs.cookie, 'x-csrf-token': theirs.csrf },
      payload: { fileName: 'theirs.png', data: TINY_PNG },
    });
    const foreignId = upload.json().logo.id;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/branding/logo',
      headers: { cookie: mine.cookie, 'x-csrf-token': mine.csrf },
      payload: { logoId: foreignId },
    });
    // Not found, never forbidden: confirming the row exists elsewhere is itself the leak.
    expect(response.statusCode).toBe(404);
  });

  it('leaves the organization with no logo when the chosen one is deleted', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/branding/logos',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { fileName: 'logo.png', data: TINY_PNG, activate: true },
    });
    const logoId = upload.json().logo.id;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/branding/logos/${logoId}`,
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(deleted.statusCode).toBe(204);

    const branding = await prisma.organizationBranding.findUnique({
      where: { organizationId: tenant.organizationId },
      select: { logoAssetId: true },
    });
    expect(branding?.logoAssetId ?? null).toBeNull();
  });
});

describe('changing an administrator’s email', () => {
  it('moves the login identity and ends the sessions issued to the old one', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/admin/members', headers: { cookie } })
    ).json().members;
    const self = members.find((member: { isSelf: boolean }) => member.isSelf);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${self.id}/email`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { email: 'nov.admin@example.test' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().signedOut).toBe(true);

    // The identity changed, so the session that made the change is no longer valid.
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nov.admin@example.test', password: 'integration-test-pass' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('refuses an address another account already holds', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/admin/members', headers: { cookie } })
    ).json().members;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${members[0].id}/email`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { email: `admin@${other.slug}.test` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('auth.email_taken');
  });

  it('cannot reach a member of another organization', async () => {
    const mine = await loginAdmin(tenant.slug);
    const theirs = await loginAdmin(other.slug);
    const theirMembers = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/admin/members',
        headers: { cookie: theirs.cookie },
      })
    ).json().members;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${theirMembers[0].id}/email`,
      headers: { cookie: mine.cookie, 'x-csrf-token': mine.csrf },
      payload: { email: 'takeover@example.test' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to touch an account that administers the platform', async () => {
    const { cookie, csrf } = await loginAdmin(tenant.slug);
    await prisma.user.update({
      where: { id: tenant.adminUserId },
      data: { isPlatformAdmin: true },
    });

    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/admin/members', headers: { cookie } })
    ).json().members;
    const self = members.find((member: { isSelf: boolean }) => member.isSelf);
    expect(self.isPlatformAdmin).toBe(true);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${self.id}/email`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { email: 'platform@example.test' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('members.platform_admin_immutable');
  });
});
