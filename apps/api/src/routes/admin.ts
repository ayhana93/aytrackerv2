import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS, assertPermission } from '@aytracker/auth';
import { FEATURES } from '@aytracker/billing';
import { NotFoundError } from '@aytracker/domain';
import { HaversineRoutingProvider, findTrackingGaps } from '@aytracker/tracking';
import type { OrganizationId } from '@aytracker/types';
import type { AppServices } from '../services/container.js';

/**
 * /api/v1/admin — the management portal.
 *
 * Read-heavy, and every route is scoped by `actor.organizationId` in the query itself rather
 * than filtered afterwards. There is no route in this file that takes an organization id: the
 * one place a tenant could be chosen from a request is the one place it must not be.
 *
 * Every figure is computed here. The browser receives numbers and renders them; it never sums,
 * averages or converts. A total a client can compute is a total a client can change, and these
 * totals feed cost reports and, in some organizations, pay.
 */

/** Long enough to be useful, short enough that a mistyped range cannot pull a year of GPS. */
const MAX_RANGE_DAYS = 92;

function resolveRange(query: { from?: string; to?: string }, now: Date): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 24 * 60 * 60 * 1000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000), to: now };
  }

  const span = to.getTime() - from.getTime();
  const max = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
  return { from: span > max ? new Date(to.getTime() - max) : from, to };
}

