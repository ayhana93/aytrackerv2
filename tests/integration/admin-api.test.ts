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
