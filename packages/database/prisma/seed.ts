/**
 * Seed data.
 *
 * Two parts, kept separate on purpose:
 *
 *   1. Platform reference data — markets, features, plans, prices, system roles. Required in
 *      every environment including production; safe to re-run (everything upserts by a natural
 *      key).
 *   2. A demo organization — a small but complete factory with a fleet, used for development,
 *      E2E tests and sales demos. Never seeded into production.
 *
 * Run: pnpm db:seed          (platform + demo, unless NODE_ENV=production)
 *      SEED_DEMO=false pnpm db:seed   (platform only)
 */

import { findWorkspaceRoot, loadRootEnvFiles } from '@aytracker/config';
import { SYSTEM_ROLE_DEFINITIONS, hashPassword, hashPin } from '@aytracker/auth';
import { FEATURE_DEFINITIONS, PLAN_DEFINITIONS } from '@aytracker/billing';
import { computeTrackDistance } from '@aytracker/tracking';

// Before PrismaClient is constructed, and before the import that constructs it. This script is
// run directly (`tsx prisma/seed.ts`), so it never passes through prisma.config.ts and would
// otherwise need DATABASE_URL typed in front of every invocation.
loadRootEnvFiles(findWorkspaceRoot(process.cwd()));

const { PrismaClient } = await import('@prisma/client');

const prisma = new PrismaClient();

const DEMO_ADMIN_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'demo-password-2026!';
const DEMO_WORKER_PIN = process.env['SEED_WORKER_PIN'] ?? '482913';
const DEMO_DRIVER_PIN = process.env['SEED_DRIVER_PIN'] ?? '571364';

async function seedMarkets(): Promise<void> {
  /**
   * Markets are commercial regions, not countries. BG and DE are separate because they are
   * priced separately; the rest of the EU shares one market until there is a reason to split it.
   * `priority` breaks ties when two markets claim the same country — the specific one wins.
   */
  const markets = [
    {
      code: 'GLOBAL',
      name: 'Global',
      countryCodes: [] as string[],
      defaultCurrency: 'EUR',
      defaultLocale: 'en',
      defaultTimezone: 'UTC',
      measurementSystem: 'METRIC' as const,
      taxScheme: 'NONE' as const,
      priority: 1000,
    },
    {
      code: 'BG',
      name: 'Bulgaria',
      countryCodes: ['BG'],
      defaultCurrency: 'EUR',
      defaultLocale: 'bg',
      defaultTimezone: 'Europe/Sofia',
      measurementSystem: 'METRIC' as const,
      taxScheme: 'EU_VAT' as const,
      priority: 10,
    },
    {
      code: 'DE',
      name: 'Germany',
      countryCodes: ['DE'],
      defaultCurrency: 'EUR',
      defaultLocale: 'de',
      defaultTimezone: 'Europe/Berlin',
      measurementSystem: 'METRIC' as const,
      taxScheme: 'EU_VAT' as const,
      priority: 10,
    },
    {
      code: 'EU',
      name: 'European Union',
      countryCodes: [
        'AT',
        'BE',
        'HR',
        'CY',
        'CZ',
        'DK',
        'EE',
        'FI',
        'FR',
        'GR',
        'HU',
        'IE',
        'IT',
        'LV',
        'LT',
        'LU',
        'MT',
        'NL',
        'PL',
        'PT',
        'RO',
        'SK',
        'SI',
        'ES',
        'SE',
      ],
      defaultCurrency: 'EUR',
      defaultLocale: 'en',
      defaultTimezone: 'Europe/Brussels',
      measurementSystem: 'METRIC' as const,
      taxScheme: 'EU_VAT' as const,
      priority: 50,
    },
    {
      code: 'US',
      name: 'United States',
      countryCodes: ['US'],
      defaultCurrency: 'USD',
      defaultLocale: 'en',
      defaultTimezone: 'America/New_York',
      measurementSystem: 'IMPERIAL' as const,
      taxScheme: 'US_SALES_TAX' as const,
      priority: 10,
    },
  ];

  for (const market of markets) {
    await prisma.market.upsert({
      where: { code: market.code },
      update: market,
      create: market,
    });
  }
  console.log(`  markets: ${markets.length}`);
}