export function adminRoutes(services: AppServices): FastifyPluginAsync {
  return async (app) => {
    // A management portal is for people, not for a worker or driver device token. Even a worker
    // session elevated for driving must not reach these routes.
    app.addHook('preHandler', app.requireActorType(['USER']));

    /**
     * The dashboard, in one request.
     *
     * Deliberately one round trip rather than six: the screen is useless in pieces, and six
     * requests means six chances to render a half-loaded dashboard where the KPIs and the chart
     * disagree because they were fetched a second apart.
     */
    app.get('/dashboard', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.REPORTS_READ);
      const organizationId = actor.organizationId;
      const now = services.clock.now();
      const { from, to } = resolveRange(request.query as { from?: string; to?: string }, now);

      const [openSessions, production, trips, warnings] = await Promise.all([
        services.prisma.positionSession.findMany({
          where: { organizationId, endedAt: null },
          select: {
            id: true,
            startedAt: true,
            worker: { select: { firstName: true, lastName: true } },
            position: { select: { name: true, kind: true } },
            shift: { select: { status: true } },
          },
          orderBy: { startedAt: 'asc' },
          take: 200,
        }),
        services.prisma.productionEntry.findMany({
          where: { organizationId, recordedAt: { gte: from, lte: to } },
          select: {
            recordedAt: true,
            goodQuantity: true,
            defectQuantity: true,
            position: { select: { name: true, workArea: { select: { name: true } } } },
          },
        }),
        services.prisma.driverTrip.findMany({
          where: { organizationId, startedAt: { gte: from, lte: to } },
          select: { distanceMeters: true, durationSeconds: true, untrackedSeconds: true },
        }),
        collectWarnings(services, organizationId, now),
      ]);

      // Decimal in the database because a "unit" can be a metre of extrusion. Summed as a
      // number here only after the query, and rounded once at the end rather than per row.
      const totalGood = production.reduce((sum, entry) => sum + Number(entry.goodQuantity), 0);
      const totalScrap = production.reduce((sum, entry) => sum + Number(entry.defectQuantity), 0);
      const distanceMeters = trips.reduce((sum, trip) => sum + trip.distanceMeters, 0);

      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        totals: {
          producedGood: Math.round(totalGood),
          producedScrap: Math.round(totalScrap),
          activeWorkers: new Set(openSessions.map((s) => s.id)).size,
          trips: trips.length,
          distanceMeters,
          // Reported rather than hidden. A shift with tracking holes is a shift whose distance
          // is a floor, and the person reading the dashboard should know that.
          untrackedSeconds: trips.reduce((sum, trip) => sum + trip.untrackedSeconds, 0),
        },
        hourly: bucketByHour(production, from, to),
        byWorkArea: groupByWorkArea(production),
        activePositions: openSessions.map((session) => ({
          id: session.id,
          worker: `${session.worker.firstName} ${session.worker.lastName}`,
          position: session.position.name,
          kind: session.position.kind,
          startedAt: session.startedAt.toISOString(),
          onBreak: session.shift.status === 'ON_BREAK',
        })),
        warnings,
      };
    });

    /** The fleet table. */
    app.get('/vehicles', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.FLEET_READ);

      const vehicles = await services.prisma.vehicle.findMany({
        where: { organizationId: actor.organizationId },
        select: {
          id: true,
          registrationNumber: true,
          make: true,
          model: true,
          vehicleType: true,
          fuelType: true,
          status: true,
          odometerCurrent: true,
          averageConsumption: true,
          assignments: {
            where: { endedAt: null },
            select: {
              startedAt: true,
              isAutomatic: true,
              driver: { select: { id: true, firstName: true, lastName: true } },
            },
            take: 1,
          },
        },
        orderBy: { registrationNumber: 'asc' },
      });

      return {
        vehicles: vehicles.map((vehicle) => {
          const assignment = vehicle.assignments[0];
          return {
            id: vehicle.id,
            registrationNumber: vehicle.registrationNumber,
            make: vehicle.make,
            model: vehicle.model,
            vehicleType: vehicle.vehicleType,
            fuelType: vehicle.fuelType,
            status: vehicle.status,
            // Decimal columns are serialised as strings on purpose: an odometer past 2^53 is not
            // the risk, but silently losing precision on a Decimal in JSON is a real one.
            odometer: vehicle.odometerCurrent.toString(),
            averageConsumption: vehicle.averageConsumption?.toString() ?? null,
            driver: assignment
              ? {
                  id: assignment.driver.id,
                  name: `${assignment.driver.firstName} ${assignment.driver.lastName}`,
                  since: assignment.startedAt.toISOString(),
                  // Distinguishes a fleet manager's standing assignment from one the driving
                  // handoff created for a single shift.
                  automatic: assignment.isAutomatic,
                }
              : null,
          };
        }),
      };
    });

    /** Every trip in the organization, newest first. */
    app.get('/trips', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.FLEET_TRACKING_READ);
      const query = request.query as { from?: string; to?: string; limit?: string };
      const { from, to } = resolveRange(query, services.clock.now());

      const trips = await services.prisma.driverTrip.findMany({
        where: { organizationId: actor.organizationId, startedAt: { gte: from, lte: to } },
        select: {
          id: true,
          label: true,
          status: true,
          startedAt: true,
          endedAt: true,
          distanceMeters: true,
          durationSeconds: true,
          untrackedSeconds: true,
          trackingState: true,
          driver: { select: { firstName: true, lastName: true } },
          vehicle: { select: { registrationNumber: true } },
        },
        orderBy: { startedAt: 'desc' },
        take: Math.min(Number(query.limit ?? 100), 500),
      });

      return {
        trips: trips.map((trip) => ({
          id: trip.id,
          label: trip.label,
          status: trip.status,
          startedAt: trip.startedAt?.toISOString() ?? null,
          endedAt: trip.endedAt?.toISOString() ?? null,
          distanceMeters: trip.distanceMeters,
          durationSeconds: trip.durationSeconds,
          untrackedSeconds: trip.untrackedSeconds,
          trackingState: trip.trackingState,
          driver: `${trip.driver.firstName} ${trip.driver.lastName}`,
          vehicle: trip.vehicle.registrationNumber,
        })),
      };
    });

    /**
     * One trip's route, as a polyline the map can draw directly.
     *
     * `gapAfterIndices` is the reason this endpoint returns a reconstruction rather than the raw
     * rows: it names the points after which the line must **break**. Drawing straight through a
     * nineteen-minute silence would invent a road the vehicle may never have taken, and it is
     * exactly the picture someone would print and put in front of a driver.
     *
     * Behind its own entitlement and permission: a route is the most sensitive data in the
     * system — it is a record of where an identifiable person was, minute by minute.
     */
    app.get(
      '/trips/:tripId/track',
      // Gated on the entitlement as well as the permission. An organization that does not pay
      // for GPS tracking must not read routes through the admin portal either — otherwise the
      // paywall is on the driver's device and not on the data.
      { preHandler: app.requireEntitlement(FEATURES.GPS_TRACKING) },
      async (request) => {
        const actor = app.requireAuth(request);
        assertPermission(actor, PERMISSIONS.FLEET_TRACKING_READ);
        const { tripId } = request.params as { tripId: string };

        const trip = await services.prisma.driverTrip.findFirst({
          // Tenant is part of the query. Another organization's trip is not "forbidden", it is
          // not found — confirming that a row exists elsewhere is itself a leak.
          where: { id: tripId, organizationId: actor.organizationId },
          select: {
            id: true,
            label: true,
            status: true,
            startedAt: true,
            endedAt: true,
            distanceMeters: true,
            durationSeconds: true,
            pausedSeconds: true,
            untrackedSeconds: true,
            trackingState: true,
            driver: { select: { firstName: true, lastName: true } },
            vehicle: { select: { registrationNumber: true, make: true, model: true } },
            trackingEvents: {
              select: { type: true, state: true, occurredAt: true, gapSeconds: true },
              orderBy: { occurredAt: 'asc' },
            },
          },
        });
        if (!trip) throw new NotFoundError('trip.not_found', 'Trip not found.');

        const rows = await services.prisma.tripLocationPoint.findMany({
          where: { organizationId: actor.organizationId, tripId: trip.id },
          select: {
            timestamp: true,
            latitude: true,
            longitude: true,
            accuracyMeters: true,
            speedMps: true,
          },
          orderBy: { timestamp: 'asc' },
        });

        const points = rows.map((row) => ({
          timestamp: row.timestamp,
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          accuracyMeters: row.accuracyMeters === null ? null : Number(row.accuracyMeters),
          speedMps: row.speedMps === null ? null : Number(row.speedMps),
        }));

        const route = await new HaversineRoutingProvider().reconstruct(points);
        const gaps =
          trip.startedAt === null
            ? []
            : findTrackingGaps({
                pointTimestamps: points.map((point) => point.timestamp),
                tripStartedAt: trip.startedAt,
                tripEndedAt: trip.endedAt,
                now: services.clock.now(),
              });

        return {
          trip: {
            id: trip.id,
            label: trip.label,
            status: trip.status,
            startedAt: trip.startedAt?.toISOString() ?? null,
            endedAt: trip.endedAt?.toISOString() ?? null,
            distanceMeters: trip.distanceMeters,
            durationSeconds: trip.durationSeconds,
            pausedSeconds: trip.pausedSeconds,
            untrackedSeconds: trip.untrackedSeconds,
            trackingState: trip.trackingState,
            driver: `${trip.driver.firstName} ${trip.driver.lastName}`,
            vehicle: trip.vehicle,
          },
          track: {
            points: route.points,
            distanceMeters: route.distanceMeters,
            /** Draw a break after each of these indices rather than a straight line. */
            gapAfterIndices: route.gapAfterIndices,
            pointCount: points.length,
          },
          /** The same holes, with times and durations, for the list beside the map. */
          gaps: gaps.map((gap) => ({
            startedAt: gap.startedAt.toISOString(),
            // Null while the gap is still running — the trip is live and has not reported since.
            endedAt: gap.endedAt?.toISOString() ?? null,
            seconds: gap.seconds,
            isOpen: gap.isOpen,
          })),
          events: trip.trackingEvents.map((event) => ({
            type: event.type,
            state: event.state,
            occurredAt: event.occurredAt.toISOString(),
            gapSeconds: event.gapSeconds,
          })),
        };
      },
    );

    /** White-label settings. */
    app.get('/branding', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.BRANDING_READ);

      const organization = await services.prisma.organization.findUniqueOrThrow({
        where: { id: actor.organizationId },
        select: { name: true, slug: true, branding: true },
      });

      return {
        companyName: organization.branding?.companyName ?? organization.name,
        slug: organization.slug,
        // Null, never a fallback hex. A default here would silently replace the product palette
        // for every tenant that has branded nothing — see packages/ui/src/brand/tokens.ts.
        primaryColor: organization.branding?.primaryColor ?? null,
        loginMessage: organization.branding?.loginMessage ?? null,
        customDomain: organization.branding?.customDomain ?? null,
        logoUrl: organization.branding?.logoUrl ?? null,
      };
    });
  };
}

