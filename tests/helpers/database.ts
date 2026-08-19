import { execSync } from 'node:child_process';
// Imported through the database package rather than from `@prisma/client` directly: that
// package is the single place allowed to depend on Prisma, and the tests respect the same rule.
import { PrismaClient } from '@aytracker/database';
import { SYSTEM_ROLE_DEFINITIONS, hashPin, hashPassword } from '@aytracker/auth';

/**
 * Integration-test harness.
 *
 * Runs against a real PostgreSQL database, because the invariants under test — partial unique
 * indexes, composite tenant foreign keys, transaction atomicity — do not exist in a mock. A
 * suite that stubbed the database would pass while the thing it claims to prove was broken.
 *
 * Set TEST_DATABASE_URL to point at a throwaway database. `pnpm db:migrate:deploy` against it
 * once; `resetDatabase()` truncates between tests, which is far faster than re-migrating.
 */

let client: PrismaClient | null = null;

export function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL (or DATABASE_URL) must be set to run integration tests.');
  }
  return url;
}

export function getTestClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
  }
  return client;
}

export async function disconnectTestClient(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

export function applyMigrations(): void {
  execSync('pnpm --filter @aytracker/database migrate:deploy', {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}

/**
 * Truncates every tenant table.
 *
 * `RESTART IDENTITY CASCADE` in one statement so foreign keys never block the reset, and the
 * platform tables (markets, plans, features, system roles) are left alone — they are reference
 * data every test needs and re-seeding them per test would dominate the runtime.
 */
export async function resetDatabase(): Promise<void> {
  const prisma = getTestClient();
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "organizations",
      "users",
      "auth_attempts",
      "roadmap_items"
    RESTART IDENTITY CASCADE
  `);
}

export async function seedPlatformReferenceData(): Promise<void> {
  const prisma = getTestClient();

  await prisma.market.upsert({
    where: { code: 'GLOBAL' },
    update: {},
    create: {
      code: 'GLOBAL',
      name: 'Global',
      countryCodes: [],
      defaultCurrency: 'EUR',
      defaultLocale: 'en',
      defaultTimezone: 'UTC',
      taxScheme: 'NONE',
      priority: 1000,
    },
  });
  await prisma.market.upsert({
    where: { code: 'BG' },
    update: {},
    create: {
      code: 'BG',
      name: 'Bulgaria',
      countryCodes: ['BG'],
      defaultCurrency: 'EUR',
      defaultLocale: 'bg',
      defaultTimezone: 'Europe/Sofia',
      taxScheme: 'EU_VAT',
      priority: 10,
    },
  });

  for (const role of SYSTEM_ROLE_DEFINITIONS) {
    const existing = await prisma.role.findFirst({
      where: { organizationId: null, code: role.code },
    });
    if (!existing) {
      await prisma.role.create({
        data: {
          organizationId: null,
          code: role.code,
          name: role.name,
          description: role.description,
          isSystem: true,
          permissions: [...role.permissions],
        },
      });
    }
  }
}

export interface TestTenant {
  readonly organizationId: string;
  readonly siteId: string;
  readonly workAreaId: string;
  readonly positionIds: { machine1: string; machine2: string; packaging: string; restricted: string };
  readonly qualificationIds: { extrusion: string; cutting: string };
  readonly workerId: string;
  readonly otherWorkerId: string;
  readonly driverId: string;
  readonly otherDriverId: string;
  readonly vehicleId: string;
  readonly adminUserId: string;
  readonly slug: string;
}

/**
 * Builds a complete tenant.
 *
 * Called twice by the isolation tests so there are genuinely two organizations with
 * structurally identical data — which is the only way to prove that a query returns the right
 * one rather than merely returning something.
 */
export async function createTestTenant(slug: string): Promise<TestTenant> {
  const prisma = getTestClient();
  const market = await prisma.market.findUnique({ where: { code: 'BG' } });
  const ownerRole = await prisma.role.findFirst({ where: { organizationId: null, code: 'owner' } });

  const organization = await prisma.organization.create({
    data: {
      slug,
      name: `Test ${slug}`,
      status: 'ACTIVE',
      countryCode: 'BG',
      billingCountry: 'BG',
      marketId: market?.id ?? null,
      defaultLocale: 'bg',
      defaultTimezone: 'Europe/Sofia',
      settings: { create: { requireQualificationByDefault: true } },
    },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: `admin@${slug}.test`,
      passwordHash: await hashPassword('integration-test-pass'),
      firstName: 'Test',
      lastName: 'Admin',
      memberships: ownerRole
        ? {
            create: {
              organizationId: organization.id,
              roleId: ownerRole.id,
              status: 'ACTIVE',
              joinedAt: new Date(),
            },
          }
        : undefined,
    },
  });

  const site = await prisma.site.create({
    data: {
      organizationId: organization.id,
      name: 'Plant',
      code: 'P1',
      timezone: 'Europe/Sofia',
    },
  });

  const workArea = await prisma.workArea.create({
    data: { organizationId: organization.id, siteId: site.id, name: 'Line', code: 'L1' },
  });

  const extrusion = await prisma.qualification.create({
    data: { organizationId: organization.id, name: 'Extrusion', code: 'EXT' },
  });
  const cutting = await prisma.qualification.create({
    data: { organizationId: organization.id, name: 'Cutting', code: 'CUT' },
  });

  const machine1 = await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: workArea.id,
      name: 'Machine 1',
      code: 'M1',
      changeMode: 'QUALIFICATION_REQUIRED',
      qrToken: `${slug}-qr-m1`,
      requiredQualifications: {
        create: [{ organizationId: organization.id, qualificationId: extrusion.id }],
      },
    },
  });
  const machine2 = await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: workArea.id,
      name: 'Machine 2',
      code: 'M2',
      changeMode: 'QUALIFICATION_REQUIRED',
      requiredQualifications: {
        create: [{ organizationId: organization.id, qualificationId: extrusion.id }],
      },
    },
  });
  const packaging = await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: workArea.id,
      name: 'Packaging',
      code: 'PK',
      changeMode: 'INSTANT',
    },
  });
  // Requires a qualification the test worker deliberately does not hold.
  const restricted = await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: workArea.id,
      name: 'Cutting station',
      code: 'CS',
      changeMode: 'QUALIFICATION_REQUIRED',
      requiredQualifications: {
        create: [{ organizationId: organization.id, qualificationId: cutting.id }],
      },
    },
  });

  const pinHash = await hashPin('482913');
  const worker = await prisma.worker.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      employeeNumber: '1001',
      firstName: 'Test',
      lastName: 'Worker',
      pinHash,
      pinSetAt: new Date(),
    },
  });
  const otherWorker = await prisma.worker.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      employeeNumber: '1002',
      firstName: 'Other',
      lastName: 'Worker',
      pinHash,
      pinSetAt: new Date(),
    },
  });

  await prisma.workerQualification.createMany({
    data: [
      { organizationId: organization.id, workerId: worker.id, qualificationId: extrusion.id },
      { organizationId: organization.id, workerId: otherWorker.id, qualificationId: extrusion.id },
    ],
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      registrationNumber: `${slug.toUpperCase()}-001`,
      make: 'Ford',
      model: 'Transit',
      vehicleType: 'VAN',
      fuelType: 'DIESEL',
      odometerCurrent: '100000',
      averageConsumption: '8.4',
    },
  });
  const otherVehicle = await prisma.vehicle.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      registrationNumber: `${slug.toUpperCase()}-002`,
      make: 'Ford',
      model: 'Transit',
      vehicleType: 'VAN',
      fuelType: 'DIESEL',
      odometerCurrent: '50000',
    },
  });

  const driver = await prisma.driver.create({
    data: {
      organizationId: organization.id,
      driverCode: 'D001',
      firstName: 'Test',
      lastName: 'Driver',
      pinHash,
      pinSetAt: new Date(),
    },
  });
  const otherDriver = await prisma.driver.create({
    data: {
      organizationId: organization.id,
      driverCode: 'D002',
      firstName: 'Other',
      lastName: 'Driver',
      pinHash,
      pinSetAt: new Date(),
    },
  });

  await prisma.vehicleAssignment.create({
    data: {
      organizationId: organization.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      startedAt: new Date(),
    },
  });
  await prisma.vehicleAssignment.create({
    data: {
      organizationId: organization.id,
      driverId: otherDriver.id,
      vehicleId: otherVehicle.id,
      startedAt: new Date(),
    },
  });

  return {
    organizationId: organization.id,
    siteId: site.id,
    workAreaId: workArea.id,
    positionIds: {
      machine1: machine1.id,
      machine2: machine2.id,
      packaging: packaging.id,
      restricted: restricted.id,
    },
    qualificationIds: { extrusion: extrusion.id, cutting: cutting.id },
    workerId: worker.id,
    otherWorkerId: otherWorker.id,
    driverId: driver.id,
    otherDriverId: otherDriver.id,
    vehicleId: vehicle.id,
    adminUserId: adminUser.id,
    slug,
  };
}
