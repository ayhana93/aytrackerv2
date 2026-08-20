import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@aytracker/api/app';
import { buildServices } from '@aytracker/api/services/container';
import { buildAppConfig, parseServerEnv } from '@aytracker/config';
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
 * Signup, structure and history over HTTP.
 *
 * The property under test throughout is the same one the rest of the admin API is held to: an
 * organization sees its own rows and nothing else, and it finds out about another tenant's rows
 * by being told they do not exist. Registration raises the stakes on that, because it is the one
 * endpoint an unauthenticated stranger can use to put a row in the database.
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
  tenant = await createTestTenant('structure-a');
  other = await createTestTenant('structure-b');
});

function cookiesFrom(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  return values.map((value) => value.split(';')[0]).join('; ');
}

interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

function sessionFrom(header: string | string[] | undefined): Session {
  const cookie = cookiesFrom(header);
  return { cookie, csrf: /ay_csrf=([^;]+)/.exec(cookie)?.[1] ?? '' };
}

async function loginAdmin(slug: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `admin@${slug}.test`, password: 'integration-test-pass' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return sessionFrom(response.headers['set-cookie']);
}

function authed(session: Session) {
  return {
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
}

async function register(payload: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/register', payload });
}

const VALID_SIGNUP = {
  companyName: 'Метал Инвест',
  firstName: 'Иван',
  lastName: 'Петров',
  email: 'ivan@metal-invest.example',
  password: 'a-long-enough-password',
};

describe('registration', () => {
  it('creates a usable tenant and signs the owner in', async () => {
    const response = await register(VALID_SIGNUP);
    expect(response.statusCode, response.body).toBe(201);

    const body = response.json();
    expect(body.actorType).toBe('USER');
    // Cyrillic transliterated rather than stripped. Stripping would leave an empty string, and
    // every Bulgarian company would end up as org-2, org-3, org-4.
    expect(body.organizationSlug).toBe('metal-invest');

    const session = sessionFrom(response.headers['set-cookie']);
    expect(session.cookie).toContain('ay_session=');

    // The session works immediately — the point of signing them in rather than bouncing them to
    // a login form for a password they invented thirty milliseconds ago.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: session.cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().organizationSlug).toBe('metal-invest');
  });

  it('gives the new organization a site and a work area to start from', async () => {
    const response = await register(VALID_SIGNUP);
    const session = sessionFrom(response.headers['set-cookie']);

    // Without these, the first screen after signup is a dead end: a position needs a work area,
    // and a work area needs a site.
    const areas = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/areas',
      headers: { cookie: session.cookie },
    });
    expect(areas.statusCode, areas.body).toBe(200);
    expect(areas.json().areas).toHaveLength(1);
  });

  it('grants the trial entitlements, so the product is not dark on day one', async () => {
    const response = await register(VALID_SIGNUP);
    const session = sessionFrom(response.headers['set-cookie']);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: session.cookie },
    });
    expect(me.json().features.length).toBeGreaterThan(0);
  });

  it('refuses an email that is already registered', async () => {
    await register(VALID_SIGNUP);
    const second = await register({ ...VALID_SIGNUP, companyName: 'Друга Фирма' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('auth.email_taken');
  });

  it('refuses a password under the length floor', async () => {
    const response = await register({ ...VALID_SIGNUP, password: 'short' });
    expect(response.statusCode).toBe(400);
    // And nothing was created on the way to rejecting it.
    expect(await prisma.user.count({ where: { email: VALID_SIGNUP.email } })).toBe(0);
  });

  it('does not hand two organizations the same slug', async () => {
    const first = await register(VALID_SIGNUP);
    const second = await register({ ...VALID_SIGNUP, email: 'other@example.test' });

    expect(second.statusCode).toBe(201);
    expect(second.json().organizationSlug).not.toBe(first.json().organizationSlug);
  });

  it('starts empty — a brand new tenant cannot see anybody else', async () => {
    // The whole point of the endpoint being open to strangers: whatever they create, it must not
    // be a window into the tenants already in the database.
    const response = await register(VALID_SIGNUP);
    const session = sessionFrom(response.headers['set-cookie']);

    const history = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/history',
      headers: { cookie: session.cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().sessions).toEqual([]);
    expect(history.json().byWorker).toEqual([]);

    const areas = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/areas',
      headers: { cookie: session.cookie },
    });
    // Its own starter area, and none of the two seeded tenants' areas.
    const names = areas.json().areas.map((area: { name: string }) => area.name);
    expect(names).not.toContain('Line');
  });
});