async function seedFeaturesAndPlans(): Promise<void> {
  for (const feature of FEATURE_DEFINITIONS) {
    await prisma.feature.upsert({
      where: { code: feature.code },
      update: { name: feature.name, moduleCode: feature.moduleCode },
      create: { code: feature.code, name: feature.name, moduleCode: feature.moduleCode },
    });
  }

  for (const plan of PLAN_DEFINITIONS) {
    const created = await prisma.plan.upsert({
      where: { code: plan.code },
      update: {
        name: plan.name,
        tier: plan.tier,
        description: plan.description,
        sortOrder: plan.sortOrder,
        isPublic: plan.isPublic,
        limits: plan.limits,
      },
      create: {
        code: plan.code,
        name: plan.name,
        tier: plan.tier,
        description: plan.description,
        sortOrder: plan.sortOrder,
        isPublic: plan.isPublic,
        limits: plan.limits,
      },
    });

    for (const featureCode of plan.features) {
      const feature = await prisma.feature.findUnique({ where: { code: featureCode } });
      if (!feature) continue;
      await prisma.planFeature.upsert({
        where: { planId_featureId: { planId: created.id, featureId: feature.id } },
        update: {},
        create: { planId: created.id, featureId: feature.id },
      });
    }
  }
  console.log(`  features: ${FEATURE_DEFINITIONS.length}, plans: ${PLAN_DEFINITIONS.length}`);
}

async function seedPrices(): Promise<void> {
  /**
   * Illustrative launch prices. These are rows, not code — changing one means inserting a new
   * row and retiring the old, which is what keeps existing subscriptions on the price they were
   * sold at.
   */
  const table: Record<
    string,
    Record<string, { monthly: string; annual: string; currency: string }>
  > = {
    BG: {
      starter: { monthly: '49', annual: '490', currency: 'EUR' },
      professional: { monthly: '89', annual: '890', currency: 'EUR' },
      business: { monthly: '179', annual: '1790', currency: 'EUR' },
    },
    DE: {
      starter: { monthly: '69', annual: '690', currency: 'EUR' },
      professional: { monthly: '129', annual: '1290', currency: 'EUR' },
      business: { monthly: '249', annual: '2490', currency: 'EUR' },
    },
    EU: {
      starter: { monthly: '59', annual: '590', currency: 'EUR' },
      professional: { monthly: '109', annual: '1090', currency: 'EUR' },
      business: { monthly: '219', annual: '2190', currency: 'EUR' },
    },
    US: {
      starter: { monthly: '99', annual: '990', currency: 'USD' },
      professional: { monthly: '199', annual: '1990', currency: 'USD' },
      business: { monthly: '399', annual: '3990', currency: 'USD' },
    },
    GLOBAL: {
      starter: { monthly: '69', annual: '690', currency: 'EUR' },
      professional: { monthly: '129', annual: '1290', currency: 'EUR' },
      business: { monthly: '259', annual: '2590', currency: 'EUR' },
    },
  };

  const effectiveFrom = new Date('2026-01-01T00:00:00Z');
  let count = 0;

  for (const [marketCode, plans] of Object.entries(table)) {
    const market = await prisma.market.findUnique({ where: { code: marketCode } });
    if (!market) continue;

    for (const [planCode, amounts] of Object.entries(plans)) {
      const plan = await prisma.plan.findUnique({ where: { code: planCode } });
      if (!plan) continue;

      for (const interval of ['MONTHLY', 'ANNUAL'] as const) {
        const existing = await prisma.price.findFirst({
          where: { marketId: market.id, planId: plan.id, interval, status: 'ACTIVE' },
        });
        if (existing) continue;

        await prisma.price.create({
          data: {
            planId: plan.id,
            marketId: market.id,
            currency: amounts.currency,
            interval,
            amount: interval === 'MONTHLY' ? amounts.monthly : amounts.annual,
            status: 'ACTIVE',
            effectiveFrom,
          },
        });
        count += 1;
      }
    }
  }
  console.log(`  prices: ${count}`);
}

