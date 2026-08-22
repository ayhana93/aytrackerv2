import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS, assertPermission, hashPin } from '@aytracker/auth';
import { FEATURES } from '@aytracker/billing';
import { ConflictError, NotFoundError, ValidationError } from '@aytracker/domain';
import {
  DEFAULT_STOP_OPTIONS,
  HaversineRoutingProvider,
  detectStops,
  findTrackingGaps,
} from '@aytracker/tracking';
import type { OrganizationId } from '@aytracker/types';
import {
  createPositionSchema,
  createVehicleSchema,
  createWorkAreaSchema,
  createWorkerSchema,
  updateOperationalSettingsSchema,
  updatePositionSchema,
  updateWorkAreaSchema,
  updateWorkerSchema,
} from '@aytracker/validation';
import { deriveCode } from '../lib/slug.js';
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

/**
 * How long standing still has to last before the route map marks it.
 *
 * Twenty minutes: long enough to exclude a traffic light, a level crossing and a queue at a
 * roundabout, short enough to catch a delivery, a loading bay and a coffee. The threshold lives
 * here rather than in the browser because the browser is not sent the timestamps it would need to
 * compute it — and because a figure a client can recompute is a figure a client can change.
 */
const MIN_STOP_SECONDS = 20 * 60;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function resolveRange(
  query: { from?: string; to?: string },
  now: Date,
  defaultSpanMs: number = ONE_DAY_MS,
): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - defaultSpanMs);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { from: new Date(now.getTime() - defaultSpanMs), to: now };
  }

  const span = to.getTime() - from.getTime();
  const max = MAX_RANGE_DAYS * ONE_DAY_MS;
  return { from: span > max ? new Date(to.getTime() - max) : from, to };
}

/**
 * How long a position session has run.
 *
 * `durationSeconds` is written by the server when a session closes, and it is the value to trust
 * for a closed one — a supervisor may have corrected the times, and recomputing from the
 * timestamps would silently discard that correction. An open session has no stored duration, so
 * it is measured to now and the caller is told it is still running.
 */