describe('work areas and positions', () => {
  it('creates an area and a position inside it, deriving both codes', async () => {
    const session = await loginAdmin('structure-a');

    const area = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/areas',
      headers: authed(session),
      payload: { name: 'Цех Боядисване' },
    });
    expect(area.statusCode, area.body).toBe(201);
    // Derived from the Bulgarian name without the caller inventing one: "Цех Боядисване" →
    // TSEH + BOYADISVANE, capped at twelve characters because this ends up on a sign and in a
    // dropdown next to twenty others.
    expect(area.json().area.code).toBe('TSEHBOYADISV');

    const position = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/positions',
      headers: authed(session),
      payload: { workAreaId: area.json().area.id, name: 'Кабина 1', kind: 'STANDARD' },
    });
    expect(position.statusCode, position.body).toBe(201);

    const tree = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/areas',
      headers: { cookie: session.cookie },
    });
    const created = tree.json().areas.find((row: { id: string }) => row.id === area.json().area.id);
    expect(created.positions).toHaveLength(1);
    expect(created.positions[0].name).toBe('Кабина 1');
  });

  it('keeps codes unique within an organization', async () => {
    const session = await loginAdmin('structure-a');

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/areas',
      headers: authed(session),
      payload: { name: 'Склад' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/areas',
      headers: authed(session),
      payload: { name: 'Склад' },
    });

    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().area.code).not.toBe(first.json().area.code);
  });

  it('reports live occupancy, not just configuration', async () => {
    const session = await loginAdmin('structure-a');
    await openSession(tenant, tenant.positionIds.machine1, new Date());

    const tree = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/areas',
      headers: { cookie: session.cookie },
    });
    const positions = tree.json().areas.flatMap((area: { positions: unknown[] }) => area.positions);
    const machine1 = positions.find(
      (position: { id: string }) => position.id === tenant.positionIds.machine1,
    );
    expect(machine1.occupied).toBe(1);
  });

  it('will not archive a position somebody is standing on', async () => {
    const session = await loginAdmin('structure-a');
    await openSession(tenant, tenant.positionIds.machine1, new Date());

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/positions/${tenant.positionIds.machine1}`,
      headers: authed(session),
      payload: { status: 'ARCHIVED' },
    });
    // Archiving it would pull the position out from under a live session and leave a shift that
    // cannot be closed against anything.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('position.occupied');
  });

  it('does not show, or let anyone edit, another tenant’s structure', async () => {
    const session = await loginAdmin('structure-a');

    const tree = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/areas',
      headers: { cookie: session.cookie },
    });
    const ids = tree.json().areas.map((area: { id: string }) => area.id);
    expect(ids).not.toContain(other.workAreaId);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/areas/${other.workAreaId}`,
      headers: authed(session),
      payload: { name: 'Owned' },
    });
    // 404, never 403: a 403 would confirm the row exists, which is the leak.
    expect(patch.statusCode).toBe(404);

    const position = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/positions',
      headers: authed(session),
      payload: { workAreaId: other.workAreaId, name: 'Planted', kind: 'STANDARD' },
    });
    expect(position.statusCode).toBe(404);
    // And nothing landed in the other tenant on the way to that 404.
    expect(
      await prisma.position.count({
        where: { organizationId: other.organizationId, name: 'Planted' },
      }),
    ).toBe(0);
  });
});

describe('work history', () => {
  it('reports who worked where, and totals them per person', async () => {
    const session = await loginAdmin('structure-a');
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await openSession(tenant, tenant.positionIds.machine1, startedAt, 3600);
    await openSession(tenant, tenant.positionIds.packaging, startedAt, 1800);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/history',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);

    const body = response.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.byWorker).toHaveLength(1);
    // 3600 + 1800, added up by the server rather than by the browser.
    expect(body.byWorker[0].seconds).toBe(5400);
    expect(body.sessions[0].workArea).toBe('Line');
  });

  it('counts an open session up to now instead of ignoring it', async () => {
    const session = await loginAdmin('structure-a');
    await openSession(tenant, tenant.positionIds.machine1, new Date(Date.now() - 2 * 3600 * 1000));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/history',
      headers: { cookie: session.cookie },
    });
    const body = response.json();

    // A worker who has been on the line since 06:00 must not read as having worked nothing.
    expect(body.sessions[0].isOpen).toBe(true);
    expect(body.sessions[0].seconds).toBeGreaterThan(7000);
    expect(body.byWorker[0].open).toBe(true);
  });

  it('totals the whole range even when the list is capped', async () => {
    const session = await loginAdmin('structure-a');
    const base = Date.now() - 6 * 60 * 60 * 1000;
    for (let index = 0; index < 5; index += 1) {
      await openSession(tenant, tenant.positionIds.machine1, new Date(base + index * 60_000), 600);
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/history?limit=2',
      headers: { cookie: session.cookie },
    });
    const body = response.json();

    expect(body.sessions).toHaveLength(2);
    // The roll-up is the figure someone checks a payslip against, so it covers all five rows
    // rather than the two that fitted on the page.
    expect(body.byWorker[0].seconds).toBe(3000);
    expect(body.truncated).toBe(true);
  });

  it('never reports another tenant’s hours', async () => {
    const session = await loginAdmin('structure-a');
    await openSession(other, other.positionIds.machine1, new Date(), 3600);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/history',
      headers: { cookie: session.cookie },
    });
    expect(response.json().sessions).toEqual([]);
    expect(response.json().byWorker).toEqual([]);
  });
});

/** A position session on an open shift, closed only when `durationSeconds` is supplied. */
async function openSession(
  target: TestTenant,
  positionId: string,
  startedAt: Date,
  durationSeconds?: number,
): Promise<void> {
  const shift = await prisma.shift.create({
    data: {
      organizationId: target.organizationId,
      siteId: target.siteId,
      workerId: target.workerId,
      status: durationSeconds === undefined ? 'ACTIVE' : 'COMPLETED',
      actualStart: startedAt,
      ...(durationSeconds === undefined
        ? {}
        : { actualEnd: new Date(startedAt.getTime() + durationSeconds * 1000) }),
    },
  });

  await prisma.positionSession.create({
    data: {
      organizationId: target.organizationId,
      shiftId: shift.id,
      workerId: target.workerId,
      positionId,
      startedAt,
      ...(durationSeconds === undefined
        ? {}
        : {
            endedAt: new Date(startedAt.getTime() + durationSeconds * 1000),
            durationSeconds,
          }),
    },
  });
}