async function seedSystemRoles(): Promise<void> {
  for (const role of SYSTEM_ROLE_DEFINITIONS) {
    const existing = await prisma.role.findFirst({
      where: { organizationId: null, code: role.code },
    });
    if (existing) {
      await prisma.role.update({
        where: { id: existing.id },
        data: {
          name: role.name,
          description: role.description,
          permissions: [...role.permissions],
        },
      });
    } else {
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
  console.log(`  system roles: ${SYSTEM_ROLE_DEFINITIONS.length}`);
}

/**
 * A demo GPS track along the Sofia–Plovdiv corridor.
 *
 * Sampled every 30 seconds, which is what the real sampling policy produces on a motorway. The
 * previous version put eight points twenty minutes apart, and the consequence was instructive:
 * every single segment exceeded the five-minute bridging limit, so `computeTrackDistance` refused
 * to join any of them and the "route" rendered as eight unconnected dots. The data was wrong, not
 * the rule — and the tempting fix would have been to relax the rule, which is exactly the change
 * that would let GPS noise invent kilometres in production.
 *
 * One deliberate nineteen-minute silence sits in the middle, matching the tracking events seeded
 * beside it. That is the whole point of the demo: a continuous line with one honest break in it,
 * so the admin route view has something real to draw and the gap is visible rather than papered
 * over with a straight line.
 */
function buildDemoTrack(
  organizationId: string,
  tripId: string,
  startedAt: Date,
  endedAt: Date,
): {
  organizationId: string;
  tripId: string;
  timestamp: Date;
  latitude: string;
  longitude: string;
  accuracyMeters: string;
  speedMps: string;
  source: string;
}[] {
  // Waypoints along the A1. Interpolated between, not used directly.
  const corridor: readonly (readonly [number, number])[] = [
    [42.6977, 23.3219],
    [42.652, 23.438],
    [42.59, 23.61],
    [42.51, 23.83],
    [42.43, 24.01],
    [42.32, 24.26],
    [42.24, 24.47],
    [42.1354, 24.7453],
  ];

  const intervalSeconds = 30;
  const totalSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  const gapStart = 3600;
  const gapEnd = gapStart + 1140;

  const points = [];
  for (let elapsed = 0; elapsed <= totalSeconds; elapsed += intervalSeconds) {
    // The silence. Points are simply absent — which is what a phone in a dead zone produces,
    // and what the gap detector is written to notice.
    if (elapsed > gapStart && elapsed < gapEnd) continue;

    const progress = elapsed / totalSeconds;
    const scaled = progress * (corridor.length - 1);
    const index = Math.min(corridor.length - 2, Math.floor(scaled));
    const withinSegment = scaled - index;

    const from = corridor[index]!;
    const to = corridor[index + 1]!;
    // A few metres of wander so the line reads as a driven road rather than a ruler. Well under
    // the 10 m minimum segment length, so it never adds distance of its own.
    const jitter = Math.sin(elapsed / 97) * 0.00004;

    points.push({
      organizationId,
      tripId,
      timestamp: new Date(startedAt.getTime() + elapsed * 1000),
      latitude: (from[0] + (to[0] - from[0]) * withinSegment + jitter).toFixed(6),
      longitude: (from[1] + (to[1] - from[1]) * withinSegment + jitter).toFixed(6),
      accuracyMeters: '12.50',
      speedMps: '24.500',
      source: 'GPS',
    });
  }

  return points;
}

async function seedDemoOrganization(): Promise<void> {
  const existing = await prisma.organization.findUnique({ where: { slug: 'demo-factory' } });
  if (existing) {
    // Idempotent, so `pnpm setup` can be re-run. The credentials are printed anyway: on a second
    // run they are exactly what a developer came back for, and silence here would send them to
    // read the seed source to find out what they already have.
    console.log('  demo organization already present — skipping');
    printDemoCredentials();
    return;
  }

  const bgMarket = await prisma.market.findUnique({ where: { code: 'BG' } });
  const businessPlan = await prisma.plan.findUnique({ where: { code: 'business' } });

  const organization = await prisma.organization.create({
    data: {
      slug: 'demo-factory',
      name: 'Demo Factory',
      legalName: 'Demo Factory EOOD',
      status: 'ACTIVE',
      countryCode: 'BG',
      billingCountry: 'BG',
      marketId: bgMarket?.id ?? null,
      defaultLocale: 'bg',
      defaultTimezone: 'Europe/Sofia',
      defaultCurrency: 'EUR',
      branding: {
        create: {
          companyName: 'Demo Factory',
          primaryColor: '#1d4ed8',
          secondaryColor: '#475569',
          accentColor: '#f59e0b',
          loginMessage: 'Welcome to Demo Factory',
          customSupportEmail: 'support@demo-factory.example',
        },
      },
      settings: {
        create: {
          requireQualificationByDefault: true,
          allowWorkerSelfShiftStart: true,
          maxShiftDurationMinutes: 960,
          gpsMinIntervalSeconds: 15,
          gpsMinDistanceMeters: 50,
        },
      },
    },
  });

  // Every feature the Business plan grants, resolved into concrete entitlements.
  if (businessPlan) {
    const planFeatures = await prisma.planFeature.findMany({
      where: { planId: businessPlan.id },
      select: { featureId: true },
    });
    await prisma.organizationEntitlement.createMany({
      data: planFeatures.map((planFeature) => ({
        organizationId: organization.id,
        featureId: planFeature.featureId,
        isEnabled: true,
        source: 'PLAN' as const,
      })),
      skipDuplicates: true,
    });
  }

  const ownerRole = await prisma.role.findFirst({ where: { organizationId: null, code: 'owner' } });
  const supervisorRole = await prisma.role.findFirst({
    where: { organizationId: null, code: 'supervisor' },
  });

  const passwordHash = await hashPassword(DEMO_ADMIN_PASSWORD);
  const admin = await prisma.user.create({
    data: {
      email: 'admin@demo-factory.example',
      passwordHash,
      firstName: 'Demo',
      lastName: 'Administrator',
      preferredLocale: 'bg',
      emailVerifiedAt: new Date(),
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

  if (supervisorRole) {
    await prisma.user.create({
      data: {
        email: 'supervisor@demo-factory.example',
        passwordHash,
        firstName: 'Demo',
        lastName: 'Supervisor',
        preferredLocale: 'bg',
        emailVerifiedAt: new Date(),
        memberships: {
          create: {
            organizationId: organization.id,
            roleId: supervisorRole.id,
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
        },
      },
    });
  }

  const site = await prisma.site.create({
    data: {
      organizationId: organization.id,
      name: 'Sofia Plant',
      code: 'SOF',
      timezone: 'Europe/Sofia',
      countryCode: 'BG',
      address: 'Industrial Zone, Sofia',
    },
  });

  const extrusion = await prisma.workArea.create({
    data: { organizationId: organization.id, siteId: site.id, name: 'Extrusion', code: 'EXT' },
  });
  const packing = await prisma.workArea.create({
    data: { organizationId: organization.id, siteId: site.id, name: 'Packaging', code: 'PACK' },
  });
  const painting = await prisma.workArea.create({
    data: { organizationId: organization.id, siteId: site.id, name: 'Painting', code: 'PAINT' },
  });
  // Driving is a work area like any other. Every position belongs to one, and pretending a driver
  // stands at the extrusion line would make the work-area reports lie.
  const transport = await prisma.workArea.create({
    data: { organizationId: organization.id, siteId: site.id, name: 'Transport', code: 'TRANS' },
  });

  const qualifications = await Promise.all(
    [
      { name: 'Extrusion Operator', code: 'EXT-OP', expires: false },
      { name: 'Packaging', code: 'PACK-OP', expires: false },
      { name: 'Cutting', code: 'CUT-OP', expires: false },
      { name: 'Paint Booth', code: 'PAINT-OP', expires: true, validityDays: 365 },
    ].map((qualification) =>
      prisma.qualification.create({
        data: { organizationId: organization.id, ...qualification },
      }),
    ),
  );
  const [extQual, packQual, cutQual, paintQual] = qualifications;

  /**
   * Positions demonstrate all three change modes:
   *   Machine 1/2  QUALIFICATION_REQUIRED — the normal case
   *   Packaging    INSTANT                — the two-second path, no interrogation
   *   Paint Booth  SUPERVISOR_APPROVAL    — a critical position
   *   Machine 4    QUALIFICATION_REQUIRED — deliberately not granted to the demo worker,
   *                                         so the "not eligible" path is visible in a demo
   *   Шофьор       INSTANT, kind DRIVING  — hands the worker a vehicle and the driver portal
   */
  const machine1 = await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: extrusion.id,
      name: 'Machine 1',
      code: 'M1',
      changeMode: 'QUALIFICATION_REQUIRED',
      qrToken: 'demo-qr-machine-1',
      requiredQualifications: {
        create: [{ organizationId: organization.id, qualificationId: extQual!.id }],
      },
    },
  });
  const machine2 = await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: extrusion.id,
      name: 'Machine 2',
      code: 'M2',
      changeMode: 'QUALIFICATION_REQUIRED',
      qrToken: 'demo-qr-machine-2',
      requiredQualifications: {
        create: [{ organizationId: organization.id, qualificationId: extQual!.id }],
      },
    },
  });
  await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: extrusion.id,
      name: 'Machine 4',
      code: 'M4',
      changeMode: 'QUALIFICATION_REQUIRED',
      requiredQualifications: {
        create: [{ organizationId: organization.id, qualificationId: cutQual!.id }],
      },
    },
  });
  const packagingPosition = await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: packing.id,
      name: 'Packaging',
      code: 'PK1',
      changeMode: 'INSTANT',
      qrToken: 'demo-qr-packaging',
    },
  });
  await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: painting.id,
      name: 'Paint Booth',
      code: 'PB1',
      changeMode: 'SUPERVISOR_APPROVAL',
      capacity: 1,
      requiredQualifications: {
        create: [{ organizationId: organization.id, qualificationId: paintQual!.id }],
      },
    },
  });
  /**
   * The driving position.
   *
   * Named in Bulgarian because the demo tenant is Bulgarian, and the behaviour comes from `kind`
   * rather than the name — a tenant calling it "Chauffeur" would get the same vehicle picker.
   * Ivan is linked to driver D001 below, so selecting this position in the worker portal offers
   * him a vehicle and moves him to the driver portal with a trip running.
   * See docs/driving-handoff.md.
   */
  await prisma.position.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workAreaId: transport.id,
      name: 'Шофьор',
      code: 'DRV',
      kind: 'DRIVING',
      changeMode: 'INSTANT',
      qrToken: 'demo-qr-driving',
    },
  });

  const pinHash = await hashPin(DEMO_WORKER_PIN);
  const workers = await Promise.all(
    [
      { employeeNumber: '1001', firstName: 'Ivan', lastName: 'Petrov' },
      { employeeNumber: '1002', firstName: 'Maria', lastName: 'Dimitrova' },
      { employeeNumber: '1003', firstName: 'Georgi', lastName: 'Stoyanov' },
    ].map((worker) =>
      prisma.worker.create({
        data: {
          organizationId: organization.id,
          siteId: site.id,
          ...worker,
          pinHash,
          pinSetAt: new Date(),
          preferredLocale: 'bg',
          hiredAt: new Date('2025-03-01T00:00:00Z'),
        },
      }),
    ),
  );
  const [ivan, maria] = workers;

  // Ivan: extrusion + packaging + cutting. Not paint — that is the "not allowed" case.
  await prisma.workerQualification.createMany({
    data: [
      { organizationId: organization.id, workerId: ivan!.id, qualificationId: extQual!.id },
      { organizationId: organization.id, workerId: ivan!.id, qualificationId: packQual!.id },
      { organizationId: organization.id, workerId: ivan!.id, qualificationId: cutQual!.id },
      { organizationId: organization.id, workerId: maria!.id, qualificationId: packQual!.id },
    ],
  });

  const shiftType = await prisma.shiftType.create({
    data: {
      organizationId: organization.id,
      name: 'Day shift',
      code: 'DAY',
      startMinute: 6 * 60,
      endMinute: 14 * 60,
      unpaidBreakMinutes: 30,
    },
  });
  // A night shift, so overnight/DST behaviour is exercised by the demo data too.
  await prisma.shiftType.create({
    data: {
      organizationId: organization.id,
      name: 'Night shift',
      code: 'NIGHT',
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      crossesMidnight: true,
      unpaidBreakMinutes: 30,
    },
  });

  const productTemplate = await prisma.productTemplate.create({
    data: {
      organizationId: organization.id,
      name: 'Profile 40x40',
      code: 'P4040',
      unit: 'pcs',
      targetPerHour: '120',
    },
  });

  /**
   * A completed shift with a real position-change history.
   *
   * Nine hours back rather than thirty, so it lands inside the dashboard's default
   * last-24-hours window. Seeded a day earlier, every production figure on the dashboard read
   * zero on a fresh install and the hourly chart was a flat line — a demo that looks like a
   * broken product until someone thinks to change the date range.
   */
  const yesterdayStart = new Date(Date.now() - 9 * 60 * 60 * 1000);
  const shift = await prisma.shift.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      workerId: ivan!.id,
      shiftTypeId: shiftType.id,
      status: 'COMPLETED',
      actualStart: yesterdayStart,
      actualEnd: new Date(yesterdayStart.getTime() + 8 * 3600 * 1000),
      workedSeconds: 8 * 3600 - 1800,
      breakSeconds: 1800,
      breaks: {
        create: {
          organizationId: organization.id,
          type: 'MEAL',
          startedAt: new Date(yesterdayStart.getTime() + 4 * 3600 * 1000),
          endedAt: new Date(yesterdayStart.getTime() + 4.5 * 3600 * 1000),
          durationSeconds: 1800,
        },
      },
    },
  });

  const session1End = new Date(yesterdayStart.getTime() + 3.2 * 3600 * 1000);
  const session2End = new Date(yesterdayStart.getTime() + 6.9 * 3600 * 1000);
  const session1 = await prisma.positionSession.create({
    data: {
      organizationId: organization.id,
      shiftId: shift.id,
      workerId: ivan!.id,
      positionId: machine1.id,
      startedAt: yesterdayStart,
      endedAt: session1End,
      durationSeconds: Math.round((session1End.getTime() - yesterdayStart.getTime()) / 1000),
    },
  });
  await prisma.positionSession.create({
    data: {
      organizationId: organization.id,
      shiftId: shift.id,
      workerId: ivan!.id,
      positionId: machine2.id,
      startedAt: session1End,
      endedAt: session2End,
      durationSeconds: Math.round((session2End.getTime() - session1End.getTime()) / 1000),
    },
  });
  await prisma.positionSession.create({
    data: {
      organizationId: organization.id,
      shiftId: shift.id,
      workerId: ivan!.id,
      positionId: packagingPosition.id,
      startedAt: session2End,
      endedAt: new Date(yesterdayStart.getTime() + 8 * 3600 * 1000),
      durationSeconds: Math.round(
        (yesterdayStart.getTime() + 8 * 3600 * 1000 - session2End.getTime()) / 1000,
      ),
      source: 'QR',
    },
  });

  await prisma.productionEntry.create({
    data: {
      organizationId: organization.id,
      shiftId: shift.id,
      workerId: ivan!.id,
      positionId: machine1.id,
      positionSessionId: session1.id,
      productTemplateId: productTemplate.id,
      goodQuantity: '384',
      defectQuantity: '11',
      recordedAt: session1End,
    },
  });

  // --- fleet ---------------------------------------------------------------
  const driverPinHash = await hashPin(DEMO_DRIVER_PIN);
  const driver = await prisma.driver.create({
    data: {
      organizationId: organization.id,
      driverCode: 'D001',
      firstName: 'Ivan',
      lastName: 'Petrov',
      workerId: ivan!.id,
      pinHash: driverPinHash,
      pinSetAt: new Date(),
      licenseNumber: 'BG-123456',
      licenseExpiresAt: new Date('2028-06-30T00:00:00Z'),
      preferredLocale: 'bg',
    },
  });
  const driver2 = await prisma.driver.create({
    data: {
      organizationId: organization.id,
      driverCode: 'D002',
      firstName: 'Maria',
      lastName: 'Dimitrova',
      pinHash: driverPinHash,
      pinSetAt: new Date(),
      preferredLocale: 'bg',
    },
  });

  const van = await prisma.vehicle.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      registrationNumber: 'CA1234AB',
      make: 'Ford',
      model: 'Transit',
      year: 2021,
      vehicleType: 'VAN',
      fuelType: 'DIESEL',
      fuelTankCapacity: '80',
      odometerCurrent: '148320',
      averageConsumption: '8.4',
      consumptionUnit: 'L_PER_100KM',
    },
  });
  const truck = await prisma.vehicle.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      registrationNumber: 'PB5678CD',
      make: 'MAN',
      model: 'TGL',
      year: 2019,
      vehicleType: 'TRUCK',
      fuelType: 'DIESEL',
      fuelTankCapacity: '150',
      odometerCurrent: '392110',
      averageConsumption: '19.5',
      consumptionUnit: 'L_PER_100KM',
    },
  });

  // A third vehicle nobody holds, so the picker has both cases to show: the driver's own van at
  // the top, and a free one below it.
  await prisma.vehicle.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      registrationNumber: 'CB9012EF',
      make: 'Renault',
      model: 'Master',
      year: 2022,
      vehicleType: 'VAN',
      fuelType: 'DIESEL',
      fuelTankCapacity: '80',
      odometerCurrent: '61540',
      averageConsumption: '9.1',
      consumptionUnit: 'L_PER_100KM',
    },
  });

  // Both manual: a fleet manager's long-term decision. The handoff releases only the assignments
  // it created itself, so ending a trip in the van leaves Ivan still holding it tomorrow.
  await prisma.vehicleAssignment.create({
    data: {
      organizationId: organization.id,
      driverId: driver.id,
      vehicleId: van.id,
      startedAt: new Date(Date.now() - 14 * 86_400_000),
      isAutomatic: false,
    },
  });
  await prisma.vehicleAssignment.create({
    data: {
      organizationId: organization.id,
      driverId: driver2.id,
      vehicleId: truck.id,
      startedAt: new Date(Date.now() - 7 * 86_400_000),
      isAutomatic: false,
    },
  });

  // A completed trip with a deliberate tracking gap, so the admin route view has a hole to
  // render and the "do not invent points across a gap" behaviour is demonstrable.
  /**
   * Within the dashboard's default window, not before it.
   *
   * At 26 hours ago the trip fell outside the last-24-hours range the dashboard opens on, so a
   * freshly seeded demo showed zeros everywhere and looked broken. A demo that has to be
   * date-picked before it shows anything is a demo nobody trusts.
   */
  const tripStart = new Date(Date.now() - 5 * 3600 * 1000);
  const tripEnd = new Date(tripStart.getTime() + 2.6 * 3600 * 1000);
  const trip = await prisma.driverTrip.create({
    data: {
      organizationId: organization.id,
      driverId: driver.id,
      vehicleId: van.id,
      label: 'Sofia → Plovdiv',
      status: 'COMPLETED',
      startedAt: tripStart,
      endedAt: tripEnd,
      startLatitude: '42.697700',
      startLongitude: '23.321900',
      endLatitude: '42.135400',
      endLongitude: '24.745300',
      distanceMeters: 148_000,
      durationSeconds: Math.round((tripEnd.getTime() - tripStart.getTime()) / 1000),
      untrackedSeconds: 1140,
      startOdometer: '148172',
      endOdometer: '148320',
      trackingState: 'STOPPED',
    },
  });

  await prisma.trackingEvent.createMany({
    data: [
      {
        organizationId: organization.id,
        tripId: trip.id,
        type: 'TRACKING_STARTED',
        state: 'ACTIVE',
        occurredAt: tripStart,
      },
      {
        organizationId: organization.id,
        tripId: trip.id,
        type: 'APP_NOT_REPORTING',
        state: 'INTERRUPTED',
        occurredAt: new Date(tripStart.getTime() + 3600 * 1000),
        recoveredAt: new Date(tripStart.getTime() + 3600 * 1000 + 1140 * 1000),
        gapSeconds: 1140,
      },
      {
        organizationId: organization.id,
        tripId: trip.id,
        type: 'REPORTING_RECOVERED',
        state: 'ACTIVE',
        occurredAt: new Date(tripStart.getTime() + 3600 * 1000 + 1140 * 1000),
      },
      {
        organizationId: organization.id,
        tripId: trip.id,
        type: 'TRACKING_STOPPED',
        state: 'STOPPED',
        occurredAt: tripEnd,
      },
    ],
  });

  const track = buildDemoTrack(organization.id, trip.id, tripStart, tripEnd);
  await prisma.tripLocationPoint.createMany({ data: track });

  /**
   * The summary is derived from the track, never typed in beside it.
   *
   * A hardcoded 148 km next to a track that measures something else is the exact inconsistency
   * this product exists to avoid, and a demo that ships it teaches everyone who reads the seed
   * that the two are allowed to disagree. The server recomputes on every batch; so does this.
   */
  const measured = computeTrackDistance(
    track.map((point) => ({
      timestamp: point.timestamp,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      accuracyMeters: Number(point.accuracyMeters),
    })),
  );
  await prisma.driverTrip.update({
    where: { id: trip.id },
    data: {
      distanceMeters: measured.distanceMeters,
      untrackedSeconds: measured.gapSeconds,
      endOdometer: (148_172 + measured.distanceMeters / 1000).toFixed(2),
    },
  });

  const fuelExpense = await prisma.fuelExpense.create({
    data: {
      organizationId: organization.id,
      vehicleId: van.id,
      driverId: driver.id,
      tripId: trip.id,
      date: tripEnd,
      liters: '62.400',
      pricePerLiter: '1.4900',
      // Server-computed: 62.4 × 1.49 = 92.976 → 92.98
      totalCost: '92.9800',
      currency: 'EUR',
      odometer: '148320',
      isFullTank: true,
      receiptReference: 'OMV-884213',
    },
  });

  await prisma.vehicleExpense.createMany({
    data: [
      {
        organizationId: organization.id,
        vehicleId: van.id,
        category: 'FUEL',
        amount: '92.9800',
        currency: 'EUR',
        date: tripEnd,
        fuelExpenseId: fuelExpense.id,
      },
      {
        organizationId: organization.id,
        vehicleId: van.id,
        category: 'INSURANCE',
        amount: '640.0000',
        currency: 'EUR',
        date: new Date(Date.now() - 60 * 86_400_000),
        vendor: 'Bulstrad',
      },
      {
        organizationId: organization.id,
        vehicleId: van.id,
        category: 'MAINTENANCE',
        amount: '310.5000',
        currency: 'EUR',
        date: new Date(Date.now() - 25 * 86_400_000),
        vendor: 'Ford Service Sofia',
        odometer: '146900',
      },
      {
        organizationId: organization.id,
        vehicleId: truck.id,
        category: 'VIGNETTE',
        amount: '480.0000',
        currency: 'EUR',
        date: new Date(Date.now() - 120 * 86_400_000),
      },
    ],
  });

  // Documents at three expiry distances, so every severity level renders in a demo.
  await prisma.vehicleDocument.createMany({
    data: [
      {
        organizationId: organization.id,
        vehicleId: van.id,
        type: 'INSURANCE',
        name: 'Third-party liability',
        expiresAt: new Date(Date.now() + 12 * 86_400_000),
        reminderDays: 30,
      },
      {
        organizationId: organization.id,
        vehicleId: van.id,
        type: 'TECHNICAL_INSPECTION',
        name: 'Annual inspection',
        expiresAt: new Date(Date.now() + 5 * 86_400_000),
        reminderDays: 30,
      },
      {
        organizationId: organization.id,
        vehicleId: truck.id,
        type: 'VIGNETTE',
        name: 'Annual road vignette',
        expiresAt: new Date(Date.now() + 200 * 86_400_000),
        reminderDays: 30,
      },
    ],
  });

  await prisma.recommendation.create({
    data: {
      organizationId: organization.id,
      submittedByUserId: admin.id,
      title: 'Show fuel cost per trip on the driver history screen',
      description:
        'Drivers ask how much a route cost. Showing the estimated fuel cost next to the distance would answer it without opening the admin app.',
      category: 'DRIVER_FLEET',
      priority: 'IMPORTANT',
      status: 'UNDER_REVIEW',
    },
  });

  printDemoCredentials();
}

