import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildAppConfig, type ServerEnv } from '@aytracker/config';
import { buildApp } from '@aytracker/api/app';
import { buildServices } from '@aytracker/api/services/container';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@aytracker/auth';
import { randomUUID } from 'node:crypto';
import {
  createTestTenant,
  disconnectTestClient,
  getTestClient,
  resetDatabase,
  seedPlatformReferenceData,
  testDatabaseUrl,
  type TestTenant,
} from '../helpers/database.js';

/**
 * HTTP-level security tests.
 *
 * The specification's checklist, exercised through the real API surface rather than by calling
 * services directly — because the guarantees are supposed to hold for anything that can send a
 * request, not only for callers that go through the happy path.
 *
 *   Worker cannot access admin endpoints.
 *   Driver cannot access another driver's trips.
 *   Unauthenticated requests cannot reach protected resources.
 *   Expired sessions cannot access protected resources.
 *   A missing CSRF token blocks a mutation.
 *   An idempotent replay does not execute twice.
 */

const prisma = getTestClient();

let app: FastifyInstance;
let tenant: TestTenant;

function testEnv(): ServerEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    APP_URL: 'http://localhost:3000',
    API_URL: 'http://localhost:3001',
    API_PORT: 3001,
    CORS_ALLOWED_ORIGINS: ['http://localhost:3000'],
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    SESSION_TTL_ADMIN_MINUTES: 720,
    SESSION_TTL_WORKER_MINUTES: 960,
    SESSION_TTL_DRIVER_MINUTES: 960,
    DEFAULT_MARKET: 'GLOBAL',
    DEFAULT_LOCALE: 'en',
    MARKET_GEOLOCATION_PROVIDER: 'none',
    BILLING_PROVIDER: 'noop',
    VAT_VALIDATION_PROVIDER: 'none',
    ROUTING_PROVIDER: 'haversine',
    LOCATION_RETENTION_DAYS: 180,
    TRIP_SUMMARY_RETENTION_DAYS: 1825,
    AUDIT_RETENTION_DAYS: 2555,
    LOG_LEVEL: 'fatal',
    // Rate limiting off: these tests fire many requests from one "IP" and are not testing it.
    RATE_LIMIT_ENABLED: false,
  } as ServerEnv;
}

/** Grants every feature so entitlement gates do not mask an authorization result. */
async function grantAllFeatures(organizationId: string): Promise<void> {
  const features = await prisma.feature.findMany({ select: { id: true } });
  if (features.length === 0) return;
  await prisma.organizationEntitlement.createMany({
    data: features.map((feature) => ({
      organizationId,
      featureId: feature.id,
      isEnabled: true,
      source: 'PLAN' as const,
    })),
    skipDuplicates: true,
  });
}

async function seedFeatures(): Promise<void> {
  const { FEATURE_DEFINITIONS } = await import('@aytracker/billing');
  for (const feature of FEATURE_DEFINITIONS) {
    await prisma.feature.upsert({
      where: { code: feature.code },
      update: {},
      create: { code: feature.code, name: feature.name, moduleCode: feature.moduleCode },
    });
  }
}

interface LoggedIn {
  readonly cookies: string;
  readonly csrfToken: string;
}

function collectCookies(setCookie: string | string[] | undefined): LoggedIn {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const jar = new Map<string, string>();
  for (const header of headers) {
    const [pair] = header.split(';');
    const [name, ...rest] = (pair ?? '').split('=');
    if (name) jar.set(name.trim(), rest.join('='));
  }
  return {
    cookies: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrfToken: jar.get(CSRF_COOKIE_NAME) ?? '',
  };
}

async function loginWorker(employeeNumber = '1001'): Promise<LoggedIn> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/worker/login',
    payload: { organizationSlug: tenant.slug, employeeNumber, pin: '482913' },
  });
  expect(response.statusCode).toBe(200);
  return collectCookies(response.headers['set-cookie']);
}

async function loginDriver(driverCode = 'D001'): Promise<LoggedIn> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/driver/login',
    payload: { organizationSlug: tenant.slug, driverCode, pin: '482913' },
  });
  expect(response.statusCode).toBe(200);
  return collectCookies(response.headers['set-cookie']);
}

beforeAll(async () => {
  await seedPlatformReferenceData();
  const config = buildAppConfig(testEnv());
  const services = buildServices(config);
  app = await buildApp(config, services);
  await app.ready();
});

afterAll(async () => {
  // Guarded: if beforeAll failed (no database, say), `app` is undefined and an unguarded close
  // would replace the real error with a confusing TypeError.
  await app?.close();
  await disconnectTestClient();
});