/**
 * Things a supervisor should look at, gathered from what the data already knows.
 *
 * Every one is phrased as an observation. "Прекъснато проследяване" says what the server saw;
 * it never asserts that a driver switched anything off, because a tunnel, a flat battery and a
 * force-quit are indistinguishable from here. See docs/tracking.md.
 */
async function collectWarnings(
  services: AppServices,
  organizationId: OrganizationId,
  now: Date,
): Promise<
  readonly {
    id: string;
    kind: string;
    subject: string;
    detail: string;
    severity: 'WARNING' | 'CRITICAL';
  }[]
> {
  const longShiftCutoff = new Date(now.getTime() - 10 * 60 * 60 * 1000);
  const expiringCutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [longShifts, interrupted, expiring] = await Promise.all([
    services.prisma.shift.findMany({
      where: {
        organizationId,
        status: { in: ['ACTIVE', 'ON_BREAK'] },
        actualStart: { lte: longShiftCutoff },
      },
      select: {
        id: true,
        actualStart: true,
        worker: { select: { firstName: true, lastName: true } },
      },
      take: 20,
    }),
    services.prisma.driverTrip.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        trackingState: { in: ['INTERRUPTED', 'OFFLINE'] },
      },
      select: {
        id: true,
        untrackedSeconds: true,
        lastPointAt: true,
        vehicle: { select: { registrationNumber: true } },
      },
      take: 20,
    }),
    services.prisma.vehicleDocument.findMany({
      // `not: null` as well as the cutoff: a document with no expiry never expires, and a null
      // would otherwise sort to the front and be reported as overdue by an unguarded date maths.
      where: { organizationId, expiresAt: { not: null, lte: expiringCutoff } },
      select: {
        id: true,
        type: true,
        expiresAt: true,
        vehicle: { select: { registrationNumber: true } },
      },
      orderBy: { expiresAt: 'asc' },
      take: 20,
    }),
  ]);

  const days = (target: Date): number =>
    Math.round((target.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

  return [
    ...longShifts.map((shift) => ({
      id: `shift-${shift.id}`,
      kind: 'LONG_SHIFT',
      subject: `${shift.worker.firstName} ${shift.worker.lastName}`,
      detail: shift.actualStart?.toISOString() ?? '',
      severity: 'CRITICAL' as const,
    })),
    ...interrupted.map((trip) => ({
      id: `trip-${trip.id}`,
      kind: 'TRACKING_INTERRUPTED',
      subject: trip.vehicle.registrationNumber,
      detail: trip.lastPointAt?.toISOString() ?? '',
      severity: 'WARNING' as const,
    })),
    ...expiring.flatMap((document) => {
      if (!document.expiresAt) return [];
      const remaining = days(document.expiresAt);
      return [
        {
          id: `doc-${document.id}`,
          kind: 'DOCUMENT_EXPIRING',
          subject: document.vehicle.registrationNumber,
          detail: `${document.type}:${remaining}`,
          severity: remaining < 0 ? ('CRITICAL' as const) : ('WARNING' as const),
        },
      ];
    }),
  ];
}

/** Production per hour across the range, zero-filled so the chart has no missing columns. */
function bucketByHour(
  entries: readonly { recordedAt: Date; goodQuantity: unknown; defectQuantity: unknown }[],
  from: Date,
  to: Date,
): readonly { hour: string; good: number; scrap: number }[] {
  const buckets = new Map<string, { good: number; scrap: number }>();

  const cursor = new Date(from);
  cursor.setMinutes(0, 0, 0);
  while (cursor <= to) {
    buckets.set(cursor.toISOString(), { good: 0, scrap: 0 });
    cursor.setHours(cursor.getHours() + 1);
  }

  for (const entry of entries) {
    const key = new Date(entry.recordedAt);
    key.setMinutes(0, 0, 0);
    const bucket = buckets.get(key.toISOString());
    if (!bucket) continue;
    bucket.good += Number(entry.goodQuantity);
    bucket.scrap += Number(entry.defectQuantity);
  }

  return [...buckets.entries()].map(([hour, value]) => ({
    hour,
    good: Math.round(value.good),
    scrap: Math.round(value.scrap),
  }));
}

function groupByWorkArea(
  entries: readonly {
    goodQuantity: unknown;
    position: { name: string; workArea: { name: string } | null };
  }[],
): readonly { name: string; produced: number }[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const name = entry.position.workArea?.name ?? '—';
    totals.set(name, (totals.get(name) ?? 0) + Number(entry.goodQuantity));
  }
  return [...totals.entries()]
    .map(([name, produced]) => ({ name, produced: Math.round(produced) }))
    .sort((a, b) => b.produced - a.produced);
}
