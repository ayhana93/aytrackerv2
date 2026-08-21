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