beforeEach(async () => {
  await resetDatabase();
  await seedPlatformReferenceData();
  await seedFeatures();
  tenant = await createTestTenant('tenant-api');
  await grantAllFeatures(tenant.organizationId);
});

describe('authentication', () => {
  it('logs a worker in and sets an HTTP-only session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/worker/login',
      payload: { organizationSlug: tenant.slug, employeeNumber: '1001', pin: '482913' },
    });

    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
    const sessionCookie = headers.find((header) => header.startsWith(SESSION_COOKIE_NAME));
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);

    // The token is never in the body — a token in JSON ends up in localStorage.
    expect(response.json()).not.toHaveProperty('token');
  });

  it('refuses a wrong PIN with a generic error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/worker/login',
      payload: { organizationSlug: tenant.slug, employeeNumber: '1001', pin: '999999' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('auth.invalid_credentials');
  });

  /**
   * An unknown employee number must be indistinguishable from a wrong PIN, or the login form
   * becomes an employee-directory oracle.
   */
  it('gives the same answer for an unknown employee number', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/worker/login',
      payload: { organizationSlug: tenant.slug, employeeNumber: '9999', pin: '482913' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('auth.invalid_credentials');
  });

  it('does not let a worker log in against another organization’s slug', async () => {
    const other = await createTestTenant('tenant-other');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/worker/login',
      payload: { organizationSlug: other.slug, employeeNumber: '1001', pin: '482913' },
    });
    // The other tenant has its own worker 1001 with the same PIN; the session that comes back
    // must belong to that tenant, never to the first one.
    const cookies = collectCookies(response.headers['set-cookie']);
    const state = await app.inject({
      method: 'GET',
      url: '/api/v1/worker/state',
      headers: { cookie: cookies.cookies },
    });
    expect(state.json().worker.id).toBe(other.workerId);
    expect(state.json().worker.id).not.toBe(tenant.workerId);
  });

  it('locks a worker out after repeated wrong PINs', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/worker/login',
        payload: { organizationSlug: tenant.slug, employeeNumber: '1001', pin: '111112' },
      });
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/worker/login',
      payload: { organizationSlug: tenant.slug, employeeNumber: '1001', pin: '482913' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('auth.account_locked');
  });
});

describe('unauthenticated access', () => {
  it('refuses the worker portal', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/worker/state' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses the driver portal', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/driver/state' });
    expect(response.statusCode).toBe(401);
  });

  it('allows the public pricing endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/market' });
    expect(response.statusCode).toBe(200);
    // An anonymous visitor's market is explicitly not authoritative for tax.
    expect(response.json().isTaxAuthoritative).toBe(false);
  });
});

