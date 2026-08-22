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

async function loginAdmin(slug: string = tenant.slug): Promise<LoggedIn> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `admin@${slug}.test`, password: 'integration-test-pass' },
  });
  expect(response.statusCode, response.body).toBe(200);
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

  /**
   * The test the suite was missing, and the outage it would have caught.
   *
   * Every case above reads the token out of the `Set-Cookie` header, which is what a browser can
   * do only when the API and the web app share a site. Deployed with the two on separate hosts —
   * which is how this product runs on Railway — the browser still *sends* `ay_csrf` but the web
   * app's JavaScript cannot *read* it, so no header was ever attached and the server refused
   * every mutation with `auth.csrf_failed`. Reads worked, login worked, and the interface said
   * "Нямате достъп до тези данни" for an owner with every permission there is.
   *
   * So this case is deliberately hobbled the way that browser is: it may send the cookies, and it
   * may read only what the API puts in a response body.
   */
  it('gives a cross-site client a token it can actually use', async () => {
    const worker = await loginWorker();

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: worker.cookies },
    });
    expect(me.statusCode, me.body).toBe(200);
    const token = me.json().csrfToken;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers: { cookie: worker.cookies, 'x-csrf-token': token },
      payload: {
        clientActionId: randomUUID(),
        siteId: tenant.siteId,
        initialPositionId: tenant.positionIds.machine1,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it('does not rotate the token out from under a second tab', async () => {
    // Two calls to /auth/me must agree. Minting a fresh token on each one would mean a tab that
    // loaded a minute ago holds a value the server no longer accepts.
    const worker = await loginWorker();
    const read = async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { cookie: worker.cookies },
        })
      ).json().csrfToken;

    expect(await read()).toBe(await read());
  });

  it('still refuses a token that does not match the cookie', async () => {
    // The whole point survives: handing the value to its owner is not the same as accepting any
    // value. An attacker who cannot read the response cannot guess this.
    const worker = await loginWorker();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers: { cookie: worker.cookies, 'x-csrf-token': 'not-the-token' },
      payload: {
        clientActionId: randomUUID(),
        siteId: tenant.siteId,
        initialPositionId: tenant.positionIds.machine1,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('auth.csrf_failed');
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

    const offered = response.json().availablePositions.map((entry: { id: string }) => entry.id);
    expect(offered).toContain(tenant.positionIds.machine1);
    expect(offered).toContain(tenant.positionIds.packaging);
    expect(offered).not.toContain(tenant.positionIds.restricted);
  });

  /**
   * The picker has to be renderable from this response alone.
   *
   * It used to carry ids and nothing else, which is why the worker portal shipped with a
   * hardcoded list of five invented positions: there was no name to show. A picker that needs
   * the client to supply its own labels is a picker that will eventually show somebody else's.
   */
  it('names every position it offers, and says which area it is in', async () => {
    const worker = await loginWorker();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/worker/state',
      headers: { cookie: worker.cookies },
    });

    const body = response.json();
    expect(body.availablePositions.length).toBeGreaterThan(0);
    for (const position of body.availablePositions) {
      expect(typeof position.name).toBe('string');
      expect(position.name.length).toBeGreaterThan(0);
      expect(position.kind === 'STANDARD' || position.kind === 'DRIVING').toBe(true);
      expect(position).toHaveProperty('workArea');
    }
  });

  /**
   * Elapsed time is measured against the server's clock, not the device's.
   *
   * Without this field the portal had to anchor its timer to `Date.now()`, and a tablet whose
   * clock was hours out rendered a shift that started a minute ago as hours long.
   */
  it('sends the server time so the portal never times a shift by the device clock', async () => {
    const worker = await loginWorker();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/worker/state',
      headers: { cookie: worker.cookies },
    });

    const serverTime = response.json().serverTime;
    expect(typeof serverTime).toBe('string');
    expect(Number.isNaN(Date.parse(serverTime))).toBe(false);
  });

  /**
   * A phone knows which factory its owner walked into; it does not know the site's UUID.
   *
   * `siteId` used to be required, which meant the one screen that has only a session could not
   * call this endpoint at all.
   */
  it('starts a shift without being told which site, resolving it from the worker', async () => {
    const worker = await loginWorker();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers: { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken },
      payload: { clientActionId: randomUUID() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().shiftId).toBeTruthy();

    const state = await app.inject({
      method: 'GET',
      url: '/api/v1/worker/state',
      headers: { cookie: worker.cookies },
    });
    expect(state.json().shift.actualStart).toBeTruthy();
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

/**
 * A driver cannot stop the recording of a trip that is running.
 *
 * This is the rule the whole driver portal is built around, so it is tested at the HTTP edge
 * rather than trusted to the absence of a button. A pause control let a driver switch the record
 * off, drive a hundred kilometres, and switch it back on — leaving fuel burned against no trip
 * and a straight line drawn through the middle of the route.
 */
describe('a trip records from start to finish', () => {
  async function startTrip(driver: LoggedIn, payload: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/driver/trip/start',
      headers: { cookie: driver.cookies, 'x-csrf-token': driver.csrfToken },
      payload: { clientActionId: randomUUID(), ...payload },
    });
  }

  it('has no pause endpoint at all', async () => {
    const driver = await loginDriver('D001');
    const started = await startTrip(driver);
    expect(started.statusCode).toBe(200);
    const tripId = started.json().tripId;

    const paused = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/trip/${tripId}/pause`,
      headers: { cookie: driver.cookies, 'x-csrf-token': driver.csrfToken },
      payload: { clientActionId: randomUUID() },
    });
    expect(paused.statusCode).toBe(404);

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/trip/${tripId}/resume`,
      headers: { cookie: driver.cookies, 'x-csrf-token': driver.csrfToken },
      payload: { clientActionId: randomUUID() },
    });
    expect(resumed.statusCode).toBe(404);
  });

  it('does not grant a driver session the permission to pause one', async () => {
    const driver = await loginDriver('D001');
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: driver.cookies },
    });
    expect(session.json().permissions).not.toContain('driver.trip.pause');
  });

  it('starts a trip with no route at all', async () => {
    const driver = await loginDriver('D001');
    const started = await startTrip(driver);
    expect(started.statusCode).toBe(200);

    const state = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/state',
      headers: { cookie: driver.cookies },
    });
    expect(state.json().trip.label).toBeNull();
    expect(state.json().trip.plannedDistanceMeters).toBeNull();
  });

  it('records a route and its planned distance when one is given', async () => {
    const driver = await loginDriver('D001');
    const started = await startTrip(driver, {
      label: 'София → Пловдив',
      plannedDistanceKm: 145,
    });
    expect(started.statusCode).toBe(200);

    const state = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/state',
      headers: { cookie: driver.cookies },
    });
    expect(state.json().trip.label).toBe('София → Пловдив');
    // Kilometres in, metres out. The domain stores metres; the driver typed kilometres.
    expect(state.json().trip.plannedDistanceMeters).toBe(145_000);
  });

  it('refuses a planned distance with no route to attach it to', async () => {
    const driver = await loginDriver('D001');
    const started = await startTrip(driver, { plannedDistanceKm: 145 });
    expect(started.statusCode).toBe(400);
  });

  /**
   * A driver who holds no vehicle picks one, and gives it back when the trip ends.
   *
   * Without this a driver who logs in directly — rather than arriving through the worker
   * handoff — had no way to get a vehicle at all, and every trip start failed with
   * `trip.no_vehicle_assigned` on a fleet with free vans standing in it.
   */
  it('lets a driver take a free vehicle for a trip and releases it at the end', async () => {
    const driver = await loginDriver('D002');

    // D002 holds a manual assignment in the fixture. Ending it puts them in the position of a
    // driver who arrives with nothing.
    await prisma.vehicleAssignment.updateMany({
      where: { organizationId: tenant.organizationId, driverId: tenant.otherDriverId },
      data: { endedAt: new Date() },
    });

    const offered = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/vehicles',
      headers: { cookie: driver.cookies },
    });
    expect(offered.statusCode).toBe(200);
    const ids = offered.json().vehicles.map((vehicle: { id: string }) => vehicle.id);
    expect(ids).toContain(tenant.freeVehicleId);
    // Held by D001 under a manual assignment, so it is never offered to anybody else.
    expect(ids).not.toContain(tenant.vehicleId);

    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/trip/start',
      headers: { cookie: driver.cookies, 'x-csrf-token': driver.csrfToken },
      payload: { clientActionId: randomUUID(), vehicleId: tenant.freeVehicleId },
    });
    expect(started.statusCode).toBe(200);

    const claimed = await prisma.vehicleAssignment.findFirst({
      where: {
        organizationId: tenant.organizationId,
        vehicleId: tenant.freeVehicleId,
        endedAt: null,
      },
      select: { driverId: true, isAutomatic: true },
    });
    expect(claimed?.driverId).toBe(tenant.otherDriverId);
    // Automatic, which is what makes it safe to hand back. A manual assignment never is.
    expect(claimed?.isAutomatic).toBe(true);

    const ended = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/trip/${started.json().tripId}/end`,
      headers: { cookie: driver.cookies, 'x-csrf-token': driver.csrfToken },
      payload: { clientActionId: randomUUID() },
    });
    expect(ended.statusCode).toBe(200);

    const stillHeld = await prisma.vehicleAssignment.findFirst({
      where: {
        organizationId: tenant.organizationId,
        vehicleId: tenant.freeVehicleId,
        endedAt: null,
      },
    });
    expect(stillHeld).toBeNull();
  });

  it('never offers a vehicle another driver is holding', async () => {
    const driver = await loginDriver('D002');
    const offered = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/vehicles',
      headers: { cookie: driver.cookies },
    });
    const ids = offered.json().vehicles.map((vehicle: { id: string }) => vehicle.id);
    expect(ids).not.toContain(tenant.vehicleId);
  });

  /**
   * The driver's screen shows what the server computed, including the fuel estimate.
   *
   * Litres come from the vehicle's recorded consumption; the cost additionally needs a price
   * from settings. Neither is ever invented, so both halves are checked separately.
   */
  it('estimates fuel from the vehicle and the organization price, and nothing else', async () => {
    const driver = await loginDriver('D001');
    const started = await startTrip(driver);

    // 100 km covered. Set directly because this test is about the arithmetic on top of the
    // distance, not about ingestion — which `driving-handoff` and the tracking suite cover.
    await prisma.driverTrip.update({
      where: { id: started.json().tripId },
      data: { distanceMeters: 100_000 },
    });

    const withoutPrice = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/state',
      headers: { cookie: driver.cookies },
    });
    // The fixture vehicle records 8.4 L/100 km, so litres are knowable with no price at all.
    expect(withoutPrice.json().fuel.liters).toBeCloseTo(8.4, 3);
    expect(withoutPrice.json().fuel.cost).toBeNull();

    await prisma.organizationSettings.upsert({
      where: { organizationId: tenant.organizationId },
      create: { organizationId: tenant.organizationId, fuelPricePerLiter: '2.4500' },
      update: { fuelPricePerLiter: '2.4500' },
    });

    const withPrice = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/state',
      headers: { cookie: driver.cookies },
    });
    // 8.4 L at 2.45 = 20.58. Exact, as a decimal string — the price keeps its own precision
    // until the multiplication is done, and the result is rounded once.
    expect(withPrice.json().fuel.cost).toBe('20.58');
  });

  /**
   * A three-decimal pump price is the ordinary case, not an edge one.
   *
   * `money()` caps a euro amount at two decimals, so passing the unit price through it first
   * threw `money.excess_precision` outright — which would have made every fuel figure on a
   * realistically-priced fleet a 500.
   */
  it('costs a trip at a pump price with more decimals than the currency has', async () => {
    const driver = await loginDriver('D001');
    const started = await startTrip(driver);
    await prisma.driverTrip.update({
      where: { id: started.json().tripId },
      data: { distanceMeters: 100_000 },
    });
    await prisma.organizationSettings.upsert({
      where: { organizationId: tenant.organizationId },
      create: { organizationId: tenant.organizationId, fuelPricePerLiter: '1.7590' },
      update: { fuelPricePerLiter: '1.7590' },
    });

    const state = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/state',
      headers: { cookie: driver.cookies },
    });
    expect(state.statusCode).toBe(200);
    // 8.4 L at 1.759 = 14.7756, rounded once at the end.
    expect(state.json().fuel.cost).toBe('14.78');
  });

  it('sends the server time so the trip timer never runs off the device clock', async () => {
    const driver = await loginDriver('D001');
    const state = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/state',
      headers: { cookie: driver.cookies },
    });
    expect(Number.isNaN(Date.parse(state.json().serverTime))).toBe(false);
  });
});

/**
 * Option C: one phone, one stream, two contexts.
 *
 * The behaviour this whole design exists for, exercised through the real API rather than by
 * calling services directly:
 *
 *   Start work  → tracking starts
 *   Start trip  → the SAME session keeps running, points begin carrying the trip
 *   End trip    → tracking continues, because the employee is still at work
 *   End work    → tracking stops, and nothing more may be recorded
 *
 * A second GPS pipeline would pass none of this: it would open a second session at the trip, and
 * close tracking when the trip ended.
 */
describe('work tracking, and a driver trip inside it', () => {
  async function startShift(worker: LoggedIn) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/start',
      headers: { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken },
      payload: { clientActionId: randomUUID(), initialPositionId: tenant.positionIds.machine1 },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { shiftId: string; trackingSessionId: string };
  }

  async function postPoints(actor: LoggedIn, count = 3, offsetSeconds = 0) {
    const now = Date.now();
    return app.inject({
      method: 'POST',
      url: '/api/v1/tracking/points',
      headers: { cookie: actor.cookies, 'x-csrf-token': actor.csrfToken },
      payload: {
        clientActionId: randomUUID(),
        deviceReported: 'ONLINE',
        batteryLevel: 0.62,
        points: Array.from({ length: count }, (_, index) => ({
          timestamp: new Date(now - (count - index) * 1000 + offsetSeconds * 1000).toISOString(),
          latitude: 42.6977 + index * 0.001,
          longitude: 23.3219 + index * 0.001,
          accuracyMeters: 8,
          speedMps: 12,
        })),
      },
    });
  }

  it('opens a work session when the shift starts, and refuses points before that', async () => {
    const worker = await loginWorker();

    // No shift, no session, no collection. The privacy rule at the edge.
    const early = await postPoints(worker);
    expect(early.statusCode).toBe(403);
    expect(early.json().error.code).toBe('tracking.no_open_session');

    const { trackingSessionId } = await startShift(worker);
    expect(trackingSessionId).toBeTruthy();

    const accepted = await postPoints(worker);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().accepted).toBe(3);
    expect(accepted.json().state).toBe('ACTIVE');
  });

  it('keeps the same session when a trip starts inside the shift', async () => {
    const worker = await loginWorker();
    const { trackingSessionId } = await startShift(worker);
    await postPoints(worker);

    const begun = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/driving/begin',
      headers: { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken },
      payload: {
        clientActionId: randomUUID(),
        positionId: tenant.positionIds.driving,
        vehicleId: tenant.vehicleId,
        label: 'София → Пловдив',
      },
    });
    expect(begun.statusCode).toBe(200);
    const tripId = begun.json().tripId;

    // One session, not two. A second one would mean the phone reporting into two streams.
    const sessions = await prisma.trackingSession.findMany({
      where: { organizationId: tenant.organizationId, endedAt: null },
      select: { id: true, context: true },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(trackingSessionId);
    expect(sessions[0]?.context).toBe('WORK');

    // Points sent now carry the trip as well — same rows, two attributions.
    const during = await postPoints(worker, 3, 1);
    expect(during.statusCode).toBe(200);

    const tagged = await prisma.locationPoint.count({
      where: { organizationId: tenant.organizationId, tripId },
    });
    expect(tagged).toBeGreaterThan(0);

    const total = await prisma.locationPoint.count({
      where: { organizationId: tenant.organizationId, trackingSessionId },
    });
    // Every point belongs to the one session; the trip-tagged ones are a subset, not a copy.
    expect(total).toBeGreaterThan(tagged);
  });

  it('keeps tracking the employee after their trip ends', async () => {
    const worker = await loginWorker();
    const { trackingSessionId } = await startShift(worker);

    const begun = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/driving/begin',
      headers: { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken },
      payload: {
        clientActionId: randomUUID(),
        positionId: tenant.positionIds.driving,
        vehicleId: tenant.vehicleId,
      },
    });
    const tripId = begun.json().tripId;

    const ended = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/trip/${tripId}/end`,
      headers: { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken },
      payload: { clientActionId: randomUUID() },
    });
    expect(ended.statusCode).toBe(200);
    // The session was the working day's, so the trip did not own it and did not close it.
    expect(ended.json().trackingStopped).toBe(false);

    const session = await prisma.trackingSession.findUnique({
      where: { id: trackingSessionId },
      select: { endedAt: true },
    });
    expect(session?.endedAt).toBeNull();

    // And the phone may still report, because the person is still at work.
    const after = await postPoints(worker);
    expect(after.statusCode).toBe(200);
  });

  it('stops tracking when the shift ends, and refuses everything after', async () => {
    const worker = await loginWorker();
    const { trackingSessionId } = await startShift(worker);
    await postPoints(worker);

    const ended = await app.inject({
      method: 'POST',
      url: '/api/v1/worker/shift/end',
      headers: { cookie: worker.cookies, 'x-csrf-token': worker.csrfToken },
      payload: { clientActionId: randomUUID() },
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().tracking).not.toBeNull();

    const session = await prisma.trackingSession.findUnique({
      where: { id: trackingSessionId },
      select: { endedAt: true, trackingState: true },
    });
    expect(session?.endedAt).not.toBeNull();
    expect(session?.trackingState).toBe('STOPPED');

    const after = await postPoints(worker);
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('tracking.no_open_session');
  });

  /**
   * A driver who signs in at the driver door has no working day, so the trip must open a session
   * of its own — otherwise nothing would authorise their phone to report at all.
   */
  it('gives a driver-only trip a session of its own, and closes it with the trip', async () => {
    const driver = await loginDriver('D001');

    const early = await postPoints(driver);
    expect(early.statusCode).toBe(403);

    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/trip/start',
      headers: { cookie: driver.cookies, 'x-csrf-token': driver.csrfToken },
      payload: { clientActionId: randomUUID() },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().trackingContext).toBe('DRIVER_TRIP');

    const accepted = await postPoints(driver);
    expect(accepted.statusCode).toBe(200);

    const ended = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/trip/${started.json().tripId}/end`,
      headers: { cookie: driver.cookies, 'x-csrf-token': driver.csrfToken },
      payload: { clientActionId: randomUUID() },
    });
    expect(ended.json().trackingStopped).toBe(true);

    const after = await postPoints(driver);
    expect(after.statusCode).toBe(403);
  });

  it('never lets one organization see another’s live tracking', async () => {
    const other = await createTestTenant('tenant-other-live');
    await grantAllFeatures(other.organizationId);
    await prisma.trackingSession.create({
      data: {
        organizationId: other.organizationId,
        context: 'DRIVER_TRIP',
        driverId: other.driverId,
        tripId: (
          await prisma.driverTrip.create({
            data: {
              organizationId: other.organizationId,
              driverId: other.driverId,
              vehicleId: other.vehicleId,
              status: 'ACTIVE',
              startedAt: new Date(),
            },
            select: { id: true },
          })
        ).id,
        startedAt: new Date(),
      },
    });

    const admin = await loginAdmin();
    const live = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/live',
      headers: { cookie: admin.cookies },
    });
    expect(live.statusCode).toBe(200);
    // The other tenant has a live session; this admin must not be able to see it.
    expect(live.json().subjects).toHaveLength(0);
  });

  it('shows the admin who is being tracked, and the day split into segments', async () => {
    const worker = await loginWorker();
    const { trackingSessionId } = await startShift(worker);
    await postPoints(worker, 4);

    const admin = await loginAdmin();
    const live = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/live',
      headers: { cookie: admin.cookies },
    });
    expect(live.statusCode).toBe(200);
    const subject = live.json().subjects[0];
    expect(subject.context).toBe('WORK');
    expect(subject.name).toContain('Test');
    expect(subject.latitude).not.toBeNull();
    // Battery is recorded because it changes the sampling interval, not because a phone has one.
    expect(subject.batteryLevel).toBeCloseTo(0.62, 2);

    const track = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/live/${trackingSessionId}/track`,
      headers: { cookie: admin.cookies },
    });
    expect(track.statusCode).toBe(200);
    expect(track.json().segments[0].context).toBe('WORK');
  });
});