function elapsedSeconds(
  session: { startedAt: Date; endedAt: Date | null; durationSeconds: number | null },
  now: Date,
): number {
  if (session.durationSeconds !== null) return session.durationSeconds;
  const end = session.endedAt ?? now;
  return Math.max(0, Math.round((end.getTime() - session.startedAt.getTime()) / 1000));
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

    /**
     * Who worked where, and for how long.
     *
     * Returns both the individual sessions and a per-person roll-up, computed here. The roll-up
     * is not something the browser should derive from the rows it happens to have been sent:
     * the list is capped, so a client summing what it received would quietly report a smaller
     * total than the truth the moment an organization crosses that cap — and this is the figure
     * people use to check a payslip.
     *
     * Open sessions are included and counted up to now. Excluding them would show a worker who
     * has been on the line since 06:00 as having worked nothing today.
     */
    app.get('/history', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.SHIFTS_READ);
      const organizationId = actor.organizationId;
      const now = services.clock.now();

      const query = request.query as {
        from?: string;
        to?: string;
        workerId?: string;
        workAreaId?: string;
        limit?: string;
      };
      // A week rather than the dashboard's day: "who worked where" is a question asked about a
      // period that has finished, not about right now.
      const { from, to } = resolveRange(query, now, 7 * 24 * 60 * 60 * 1000);

      const where = {
        organizationId,
        startedAt: { gte: from, lte: to },
        ...(query.workerId ? { workerId: query.workerId } : {}),
        ...(query.workAreaId ? { position: { workAreaId: query.workAreaId } } : {}),
      };

      const sessions = await services.prisma.positionSession.findMany({
        where,
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          source: true,
          correctedAt: true,
          worker: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
          position: {
            select: { id: true, name: true, kind: true, workArea: { select: { name: true } } },
          },
        },
        orderBy: { startedAt: 'desc' },
        take: Math.min(Number(query.limit ?? 250), 1000),
      });

      /**
       * The roll-up runs over every matching row, not the page above.
       *
       * A second query rather than reusing `sessions`, because `take` caps that one. Selected
       * narrowly — four columns and no joins — so the wide read stays the capped one.
       */
      const allForTotals = await services.prisma.positionSession.findMany({
        where,
        select: {
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          workerId: true,
          worker: { select: { firstName: true, lastName: true } },
        },
      });

      const totals = new Map<
        string,
        { workerId: string; worker: string; seconds: number; sessions: number; open: boolean }
      >();
      for (const row of allForTotals) {
        const entry = totals.get(row.workerId) ?? {
          workerId: row.workerId,
          worker: `${row.worker.firstName} ${row.worker.lastName}`,
          seconds: 0,
          sessions: 0,
          open: false,
        };
        entry.seconds += elapsedSeconds(row, now);
        entry.sessions += 1;
        if (row.endedAt === null) entry.open = true;
        totals.set(row.workerId, entry);
      }

      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        sessions: sessions.map((session) => ({
          id: session.id,
          worker: `${session.worker.firstName} ${session.worker.lastName}`,
          workerId: session.worker.id,
          employeeNumber: session.worker.employeeNumber,
          position: session.position.name,
          positionKind: session.position.kind,
          workArea: session.position.workArea?.name ?? null,
          startedAt: session.startedAt.toISOString(),
          endedAt: session.endedAt?.toISOString() ?? null,
          seconds: elapsedSeconds(session, now),
          /** Still open. The duration is "so far", and the screen has to say so. */
          isOpen: session.endedAt === null,
          source: session.source,
          // Surfaced rather than hidden: a corrected row is one a supervisor changed by hand, and
          // anyone checking hours against a payslip is entitled to know which those are.
          wasCorrected: session.correctedAt !== null,
        })),
        byWorker: [...totals.values()].sort((a, b) => b.seconds - a.seconds),
        /** True when the list was capped, so the screen can say so rather than imply completeness. */
        truncated: sessions.length < allForTotals.length,
      };
    });

    /* ---------------------------------------------------------------- workers */

    /**
     * The roster: everyone who can clock in, and whether they actually can.
     *
     * `hasPin` rather than any part of the PIN itself. The hash never leaves the database, and a
     * screen that only needs to answer "can this person sign in yet" gets a boolean. `lockedUntil`
     * is here for the same reason it is on the model: a worker standing at a terminal saying "it
     * won't take my PIN" is answered by this column, not by a support call.
     */
    app.get('/workers', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKERS_READ);
      const now = services.clock.now();

      const workers = await services.prisma.worker.findMany({
        where: { organizationId: actor.organizationId, deletedAt: null },
        select: {
          id: true,
          employeeNumber: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          status: true,
          pinHash: true,
          lockedUntil: true,
          createdAt: true,
          drivers: {
            where: { deletedAt: null },
            select: { id: true, driverCode: true, status: true },
            take: 1,
          },
        },
        orderBy: [{ status: 'asc' }, { employeeNumber: 'asc' }],
      });

      return {
        workers: workers.map((worker) => {
          const driver = worker.drivers[0];
          return {
            id: worker.id,
            employeeNumber: worker.employeeNumber,
            firstName: worker.firstName,
            lastName: worker.lastName,
            email: worker.email,
            phone: worker.phone,
            status: worker.status,
            /** Whether a PIN exists — never the PIN, never the hash. */
            hasPin: worker.pinHash !== null,
            /** Locked out by failed attempts, and until when. Null once the lock has expired. */
            lockedUntil:
              worker.lockedUntil && worker.lockedUntil > now
                ? worker.lockedUntil.toISOString()
                : null,
            createdAt: worker.createdAt.toISOString(),
            driver: driver
              ? { id: driver.id, code: driver.driverCode, status: driver.status }
              : null,
          };
        }),
      };
    });

    /**
     * Add someone to the roster.
     *
     * The employee number and the PIN are both chosen here, by an admin, and handed to the person
     * — there is no self-registration for a worker and there should not be: the whole point of a
     * tenant is that its staff list is decided by the organization, not by whoever finds the URL.
     *
     * The PIN is hashed with Argon2id before the transaction opens, exactly as registration hashes
     * a password, and is never stored, logged or returned. An admin who forgets it sets a new one;
     * there is no way to read the old one back, which is the property that makes it a credential.
     */
    app.post('/workers', async (request, reply) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKERS_CREATE);
      const body = createWorkerSchema.parse(request.body);
      const organizationId = actor.organizationId;
      const now = services.clock.now();

      const duplicate = await services.prisma.worker.findFirst({
        where: { organizationId, employeeNumber: body.employeeNumber },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictError(
          'worker.employee_number_taken',
          'A worker with this employee number already exists.',
        );
      }

      const driverCode = body.isDriver ? (body.driverCode ?? body.employeeNumber) : null;
      if (driverCode) {
        const takenCode = await services.prisma.driver.findFirst({
          where: { organizationId, driverCode },
          select: { id: true },
        });
        if (takenCode) {
          throw new ConflictError('driver.code_taken', 'A driver with this code already exists.');
        }
      }

      // Hashed outside the transaction: Argon2id is deliberately slow, and holding a write
      // transaction open for the duration of a KDF is how a connection pool gets exhausted by
      // somebody entering a roster.
      const pinHash = body.pin ? await hashPin(body.pin) : null;

      const site = await services.prisma.site.findFirst({
        where: { organizationId, status: 'ACTIVE' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });

      const worker = await services.prisma.$transaction(async (tx) => {
        const created = await tx.worker.create({
          data: {
            organizationId,
            siteId: site?.id ?? null,
            employeeNumber: body.employeeNumber,
            firstName: body.firstName,
            lastName: body.lastName,
            email: body.email ?? null,
            phone: body.phone ?? null,
            pinHash,
            pinSetAt: pinHash ? now : null,
          },
          select: { id: true, employeeNumber: true, firstName: true, lastName: true, status: true },
        });

        if (driverCode) {
          await tx.driver.create({
            data: {
              organizationId,
              workerId: created.id,
              driverCode,
              firstName: body.firstName,
              lastName: body.lastName,
              // The same credential opens both doors. One person, one PIN to remember — two would
              // be two things to forget, and the second one gets written on the dashboard.
              pinHash,
              pinSetAt: pinHash ? now : null,
            },
          });
        }

        return created;
      });

      return reply.status(201).send({
        worker: {
          id: worker.id,
          employeeNumber: worker.employeeNumber,
          firstName: worker.firstName,
          lastName: worker.lastName,
          status: worker.status,
          hasPin: pinHash !== null,
          lockedUntil: null,
          driver: driverCode ? { code: driverCode } : null,
        },
      });
    });

    /**
     * Change a worker: a new PIN, a correction to a name, or deactivation.
     *
     * Setting a PIN also clears the failed-attempt counter and the lockout. That is not a
     * convenience — it is the whole reason an admin resets a PIN. Leaving someone locked out with
     * a PIN they have just been given would make the reset look broken.
     */
    app.patch('/workers/:workerId', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKERS_UPDATE);
      const { workerId } = request.params as { workerId: string };
      const body = updateWorkerSchema.parse(request.body);
      const organizationId = actor.organizationId;
      const now = services.clock.now();

      // The tenant is in the read, and the read is what authorises the write. Another
      // organization's worker is not found rather than forbidden.
      const existing = await services.prisma.worker.findFirst({
        where: { id: workerId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!existing) throw new NotFoundError('worker.not_found', 'Worker not found.');

      const pinHash = body.pin ? await hashPin(body.pin) : undefined;

      const worker = await services.prisma.$transaction(async (tx) => {
        const updated = await tx.worker.update({
          where: { id: workerId },
          data: {
            ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
            ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
            ...(body.phone === undefined ? {} : { phone: body.phone }),
            ...(body.status === undefined ? {} : { status: body.status }),
            ...(pinHash === undefined
              ? {}
              : { pinHash, pinSetAt: now, failedPinAttempts: 0, lockedUntil: null }),
          },
          select: {
            id: true,
            employeeNumber: true,
            firstName: true,
            lastName: true,
            status: true,
            pinHash: true,
          },
        });

        // A driver profile shares the worker's credential, so a reset that did not reach it would
        // leave the same person able to open one door and not the other.
        if (pinHash !== undefined || body.status !== undefined) {
          await tx.driver.updateMany({
            where: { organizationId, workerId, deletedAt: null },
            data: {
              ...(pinHash === undefined
                ? {}
                : { pinHash, pinSetAt: now, failedPinAttempts: 0, lockedUntil: null }),
              ...(body.status === undefined ? {} : { status: body.status }),
            },
          });
        }

        return updated;
      });

      return {
        worker: {
          id: worker.id,
          employeeNumber: worker.employeeNumber,
          firstName: worker.firstName,
          lastName: worker.lastName,
          status: worker.status,
          hasPin: worker.pinHash !== null,
          lockedUntil: null,
        },
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

    /**
     * Register a vehicle.
     *
     * The counterpart the fleet screen had no way to reach: `GET /vehicles` has always been able
     * to list an organization's vehicles, and until now the only way to put one in the list was a
     * seed script. A fleet screen that cannot add a vehicle is a report, not a fleet screen.
     *
     * Asks for six things and derives the rest. Registration, make and model identify it; type
     * and fuel decide how it is treated; the odometer is the number every later reading is
     * measured against, so it is easier to enter now than to correct later. Tank size, VIN,
     * consumption and notes are all real fields on the model and all optional here — a vehicle
     * someone cannot add today because the VIN is in a folder in another building is a vehicle
     * that gets tracked on paper instead.
     */
    app.post('/vehicles', async (request, reply) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.FLEET_CREATE);
      const body = createVehicleSchema.parse(request.body);
      const organizationId = actor.organizationId;

      /**
       * The site is resolved server-side, exactly as it is for a work area.
       *
       * `createVehicleSchema` accepts a `siteId` because the fleet import path needs one, but a
       * client-supplied id is never trusted here: it is checked against this tenant, and anything
       * else is treated as absent rather than as an error worth explaining to an attacker.
       */
      const site = body.siteId
        ? await services.prisma.site.findFirst({
            where: { id: body.siteId, organizationId },
            select: { id: true },
          })
        : await services.prisma.site.findFirst({
            where: { organizationId, status: 'ACTIVE' },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
          });

      // Registration numbers are unique per tenant in the schema. Checked first so the answer is
      // "this plate is already registered" rather than a constraint violation translated into a
      // generic conflict.
      const duplicate = await services.prisma.vehicle.findFirst({
        where: { organizationId, registrationNumber: body.registrationNumber },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictError(
          'vehicle.registration_taken',
          'A vehicle with this registration number is already registered.',
        );
      }

      const vehicle = await services.prisma.vehicle.create({
        data: {
          organizationId,
          siteId: site?.id ?? null,
          registrationNumber: body.registrationNumber,
          vin: body.vin,
          make: body.make,
          model: body.model,
          year: body.year,
          vehicleType: body.vehicleType,
          fuelType: body.fuelType,
          fuelTankCapacity: body.fuelTankCapacity,
          odometerCurrent: body.odometerCurrent,
          averageConsumption: body.averageConsumption,
          consumptionUnit: body.consumptionUnit,
          notes: body.notes ?? null,
        },
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
        },
      });

      // Assembled field by field rather than spread: `odometerCurrent` is a Decimal, and letting
      // one reach JSON is how a screen ends up rendering "[object Object]" for a mileage. The
      // shape below is exactly a row of `GET /vehicles`, so the browser can insert it into the
      // list it already has.
      return reply.status(201).send({
        vehicle: {
          id: vehicle.id,
          registrationNumber: vehicle.registrationNumber,
          make: vehicle.make,
          model: vehicle.model,
          vehicleType: vehicle.vehicleType,
          fuelType: vehicle.fuelType,
          status: vehicle.status,
          odometer: vehicle.odometerCurrent.toString(),
          averageConsumption: vehicle.averageConsumption?.toString() ?? null,
          // Nobody has been assigned to it yet. Stated rather than omitted, so the row is the
          // same shape as every other one.
          driver: null,
        },
      });
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

        // The trip's own points, read through the trip overlay on the shared table.
        const rows = await services.prisma.locationPoint.findMany({
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
        const stops = detectStops(points, {
          ...DEFAULT_STOP_OPTIONS,
          minDurationSeconds: MIN_STOP_SECONDS,
        });
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
          /**
           * Where the vehicle stood still for twenty minutes or more.
           *
           * The polyline cannot show this: a van parked for forty minutes and a van passing
           * through the same junction draw the same pixel. These are the places a route is
           * actually opened to find — where the day went.
           */
          stops: stops.map((stop) => ({
            latitude: stop.center.latitude,
            longitude: stop.center.longitude,
            startedAt: stop.startedAt.toISOString(),
            endedAt: stop.endedAt.toISOString(),
            seconds: stop.durationSeconds,
          })),
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

    /* ------------------------------------------------- work areas & positions */

    /**
     * The organization's structure: every work area with the positions inside it.
     *
     * Returned as one nested tree rather than two flat lists, because that is the shape of the
     * question. A screen that fetched areas and positions separately would have to join them in
     * the browser and would render an area with no positions during the gap between the two
     * responses — which looks exactly like an area that has none.
     *
     * `occupied` is live: how many people are standing on that position right now. It is the
     * difference between a configuration screen and an operations one.
     */
    app.get('/areas', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.POSITIONS_READ);
      const organizationId = actor.organizationId;

      const [areas, openSessions] = await Promise.all([
        services.prisma.workArea.findMany({
          where: { organizationId, status: { not: 'ARCHIVED' } },
          select: {
            id: true,
            name: true,
            code: true,
            description: true,
            status: true,
            positions: {
              where: { status: { not: 'ARCHIVED' } },
              select: {
                id: true,
                name: true,
                code: true,
                kind: true,
                capacity: true,
                status: true,
              },
              orderBy: { name: 'asc' },
            },
          },
          orderBy: { name: 'asc' },
        }),
        services.prisma.positionSession.groupBy({
          by: ['positionId'],
          where: { organizationId, endedAt: null },
          _count: { _all: true },
        }),
      ]);

      const occupancy = new Map(openSessions.map((row) => [row.positionId, row._count._all]));

      return {
        areas: areas.map((area) => ({
          id: area.id,
          name: area.name,
          code: area.code,
          description: area.description,
          status: area.status,
          positions: area.positions.map((position) => ({
            id: position.id,
            name: position.name,
            code: position.code,
            kind: position.kind,
            capacity: position.capacity,
            status: position.status,
            occupied: occupancy.get(position.id) ?? 0,
          })),
        })),
      };
    });

    /** Create a work area. */
    app.post('/areas', async (request, reply) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.POSITIONS_MANAGE);
      const body = createWorkAreaSchema.parse(request.body);
      const organizationId = actor.organizationId;

      /**
       * The site is resolved server-side, never sent.
       *
       * Most organizations have exactly one, and asking someone to pick it before they can name a
       * zone is a question with one possible answer. Multi-site organizations get a site picker
       * when they get a second site — until then this is the honest simplification, not a
       * limitation being hidden.
       */
      const site = await services.prisma.site.findFirst({
        where: { organizationId, status: 'ACTIVE' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!site) {
        throw new ValidationError(
          'site.missing',
          'This organization has no site to attach a work area to.',
        );
      }

      const code = await uniqueAreaCode(services, organizationId, site.id, body.code ?? body.name);

      const area = await services.prisma.workArea.create({
        data: {
          organizationId,
          siteId: site.id,
          name: body.name,
          code,
          description: body.description ?? null,
        },
        select: { id: true, name: true, code: true, description: true, status: true },
      });

      return reply.status(201).send({ area: { ...area, positions: [] } });
    });

    /** Rename or archive a work area. */
    app.patch('/areas/:areaId', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.POSITIONS_MANAGE);
      const { areaId } = request.params as { areaId: string };
      const body = updateWorkAreaSchema.parse(request.body);
      const organizationId = actor.organizationId;

      // Tenant is in the read, and the read is what authorises the write. Another organization's
      // area is not found rather than forbidden.
      const existing = await services.prisma.workArea.findFirst({
        where: { id: areaId, organizationId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundError('work_area.not_found', 'Work area not found.');

      if (body.status === 'ARCHIVED') {
        // Archiving an area with live positions would hide the position a worker is standing on
        // from every picker while they are still on it.
        const active = await services.prisma.position.count({
          where: { organizationId, workAreaId: areaId, status: 'ACTIVE' },
        });
        if (active > 0) {
          throw new ConflictError(
            'work_area.has_positions',
            'Archive or move the positions in this area first.',
          );
        }
      }

      const area = await services.prisma.workArea.update({
        where: { id: areaId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.status === undefined ? {} : { status: body.status }),
        },
        select: { id: true, name: true, code: true, description: true, status: true },
      });

      return { area };
    });

    /** Create a position inside a work area. */
    app.post('/positions', async (request, reply) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.POSITIONS_MANAGE);
      const body = createPositionSchema.parse(request.body);
      const organizationId = actor.organizationId;

      // The area lookup carries the tenant, so the site id below is one this organization owns —
      // which is what stops a caller planting a position in someone else's site by id.
      const area = await services.prisma.workArea.findFirst({
        where: { id: body.workAreaId, organizationId, status: 'ACTIVE' },
        select: { id: true, siteId: true },
      });
      if (!area) throw new NotFoundError('work_area.not_found', 'Work area not found.');

      const code = await uniquePositionCode(services, organizationId, body.code ?? body.name);

      const position = await services.prisma.position.create({
        data: {
          organizationId,
          siteId: area.siteId,
          workAreaId: area.id,
          name: body.name,
          code,
          kind: body.kind,
          capacity: body.capacity ?? null,
        },
        select: {
          id: true,
          name: true,
          code: true,
          kind: true,
          capacity: true,
          status: true,
          workAreaId: true,
        },
      });

      return reply.status(201).send({ position: { ...position, occupied: 0 } });
    });

    /** Rename, move, retype or archive a position. */
    app.patch('/positions/:positionId', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.POSITIONS_MANAGE);
      const { positionId } = request.params as { positionId: string };
      const body = updatePositionSchema.parse(request.body);
      const organizationId = actor.organizationId;

      const existing = await services.prisma.position.findFirst({
        where: { id: positionId, organizationId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundError('position.not_found', 'Position not found.');

      if (body.workAreaId) {
        const area = await services.prisma.workArea.findFirst({
          where: { id: body.workAreaId, organizationId, status: 'ACTIVE' },
          select: { id: true },
        });
        if (!area) throw new NotFoundError('work_area.not_found', 'Work area not found.');
      }

      if (body.status === 'ARCHIVED') {
        // Someone is standing on it. Archiving now would remove the position from under a live
        // session and leave a shift that cannot be closed against anything.
        const open = await services.prisma.positionSession.count({
          where: { organizationId, positionId, endedAt: null },
        });
        if (open > 0) {
          throw new ConflictError(
            'position.occupied',
            'Somebody is working on this position right now.',
          );
        }
      }

      const position = await services.prisma.position.update({
        where: { id: positionId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.workAreaId === undefined ? {} : { workAreaId: body.workAreaId }),
          ...(body.kind === undefined ? {} : { kind: body.kind }),
          ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
          ...(body.status === undefined ? {} : { status: body.status }),
        },
        select: {
          id: true,
          name: true,
          code: true,
          kind: true,
          capacity: true,
          status: true,
          workAreaId: true,
        },
      });

      return { position };
    });

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

    /* ------------------------------------------------------------------- live */

    /**
     * Everyone and everything currently being tracked, in one query.
     *
     * The live map's only read. It goes to `tracking_sessions` rather than assembling employees
     * and vehicles separately, because a session is already the answer to "who is reporting right
     * now" — one indexed row per marker, carrying the last fix and the derived state.
     *
     * Every figure here is the server's. The browser places markers; it never computes a
     * distance, a speed or a staleness.
     */
    app.get('/live', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.FLEET_TRACKING_READ);
      const now = services.clock.now();

      const sessions = await services.prisma.trackingSession.findMany({
        where: { organizationId: actor.organizationId, endedAt: null },
        select: {
          id: true,
          context: true,
          startedAt: true,
          distanceMeters: true,
          trackingState: true,
          lastPointAt: true,
          lastLatitude: true,
          lastLongitude: true,
          lastSpeedMps: true,
          lastAccuracyMeters: true,
          batteryLevel: true,
          devicePermission: true,
          worker: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
          driver: { select: { id: true, driverCode: true } },
          vehicle: { select: { id: true, registrationNumber: true, make: true, model: true } },
          shift: {
            select: {
              status: true,
              positionSessions: {
                where: { endedAt: null },
                select: { position: { select: { name: true } } },
                take: 1,
              },
            },
          },
          trip: {
            select: {
              id: true,
              label: true,
              startedAt: true,
              distanceMeters: true,
              vehicle: { select: { registrationNumber: true, make: true, model: true } },
            },
          },
        },
        orderBy: { startedAt: 'asc' },
        take: 500,
      });

      /**
       * A worker who is driving produces one session, not two.
       *
       * The trip is folded into the same row, so the map shows one marker for one person and can
       * label it with the vehicle they are in. Two markers for one phone would be the clearest
       * possible symptom of the duplicate pipeline this design avoids.
       *
       * `session.trip` only exists on a DRIVER_TRIP session — the trip is the reason that session
       * was opened. A WORK session never points at a trip, because the trip is an overlay on the
       * day rather than the thing being tracked. So for the common case — an employee who clocked
       * in and later took a van — the running trip has to be looked up by subject, not read off
       * the session. Without this the map shows the person and not the vehicle, on exactly the
       * screen that exists to answer "who has which van, and where is it".
       */
      const workerIds = sessions.flatMap((session) => (session.worker ? [session.worker.id] : []));
      const runningTrips = workerIds.length
        ? await services.prisma.driverTrip.findMany({
            where: {
              organizationId: actor.organizationId,
              endedAt: null,
              startedAt: { not: null },
              driver: { workerId: { in: workerIds } },
            },
            select: {
              id: true,
              label: true,
              startedAt: true,
              distanceMeters: true,
              driver: { select: { workerId: true } },
              vehicle: { select: { registrationNumber: true, make: true, model: true } },
            },
          })
        : [];
      const tripByWorker = new Map(
        runningTrips.flatMap((trip) =>
          trip.driver.workerId ? [[trip.driver.workerId, trip]] : [],
        ),
      );

      return {
        serverTime: now.toISOString(),
        subjects: sessions.map((session) => {
          const trip =
            session.trip ?? (session.worker ? (tripByWorker.get(session.worker.id) ?? null) : null);
          const vehicle = trip?.vehicle ?? session.vehicle ?? null;
          const secondsSinceFix = session.lastPointAt
            ? Math.max(0, Math.round((now.getTime() - session.lastPointAt.getTime()) / 1000))
            : null;

          return {
            id: session.id,
            context: session.context,
            name: session.worker
              ? `${session.worker.firstName} ${session.worker.lastName}`
              : (session.driver?.driverCode ?? 'Шофьор'),
            employeeNumber: session.worker?.employeeNumber ?? null,
            /** Where they are standing, when they are not in a vehicle. */
            position: session.shift?.positionSessions[0]?.position.name ?? null,
            onBreak: session.shift?.status === 'ON_BREAK',
            startedAt: session.startedAt.toISOString(),
            distanceMeters: session.distanceMeters,
            /**
             * The state as the server observes it, never as an accusation. A silent phone is
             * INTERRUPTED — which covers a tunnel, a flat battery and a force-quit equally,
             * because from here they are the same thing.
             */
            trackingState: session.trackingState,
            lastPointAt: session.lastPointAt?.toISOString() ?? null,
            secondsSinceFix,
            latitude: session.lastLatitude === null ? null : Number(session.lastLatitude),
            longitude: session.lastLongitude === null ? null : Number(session.lastLongitude),
            speedKph:
              session.lastSpeedMps === null ? null : Math.round(Number(session.lastSpeedMps) * 3.6),
            accuracyMeters:
              session.lastAccuracyMeters === null ? null : Number(session.lastAccuracyMeters),
            batteryLevel: session.batteryLevel === null ? null : Number(session.batteryLevel),
            devicePermission: session.devicePermission,
            vehicle: vehicle
              ? {
                  registrationNumber: vehicle.registrationNumber,
                  make: vehicle.make,
                  model: vehicle.model,
                }
              : null,
            trip: trip
              ? {
                  id: trip.id,
                  label: trip.label,
                  startedAt: trip.startedAt?.toISOString() ?? null,
                  distanceMeters: trip.distanceMeters,
                }
              : null,
            /**
             * Whether the position on the map is the *vehicle's* or merely the phone's.
             *
             * A phone in a driver's pocket is not the van. Saying which is which is the
             * difference between a fact and an assumption somebody will act on.
             */
            positionSource: 'DEVICE' as const,
          };
        }),
      };
    });

    /**
     * One employee's working day, on a map.
     *
     * The working route and the trips inside it, from one stream of points. `tripId` on each
     * point is what separates the segments — so a day reads as WORK → DRIVER_TRIP → WORK without
     * anything being recorded twice.
     *
     * Gaps are returned explicitly and the renderer breaks the line at them. There is no version
     * of this data where a straight line is drawn across nineteen minutes nobody can account for.
     */
    app.get('/live/:sessionId/track', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.FLEET_TRACKING_READ);
      const { sessionId } = request.params as { sessionId: string };
      const now = services.clock.now();

      const session = await services.prisma.trackingSession.findFirst({
        where: { id: sessionId, organizationId: actor.organizationId },
        select: {
          id: true,
          context: true,
          startedAt: true,
          endedAt: true,
          distanceMeters: true,
          untrackedSeconds: true,
          worker: { select: { firstName: true, lastName: true } },
        },
      });
      if (!session) {
        throw new NotFoundError('tracking.session_not_found', 'Tracking session not found.');
      }

      const rows = await services.prisma.locationPoint.findMany({
        where: { organizationId: actor.organizationId, trackingSessionId: session.id },
        select: {
          timestamp: true,
          latitude: true,
          longitude: true,
          accuracyMeters: true,
          speedMps: true,
          tripId: true,
        },
        orderBy: { timestamp: 'asc' },
      });

      const points = rows.map((row) => ({
        timestamp: row.timestamp,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        accuracyMeters: row.accuracyMeters === null ? null : Number(row.accuracyMeters),
        speedMps: row.speedMps === null ? null : Number(row.speedMps),
        tripId: row.tripId,
      }));

      const track = await new HaversineRoutingProvider().reconstruct(points);
      const gaps = findTrackingGaps({
        pointTimestamps: points.map((point) => point.timestamp),
        tripStartedAt: session.startedAt,
        tripEndedAt: session.endedAt,
        now,
      });
      const stops = detectStops(points, {
        ...DEFAULT_STOP_OPTIONS,
        minDurationSeconds: MIN_STOP_SECONDS,
      });

      /**
       * The day, split into the segments a person would describe it in.
       *
       * Consecutive points sharing a trip id are one DRIVER_TRIP segment; the rest is WORK. This
       * is derived rather than stored, because the points already say it and a second
       * representation would be a second thing to keep true.
       */
      const segments: {
        context: 'WORK' | 'DRIVER_TRIP';
        tripId: string | null;
        from: string;
        to: string;
        pointCount: number;
      }[] = [];
      for (const point of points) {
        const last = segments.at(-1);
        if (last && last.tripId === point.tripId) {
          last.to = point.timestamp.toISOString();
          last.pointCount += 1;
          continue;
        }
        segments.push({
          context: point.tripId ? 'DRIVER_TRIP' : 'WORK',
          tripId: point.tripId,
          from: point.timestamp.toISOString(),
          to: point.timestamp.toISOString(),
          pointCount: 1,
        });
      }

      return {
        session: {
          id: session.id,
          context: session.context,
          worker: session.worker ? `${session.worker.firstName} ${session.worker.lastName}` : null,
          startedAt: session.startedAt.toISOString(),
          endedAt: session.endedAt?.toISOString() ?? null,
          distanceMeters: session.distanceMeters,
          untrackedSeconds: session.untrackedSeconds,
        },
        track: {
          points: track.points.map((point) => ({
            latitude: point.latitude,
            longitude: point.longitude,
          })),
          distanceMeters: track.distanceMeters,
          /** Draw a break after each of these indices. Never a straight line across. */
          gapAfterIndices: track.gapAfterIndices,
          pointCount: track.points.length,
        },
        segments,
        stops: stops.map((stop) => ({
          latitude: stop.center.latitude,
          longitude: stop.center.longitude,
          startedAt: stop.startedAt.toISOString(),
          endedAt: stop.endedAt.toISOString(),
          seconds: stop.durationSeconds,
        })),
        gaps: gaps.map((gap) => ({
          startedAt: gap.startedAt.toISOString(),
          endedAt: gap.endedAt?.toISOString() ?? null,
          seconds: gap.seconds,
          isOpen: gap.endedAt === null,
        })),
      };
    });

    /* --------------------------------------------------------------- settings */

    /**
     * The settings that decide how the product behaves for this organization.
     *
     * The fuel price is the one that matters most and the one that had nowhere to live: without
     * it the driver's screen and every cost report can compute litres and nothing else. A
     * hardcoded national average would have been worse than an empty field — it produces a
     * number that looks authoritative and is invented.
     */
    app.get('/settings', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.SETTINGS_READ);

      const [settings, organization] = await Promise.all([
        services.prisma.organizationSettings.findUnique({
          where: { organizationId: actor.organizationId },
          select: {
            fuelPricePerLiter: true,
            allowWorkerSelfShiftStart: true,
            maxShiftDurationMinutes: true,
            gpsMinIntervalSeconds: true,
            gpsMinDistanceMeters: true,
          },
        }),
        services.prisma.organization.findUnique({
          where: { id: actor.organizationId },
          select: { defaultCurrency: true, defaultTimezone: true },
        }),
      ]);

      return {
        // A Decimal reaching JSON renders as an object; a price has to travel as a string.
        fuelPricePerLiter: settings?.fuelPricePerLiter?.toString() ?? null,
        currency: organization?.defaultCurrency ?? 'EUR',
        timezone: organization?.defaultTimezone ?? 'Europe/Sofia',
        allowWorkerSelfShiftStart: settings?.allowWorkerSelfShiftStart ?? true,
        maxShiftDurationMinutes: settings?.maxShiftDurationMinutes ?? 960,
        gpsMinIntervalSeconds: settings?.gpsMinIntervalSeconds ?? 15,
        gpsMinDistanceMeters: settings?.gpsMinDistanceMeters ?? 50,
      };
    });

    app.patch('/settings', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.SETTINGS_UPDATE);
      const body = updateOperationalSettingsSchema.parse(request.body);

      /**
       * Upserted, because a settings row may not exist yet.
       *
       * Registration creates one, but an organization seeded or imported before it did would
       * otherwise fail here with a record-not-found on the first save — which reads as "settings
       * are broken" rather than "there was nothing to update".
       */
      const settings = await services.prisma.organizationSettings.upsert({
        where: { organizationId: actor.organizationId },
        create: {
          organizationId: actor.organizationId,
          ...(body.fuelPricePerLiter !== undefined
            ? { fuelPricePerLiter: body.fuelPricePerLiter }
            : {}),
          ...(body.allowWorkerSelfShiftStart !== undefined
            ? { allowWorkerSelfShiftStart: body.allowWorkerSelfShiftStart }
            : {}),
          ...(body.maxShiftDurationMinutes !== undefined
            ? { maxShiftDurationMinutes: body.maxShiftDurationMinutes }
            : {}),
          ...(body.gpsMinIntervalSeconds !== undefined
            ? { gpsMinIntervalSeconds: body.gpsMinIntervalSeconds }
            : {}),
          ...(body.gpsMinDistanceMeters !== undefined
            ? { gpsMinDistanceMeters: body.gpsMinDistanceMeters }
            : {}),
        },
        // Only what the request carried. A patch that omits a field must not reset it to a
        // default the caller never mentioned.
        update: {
          ...(body.fuelPricePerLiter !== undefined
            ? { fuelPricePerLiter: body.fuelPricePerLiter }
            : {}),
          ...(body.allowWorkerSelfShiftStart !== undefined
            ? { allowWorkerSelfShiftStart: body.allowWorkerSelfShiftStart }
            : {}),
          ...(body.maxShiftDurationMinutes !== undefined
            ? { maxShiftDurationMinutes: body.maxShiftDurationMinutes }
            : {}),
          ...(body.gpsMinIntervalSeconds !== undefined
            ? { gpsMinIntervalSeconds: body.gpsMinIntervalSeconds }
            : {}),
          ...(body.gpsMinDistanceMeters !== undefined
            ? { gpsMinDistanceMeters: body.gpsMinDistanceMeters }
            : {}),
        },
        select: {
          fuelPricePerLiter: true,
          allowWorkerSelfShiftStart: true,
          maxShiftDurationMinutes: true,
          gpsMinIntervalSeconds: true,
          gpsMinDistanceMeters: true,
        },
      });

      const organization = await services.prisma.organization.findUnique({
        where: { id: actor.organizationId },
        select: { defaultCurrency: true, defaultTimezone: true },
      });

      return {
        fuelPricePerLiter: settings.fuelPricePerLiter?.toString() ?? null,
        currency: organization?.defaultCurrency ?? 'EUR',
        timezone: organization?.defaultTimezone ?? 'Europe/Sofia',
        allowWorkerSelfShiftStart: settings.allowWorkerSelfShiftStart,
        maxShiftDurationMinutes: settings.maxShiftDurationMinutes,
        gpsMinIntervalSeconds: settings.gpsMinIntervalSeconds,
        gpsMinDistanceMeters: settings.gpsMinDistanceMeters,
      };
    });
  };
}

/**
 * A code nobody in this organization is using yet.
 *
 * Derived from the name so the common case needs no input, then suffixed until it is free. The
 * unique index is still the authority — this loop only keeps ordinary use from colliding with
 * it, and a caller who loses a genuine race gets a 409 rather than a silently mangled code.
 *
 * Work-area codes are unique per (organization, site); position codes per organization. The two
 * helpers differ only in that scope, and keeping them separate is what stops the wrong one being
 * used against the wrong index.
 */
async function uniqueAreaCode(
  services: AppServices,
  organizationId: OrganizationId,
  siteId: string,
  source: string,
): Promise<string> {
  const base = deriveCode(source) || 'AREA';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}${attempt + 1}`;
    const taken = await services.prisma.workArea.findFirst({
      where: { organizationId, siteId, code: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `${base}${Date.now().toString(36).toUpperCase()}`;
}

async function uniquePositionCode(
  services: AppServices,
  organizationId: OrganizationId,
  source: string,
): Promise<string> {
  const base = deriveCode(source) || 'POS';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}${attempt + 1}`;
    const taken = await services.prisma.position.findFirst({
      where: { organizationId, code: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `${base}${Date.now().toString(36).toUpperCase()}`;
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