describe('a worker cannot reach the driver portal', () => {
  /**
   * The driver routes are gated on driving context, not on actor type.
   *
   * They used to require `actorType === 'DRIVER'`, but a worker who takes a driving position keeps
   * their existing session and has `driverId` plus the `driver.*` permissions written onto it for
   * as long as the driving session is open — so an actor-type gate would lock out the very flow
   * the handoff exists to serve. What the gate now demands is the thing that actually matters:
   * a resolved driver identity on the session, which only the server can put there.
   *
   * A worker who has not begun driving has neither, so the portal stays shut. That is the property
   * under test here; the positive half — that the same worker gets in once the server has opened a
   * driving session for them — lives in driving-handoff.test.ts.
   */
  it('refuses a worker session that has no open driving session', async () => {
    const worker = await loginWorker();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/state',
      headers: { cookie: worker.cookies },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('auth.permission_denied');
  });

  it('refuses a worker who asks for a driver route with a forged driver id', async () => {
    const worker = await loginWorker();
    // Driver identity is never read from the request. Supplying one changes nothing.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/state',
      headers: { cookie: worker.cookies, 'x-driver-id': 'driver-1' },
      query: { driverId: 'driver-1' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('a driver cannot read another driver’s trips', () => {
  it('reports another driver’s trip as not found', async () => {
    const otherTrip = await prisma.driverTrip.create({
      data: {
        organizationId: tenant.organizationId,
        driverId: tenant.otherDriverId,
        vehicleId: (
          await prisma.vehicle.findFirstOrThrow({
            where: { organizationId: tenant.organizationId, registrationNumber: 'TENANT-API-002' },
          })
        ).id,
        status: 'ACTIVE',
        startedAt: new Date(),
      },
    });

    const driver = await loginDriver('D001');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/driver/trips/${otherTrip.id}`,
      headers: { cookie: driver.cookies },
    });

    // 404 rather than 403: confirming the id exists would itself leak information.
    expect(response.statusCode).toBe(404);
  });

  it('lists only the caller’s own trips', async () => {
    const vehicle = await prisma.vehicle.findFirstOrThrow({
      where: { organizationId: tenant.organizationId, registrationNumber: 'TENANT-API-002' },
    });
    await prisma.driverTrip.create({
      data: {
        organizationId: tenant.organizationId,
        driverId: tenant.otherDriverId,
        vehicleId: vehicle.id,
        status: 'COMPLETED',
        startedAt: new Date(Date.now() - 3600_000),
        endedAt: new Date(),
      },
    });

    const driver = await loginDriver('D001');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/trips',
      headers: { cookie: driver.cookies },
    });
    expect(response.json().trips).toHaveLength(0);
  });
});

describe('CSRF', () => {
  it('refuses a mutation without the CSRF header', async () => {
    const worker = await loginWorker();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers: { cookie: worker.cookies },
      payload: {
        clientActionId: randomUUID(),
        siteId: tenant.siteId,
        initialPositionId: tenant.positionIds.machine1,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('auth.csrf_failed');
  });

  it('accepts a mutation with a matching CSRF header', async () => {
    const worker = await loginWorker();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers: { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken },
      payload: {
        clientActionId: randomUUID(),
        siteId: tenant.siteId,
        initialPositionId: tenant.positionIds.machine1,
      },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('expired and revoked sessions', () => {
  it('refuses an expired session', async () => {
    const worker = await loginWorker();
    await prisma.session.updateMany({
      where: { workerId: tenant.workerId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/worker/state',
      headers: { cookie: worker.cookies },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a revoked session', async () => {
    const worker = await loginWorker();
    await prisma.session.updateMany({
      where: { workerId: tenant.workerId },
      data: { revokedAt: new Date(), revokedReason: 'test' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/worker/state',
      headers: { cookie: worker.cookies },
    });
    expect(response.statusCode).toBe(401);
  });

  it('logout revokes the session', async () => {
    const worker = await loginWorker();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/worker/state',
      headers: { cookie: worker.cookies },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('idempotency', () => {
  it('replays the stored response instead of starting a second shift', async () => {
    const worker = await loginWorker();
    const clientActionId = randomUUID();
    const payload = {
      clientActionId,
      siteId: tenant.siteId,
      initialPositionId: tenant.positionIds.machine1,
    };
    const headers = { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers,
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await prisma.shift.count({ where: { workerId: tenant.workerId } })).toBe(1);
  });

  /** A reused key with a different body is a client bug, not a replay — it must not silently pass. */
  it('rejects a reused idempotency key carrying a different request', async () => {
    const worker = await loginWorker();
    const clientActionId = randomUUID();
    const headers = { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken };

    await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers,
      payload: {
        clientActionId,
        siteId: tenant.siteId,
        initialPositionId: tenant.positionIds.machine1,
      },
    });

    const conflicting = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers,
      payload: {
        clientActionId,
        siteId: tenant.siteId,
        initialPositionId: tenant.positionIds.packaging,
      },
    });

    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().error.code).toBe('idempotency.key_reused');
  });

  it('releases the claim when the command fails, so a retry can succeed', async () => {
    const worker = await loginWorker();
    const headers = { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken };
    const clientActionId = randomUUID();

    // Fails: the worker holds no cutting qualification.
    const failed = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers,
      payload: {
        clientActionId,
        siteId: tenant.siteId,
        initialPositionId: tenant.positionIds.restricted,
      },
    });
    expect(failed.statusCode).toBe(403);

    // The same key is usable again, because the failure released the claim.
    const retried = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers,
      payload: {
        clientActionId,
        siteId: tenant.siteId,
        initialPositionId: tenant.positionIds.machine1,
      },
    });
    expect(retried.statusCode).toBe(200);
  });
});

describe('worker position picker', () => {
  it('never sends a position the worker may not occupy', async () => {
    const worker = await loginWorker();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/worker/state',
      headers: { cookie: worker.cookies },
    });

    const offered = response
      .json()
      .availablePositions.map((entry: { positionId: string }) => entry.positionId);
    expect(offered).toContain(tenant.positionIds.machine1);
    expect(offered).toContain(tenant.positionIds.packaging);
    expect(offered).not.toContain(tenant.positionIds.restricted);
  });

  it('refuses a position change to an ineligible position even when asked directly', async () => {
    const worker = await loginWorker();
    const headers = { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken };

    await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers,
      payload: {
        clientActionId: randomUUID(),
        siteId: tenant.siteId,
        initialPositionId: tenant.positionIds.machine1,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/position/change',
      headers,
      payload: { clientActionId: randomUUID(), positionId: tenant.positionIds.restricted },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('position.qualification_required');
  });
});