function printDemoCredentials(): void {
  console.log('  demo organization: demo-factory');
  console.log(`    admin:  admin@demo-factory.example / ${DEMO_ADMIN_PASSWORD}`);
  console.log(`    worker: 1001 / ${DEMO_WORKER_PIN} (org slug: demo-factory)`);
  console.log(`    driver: D001 / ${DEMO_DRIVER_PIN} (org slug: demo-factory)`);
}

async function main(): Promise<void> {
  console.log('Seeding platform reference data…');
  await seedMarkets();
  await seedFeaturesAndPlans();
  await seedPrices();
  await seedSystemRoles();

  /**
   * The demo factory is opt-in, and has to stay that way.
   *
   * It used to be opt-out, guarded by `NODE_ENV !== 'production'`. That guard reads as safe and
   * is not: `NODE_ENV` is frequently unset on a platform that builds and runs from the same
   * image, and a seed run against a real database then invented Иван, five positions and three
   * vans inside a customer's account. Somebody who has entered no vehicles at all should never
   * see a Ford Transit — and no amount of "it's only a demo" makes that anything other than
   * fabricated data in a live tenant.
   *
   * So it now takes an explicit `SEED_DEMO=true`. Forgetting it costs a developer one flag;
   * forgetting the old one cost a customer their trust in every number on the screen.
   */
  if (process.env['SEED_DEMO'] === 'true') {
    console.log('Seeding demo organization…');
    await seedDemoOrganization();
  } else {
    console.log('Skipping demo organization. Set SEED_DEMO=true to seed it.');
  }

  console.log('Seed complete.');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
