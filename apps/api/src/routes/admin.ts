import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PERMISSIONS, assertPermission, hashPin } from '@aytracker/auth';
import { FEATURES } from '@aytracker/billing';
import { ConflictError, NotFoundError, ValidationError } from '@aytracker/domain';
import {
  DEFAULT_STOP_OPTIONS,
  HaversineRoutingProvider,
  deriveTrackingState,
  detectStops,
  findTrackingGaps,
  type TrackingState,
} from '@aytracker/tracking';
import type { OrganizationId } from '@aytracker/types';
import {
  createGeofenceSchema,
  createPositionSchema,
  createVehicleSchema,
  createWorkAreaSchema,
  createWorkerSchema,
  rangeOnlyQuerySchema,
  selectLogoSchema,
  tripListQuerySchema,
  updateGeofenceSchema,
  updateMemberEmailSchema,
  updateOperationalSettingsSchema,
  updateOrganizationProfileSchema,
  updatePositionSchema,
  updateWorkAreaSchema,
  updateWorkerSchema,
  uploadLogoSchema,
  workHistoryQuerySchema,
} from '@aytracker/validation';
import { displayName, logoAssetUrl } from '../lib/branding.js';
import { MAX_LOGO_BYTES, decodeBase64Image, sniffImageType } from '../lib/image.js';
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

/**
 * The operational settings, in one place.
 *
 * Named rather than repeated at each of the three sites that need them (the read, the write, and
 * the write's response), because the failure mode of repeating them is a field that saves and
 * then does not come back — which reads to the user as "it didn't save".
 */
const SETTINGS_FIELDS = {
  fuelPricePerLiter: true,
  allowWorkerSelfShiftStart: true,
  maxShiftDurationMinutes: true,
  gpsMinIntervalSeconds: true,
  gpsMinDistanceMeters: true,
  speedLimitKph: true,
  speedSustainedSeconds: true,
  speedCooldownSeconds: true,
  geofenceExitHysteresisMeters: true,
  geofenceDebounceSeconds: true,
} as const;

type SettingsRow = {
  fuelPricePerLiter: { toString(): string } | null;
  allowWorkerSelfShiftStart: boolean;
  maxShiftDurationMinutes: number;
  gpsMinIntervalSeconds: number;
  gpsMinDistanceMeters: number;
  speedLimitKph: number | null;
  speedSustainedSeconds: number;
  speedCooldownSeconds: number;
  geofenceExitHysteresisMeters: number;
  geofenceDebounceSeconds: number;
};

function presentSettings(
  settings: SettingsRow | null,
  organization: { defaultCurrency: string; defaultTimezone: string } | null,
) {
  return {
    // A Decimal reaching JSON renders as an object; a price has to travel as a string.
    fuelPricePerLiter: settings?.fuelPricePerLiter?.toString() ?? null,
    currency: organization?.defaultCurrency ?? 'EUR',
    timezone: organization?.defaultTimezone ?? 'Europe/Sofia',
    allowWorkerSelfShiftStart: settings?.allowWorkerSelfShiftStart ?? true,
    maxShiftDurationMinutes: settings?.maxShiftDurationMinutes ?? 960,
    gpsMinIntervalSeconds: settings?.gpsMinIntervalSeconds ?? 15,
    gpsMinDistanceMeters: settings?.gpsMinDistanceMeters ?? 50,
    /** Null means no speed alerting. It is not a placeholder for a default limit. */
    speedLimitKph: settings?.speedLimitKph ?? null,
    speedSustainedSeconds: settings?.speedSustainedSeconds ?? 30,
    speedCooldownSeconds: settings?.speedCooldownSeconds ?? 600,
    geofenceExitHysteresisMeters: settings?.geofenceExitHysteresisMeters ?? 40,
    geofenceDebounceSeconds: settings?.geofenceDebounceSeconds ?? 90,
  };
}

/**
 * The keys the caller actually sent.
 *
 * `undefined` means "not mentioned" and is dropped; `null` means "clear this" and is kept. Zod
 * has already decided which fields may be null, so the distinction survives all the way to the
 * update rather than being flattened by a spread.
 */
function definedOnly<T extends Record<string, unknown>>(body: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * The window a report covers, from an already-validated query.
 *
 * It takes `Date`s rather than strings on purpose: whether the caller's input was a date at all
 * is a validation question, answered by the schema at the route with a 400. This function only
 * decides what an *absent* bound means and how wide a window is allowed to be — neither of which
 * is an error, and both of which are echoed back in the response as `range`.
 *
 * A range wider than the cap is narrowed rather than refused. `from` moves forward to the cap;
 * `to` is what the caller asked for, so "the last year" answers about the most recent 92 days
 * rather than the oldest.
 */
function resolveRange(
  query: { from?: Date; to?: Date },
  now: Date,
  defaultSpanMs: number = ONE_DAY_MS,
): { from: Date; to: Date } {
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - defaultSpanMs);

  const span = to.getTime() - from.getTime();
  const max = MAX_RANGE_DAYS * ONE_DAY_MS;
  return { from: span > max ? new Date(to.getTime() - max) : from, to };
}

/**
 * What an open tracking session's state actually is, right now.
 *
 * `tracking_sessions.trackingState` is written by ingestion, so it only ever changes when a point
 * arrives — and the one case that matters most is the case where none does. A device that stops
 * reporting leaves the column frozen at ACTIVE, and every screen that reads it then asserts the
 * phone is fine for as long as the session stays open. `detectInterruptions` exists to age these
 * rows and nothing schedules it yet, so the read derives the state from the same observable facts
 * the sweep would have used: how long since the last fix, how accurate it was, and what the device
 * last said about itself.
 *
 * `deviceReported` is deliberately null. The column records what the device said when it last
 * managed to say something; replaying "OFFLINE" from an hour ago would present a stale claim as a
 * current one, and silence is already the thing being measured.
 */
function observedState(
  session: {
    lastPointAt: Date | null;
    lastAccuracyMeters: { toString(): string } | null;
  },
  now: Date,
): TrackingState {
  return deriveTrackingState({
    // An open session is the tracking equivalent of an active trip: it is running, and what is in
    // question is whether anything is arriving through it.
    tripStatus: 'ACTIVE',
    lastPointAt: session.lastPointAt,
    lastPointAccuracyMeters:
      session.lastAccuracyMeters === null ? null : Number(session.lastAccuracyMeters),
    deviceReported: null,
    now,
  });
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
      const { from, to } = resolveRange(rangeOnlyQuerySchema.parse(request.query ?? {}), now);

      /**
       * Every figure here is aggregated by PostgreSQL.
       *
       * It used to read the range's production entries and trips row by row and reduce them in
       * Node — four sums, a count, an hourly bucketing and a group-by, over a window the caller
       * may set to 92 days. On a factory recording a few thousand entries a day that is hundreds
       * of thousands of rows, each with a joined position and work area, pulled across the wire
       * so the process could add up two columns. The database does that work in the index this
       * table already has on (organizationId, recordedAt), and returns one row per hour.
       */
      const [openSessions, hourly, byWorkArea, trips, warnings] = await Promise.all([
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
        productionByHour(services, organizationId, from, to),
        productionByWorkArea(services, organizationId, from, to),
        services.prisma.driverTrip.aggregate({
          where: { organizationId, startedAt: { gte: from, lte: to } },
          _count: { _all: true },
          _sum: { distanceMeters: true, untrackedSeconds: true },
        }),
        collectWarnings(services, organizationId, now),
      ]);

      // Summed from the hourly series rather than by a third query: every entry in the range
      // falls in one of those buckets, so the two cannot disagree the way two queries could.
      const totalGood = hourly.reduce((sum, bucket) => sum + bucket.good, 0);
      const totalScrap = hourly.reduce((sum, bucket) => sum + bucket.scrap, 0);

      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        totals: {
          producedGood: Math.round(totalGood),
          producedScrap: Math.round(totalScrap),
          activeWorkers: new Set(openSessions.map((s) => s.id)).size,
          trips: trips._count._all,
          distanceMeters: trips._sum.distanceMeters ?? 0,
          // Reported rather than hidden. A shift with tracking holes is a shift whose distance
          // is a floor, and the person reading the dashboard should know that.
          untrackedSeconds: trips._sum.untrackedSeconds ?? 0,
        },
        hourly: zeroFillHours(hourly, from, to),
        byWorkArea,
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

      const query = workHistoryQuerySchema.parse(request.query ?? {});
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
        take: query.limit,
      });

      /**
       * The roll-up runs over every matching row, not the page above — this is the figure people
       * hold next to a payslip, and a client summing the page it happened to receive would report
       * a smaller total than the truth the moment an organization crosses the cap.
       *
       * "Every matching row" used to mean reading every matching row: a second, uncapped
       * `findMany` over a window the caller may set to 92 days. The three reads below say the
       * same thing without that:
       *
       *   * closed sessions are summed by the database, one row per worker;
       *   * open ones are read individually, because their duration is "so far" and only the
       *     server's clock knows it — and there are at most as many as there are people, which
       *     the `position_sessions_one_open_per_worker` index makes a guarantee rather than an
       *     assumption;
       *   * the count is what decides whether the page above was truncated.
       *
       * `durationSeconds` is written on every close and every correction, so a row with an end
       * time always has one. Splitting on `endedAt` therefore partitions the rows exactly, and
       * the total is the same figure the row-by-row version produced.
       */
      const [closedTotals, openSessions, matchingCount] = await Promise.all([
        services.prisma.positionSession.groupBy({
          by: ['workerId'],
          where: { ...where, endedAt: { not: null } },
          _sum: { durationSeconds: true },
          _count: { _all: true },
        }),
        services.prisma.positionSession.findMany({
          where: { ...where, endedAt: null },
          select: { workerId: true, startedAt: true, endedAt: true, durationSeconds: true },
        }),
        services.prisma.positionSession.count({ where }),
      ]);

      const totals = new Map<
        string,
        { workerId: string; worker: string; seconds: number; sessions: number; open: boolean }
      >();
      const touch = (workerId: string) => {
        const entry = totals.get(workerId) ?? {
          workerId,
          worker: '',
          seconds: 0,
          sessions: 0,
          open: false,
        };
        totals.set(workerId, entry);
        return entry;
      };

      for (const row of closedTotals) {
        const entry = touch(row.workerId);
        entry.seconds += row._sum.durationSeconds ?? 0;
        entry.sessions += row._count._all;
      }
      for (const session of openSessions) {
        const entry = touch(session.workerId);
        entry.seconds += elapsedSeconds(session, now);
        entry.sessions += 1;
        entry.open = true;
      }

      // Names for the roll-up, in one read keyed on the workers who actually appear in it.
      const named = await services.prisma.worker.findMany({
        where: { organizationId, id: { in: [...totals.keys()] } },
        select: { id: true, firstName: true, lastName: true },
      });
      for (const worker of named) {
        const entry = totals.get(worker.id);
        if (entry) entry.worker = `${worker.firstName} ${worker.lastName}`;
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
        truncated: sessions.length < matchingCount,
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

      /**
       * Deactivating someone, or changing their credential, ends the sessions they already hold.
       *
       * Permissions are snapshotted onto the session row so authorization is one indexed read —
       * and the price of that, stated in ADR 0005, is that anything which changes what a person
       * may do has to revoke their sessions explicitly. Nothing did. A worker marked INACTIVE
       * kept a fully valid session for the rest of its 16-hour life: they could still clock in,
       * move between positions and stream their location, because the request path reads the
       * snapshot and never re-reads the worker's status. The same held for a PIN reset — the old
       * PIN stopped working, and the phone that was already signed in carried on regardless,
       * which is the case where the reset was the point.
       *
       * Deliberately outside the transaction above and awaited before responding: the write that
       * matters is the status change, and an admin must not be told "deactivated" until the
       * sessions are actually gone. A driver profile shares the person, so it shares the sweep.
       */
      const deactivated = body.status !== undefined && body.status !== 'ACTIVE';
      const credentialChanged = pinHash !== undefined;
      if (deactivated || credentialChanged) {
        const reason = deactivated ? 'worker.deactivated' : 'worker.pin_reset';
        await services.sessions.revokeForActor({ workerId }, reason, now);
        for (const driver of await services.prisma.driver.findMany({
          where: { organizationId, workerId },
          select: { id: true },
        })) {
          await services.sessions.revokeForActor({ driverId: driver.id }, reason, now);
        }
      }

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
        /**
         * True when this change signed the person out of the devices they were using. The screen
         * has to be able to say so: an admin resetting a PIN mid-shift has just stopped that
         * worker's phone reporting until they sign in again with the new one.
         */
        sessionsRevoked: deactivated || credentialChanged,
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
      const query = tripListQuerySchema.parse(request.query ?? {});
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
        take: query.limit,
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
            /**
             * How many vertices the line has — not how many rows the table holds. The screen
             * prints this beside the map, and a count that included fixes too inaccurate to be
             * drawn would claim more evidence than the picture shows.
             */
            pointCount: route.points.length,
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
        companyName: displayName(organization, organization.branding),
        slug: organization.slug,
        // Null, never a fallback hex. A default here would silently replace the product palette
        // for every tenant that has branded nothing — see packages/ui/src/brand/tokens.ts.
        primaryColor: organization.branding?.primaryColor ?? null,
        loginMessage: organization.branding?.loginMessage ?? null,
        customDomain: organization.branding?.customDomain ?? null,
        logoUrl: resolveLogoUrl(services, organization.branding),
      };
    });

    /* ------------------------------------------------------ organization ---- */

    /**
     * The organization as its own admin sees it.
     *
     * The slug is here and is read-only, which is the whole point of showing it: it is what every
     * worker in the building types to sign in, so an admin needs to be able to read it out — and
     * must not be able to change it from a settings form, because doing so locks out everybody
     * holding the old one.
     */
    app.get('/organization', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.ORGANIZATION_READ);

      const organization = await services.prisma.organization.findUniqueOrThrow({
        where: { id: actor.organizationId },
        select: {
          name: true,
          legalName: true,
          slug: true,
          status: true,
          countryCode: true,
          defaultTimezone: true,
          trialEndsAt: true,
          createdAt: true,
          branding: { select: { companyName: true, logoAssetId: true } },
        },
      });

      return {
        organization: {
          name: organization.name,
          legalName: organization.legalName,
          slug: organization.slug,
          status: organization.status,
          countryCode: organization.countryCode,
          timezone: organization.defaultTimezone,
          trialEndsAt: organization.trialEndsAt?.toISOString() ?? null,
          createdAt: organization.createdAt.toISOString(),
          displayName: displayName(organization, organization.branding),
          logoUrl: resolveLogoUrl(services, organization.branding),
        },
      };
    });

    /**
     * Renaming the organization.
     *
     * The name is not decoration: it is what the sidebar, both login screens and every portal
     * header show, replacing the product name, so this one field re-brands the whole tenant. It
     * is audited for that reason — "why does it say something else this morning" has to have an
     * answer.
     */
    app.patch('/organization', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.ORGANIZATION_UPDATE);
      const body = updateOrganizationProfileSchema.parse(request.body);

      const before = await services.prisma.organization.findUniqueOrThrow({
        where: { id: actor.organizationId },
        select: { name: true, legalName: true },
      });

      const organization = await services.prisma.organization.update({
        where: { id: actor.organizationId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.legalName === undefined ? {} : { legalName: body.legalName || null }),
        },
        select: {
          name: true,
          legalName: true,
          slug: true,
          branding: { select: { companyName: true, logoAssetId: true } },
        },
      });

      await recordAudit(services, request, actor, {
        action: 'organization.updated',
        entityType: 'organization',
        entityId: actor.organizationId,
        metadata: {
          before: { name: before.name, legalName: before.legalName },
          after: { name: organization.name, legalName: organization.legalName },
        },
      });

      return {
        organization: {
          name: organization.name,
          legalName: organization.legalName,
          slug: organization.slug,
          displayName: displayName(organization, organization.branding),
          logoUrl: resolveLogoUrl(services, organization.branding),
        },
      };
    });

    /* ------------------------------------------------------------- logos ---- */

    /** Every logo this organization has uploaded, newest first, with the chosen one marked. */
    app.get('/branding/logos', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.BRANDING_READ);

      const [logos, branding] = await Promise.all([
        services.prisma.organizationLogo.findMany({
          where: { organizationId: actor.organizationId },
          // `data` is deliberately absent: a gallery of ten logos must not pull five megabytes of
          // bytes through the API to render ten thumbnails that are fetched by URL anyway.
          select: {
            id: true,
            fileName: true,
            contentType: true,
            byteSize: true,
            createdAt: true,
            uploadedBy: { select: { firstName: true, lastName: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 60,
        }),
        services.prisma.organizationBranding.findUnique({
          where: { organizationId: actor.organizationId },
          select: { logoAssetId: true },
        }),
      ]);

      return {
        activeLogoId: branding?.logoAssetId ?? null,
        logos: logos.map((logo) => ({
          id: logo.id,
          fileName: logo.fileName,
          contentType: logo.contentType,
          byteSize: logo.byteSize,
          createdAt: logo.createdAt.toISOString(),
          uploadedBy: logo.uploadedBy
            ? `${logo.uploadedBy.firstName ?? ''} ${logo.uploadedBy.lastName ?? ''}`.trim() || null
            : null,
          url: logoAssetUrl(services.config.env.API_URL, logo.id),
          isActive: logo.id === (branding?.logoAssetId ?? null),
        })),
      };
    });

    /**
     * Uploading a logo.
     *
     * The declared file type is not read at all — the bytes decide, and anything that is not a
     * PNG, JPEG, GIF or WebP is refused rather than stored. An SVG loses here on purpose: it is a
     * script container, and this asset is served from our own origin onto the tenant's login
     * page. See `lib/image.ts` and docs/white-label.md § 4.
     *
     * Re-uploading a file the organization already has returns the existing asset instead of a
     * second copy. An admin who uploads the same logo twice meant to select it, not to collect it.
     */
    app.post('/branding/logos', async (request, reply) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.BRANDING_UPDATE);
      const body = uploadLogoSchema.parse(request.body);

      const bytes = decodeBase64Image(body.data);
      if (!bytes) {
        throw new ValidationError('branding.logo_unreadable', 'That file could not be read.');
      }
      if (bytes.byteLength > MAX_LOGO_BYTES) {
        throw new ValidationError(
          'branding.logo_too_large',
          `A logo may be at most ${Math.floor(MAX_LOGO_BYTES / 1024)} KB.`,
        );
      }

      const contentType = sniffImageType(bytes);
      if (!contentType) {
        throw new ValidationError(
          'branding.logo_unsupported_type',
          'Use a PNG, JPEG, WebP or GIF image. SVG files are not accepted.',
        );
      }

      const checksum = createHash('sha256').update(bytes).digest('hex');

      const existing = await services.prisma.organizationLogo.findUnique({
        where: { organizationId_checksum: { organizationId: actor.organizationId, checksum } },
        select: { id: true, fileName: true, contentType: true, byteSize: true, createdAt: true },
      });

      const logo =
        existing ??
        (await services.prisma.organizationLogo.create({
          data: {
            organizationId: actor.organizationId,
            fileName: body.fileName,
            contentType,
            byteSize: bytes.byteLength,
            checksum,
            data: Buffer.from(bytes),
            uploadedByUserId: actor.userId ?? null,
          },
          select: { id: true, fileName: true, contentType: true, byteSize: true, createdAt: true },
        }));

      if (body.activate) {
        await selectLogo(services, actor.organizationId, logo.id);
      }

      await recordAudit(services, request, actor, {
        action: existing ? 'branding.logo_reused' : 'branding.logo_uploaded',
        entityType: 'organization_logo',
        entityId: logo.id,
        metadata: {
          fileName: logo.fileName,
          contentType,
          byteSize: logo.byteSize,
          activated: body.activate,
        },
      });

      return reply.status(existing ? 200 : 201).send({
        logo: {
          id: logo.id,
          fileName: logo.fileName,
          contentType: logo.contentType,
          byteSize: logo.byteSize,
          createdAt: logo.createdAt.toISOString(),
          url: logoAssetUrl(services.config.env.API_URL, logo.id),
          isActive: body.activate,
        },
      });
    });

    /**
     * Choosing which uploaded logo the organization shows.
     *
     * `logoId: null` clears it, and clearing is a real choice rather than an undo: a tenant that
     * has decided to show no logo falls back to its initial and its name, not to the product's.
     */
    app.post('/branding/logo', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.BRANDING_UPDATE);
      const body = selectLogoSchema.parse(request.body);

      if (body.logoId !== null) {
        // Scoped by organization in the query itself: another tenant's logo id is *not found*
        // here, never "forbidden", because confirming it exists elsewhere is itself the leak.
        const owned = await services.prisma.organizationLogo.findFirst({
          where: { id: body.logoId, organizationId: actor.organizationId },
          select: { id: true },
        });
        if (!owned) throw new NotFoundError('branding.logo_not_found', 'No such logo.');
      }

      await selectLogo(services, actor.organizationId, body.logoId);

      await recordAudit(services, request, actor, {
        action: 'branding.logo_selected',
        entityType: 'organization_logo',
        entityId: body.logoId,
        metadata: { logoId: body.logoId },
      });

      return {
        activeLogoId: body.logoId,
        logoUrl: body.logoId ? logoAssetUrl(services.config.env.API_URL, body.logoId) : null,
      };
    });

    /** Removing an uploaded logo. Deleting the chosen one leaves the organization with none. */
    app.delete('/branding/logos/:logoId', async (request, reply) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.BRANDING_UPDATE);
      const { logoId } = request.params as { logoId: string };

      const logo = await services.prisma.organizationLogo.findFirst({
        where: { id: logoId, organizationId: actor.organizationId },
        select: { id: true, fileName: true },
      });
      if (!logo) throw new NotFoundError('branding.logo_not_found', 'No such logo.');

      // The foreign key is ON DELETE SET NULL, so the branding row is cleared by the database
      // rather than by a second statement that could be skipped or fail on its own.
      await services.prisma.organizationLogo.delete({ where: { id: logo.id } });

      await recordAudit(services, request, actor, {
        action: 'branding.logo_deleted',
        entityType: 'organization_logo',
        entityId: logo.id,
        metadata: { fileName: logo.fileName },
      });

      return reply.status(204).send();
    });

    /* ----------------------------------------------------------- members ---- */

    /**
     * The people with a management seat in this organization.
     *
     * Members, not users: the same person may hold accounts in several organizations, and this
     * tenant may only see the membership it owns. Nothing here reaches a user outside it.
     */
    app.get('/members', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.USERS_MANAGE);

      const members = await services.prisma.organizationMember.findMany({
        where: { organizationId: actor.organizationId },
        select: {
          id: true,
          status: true,
          joinedAt: true,
          role: { select: { code: true, name: true } },
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              isActive: true,
              isPlatformAdmin: true,
              lastLoginAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });

      return {
        members: members.map((member) => ({
          id: member.id,
          userId: member.user.id,
          email: member.user.email,
          firstName: member.user.firstName,
          lastName: member.user.lastName,
          roleCode: member.role.code,
          roleName: member.role.name,
          status: member.status,
          isActive: member.user.isActive,
          /**
           * Whether this account is also a platform administrator — someone who administers
           * AYtracker itself, not this organization. The email of such an account is not the
           * tenant's to change, and the screen has to be able to say so rather than offering a
           * button that will be refused.
           */
          isPlatformAdmin: member.user.isPlatformAdmin,
          isSelf: member.user.id === actor.userId,
          lastLoginAt: member.user.lastLoginAt?.toISOString() ?? null,
          joinedAt: member.joinedAt?.toISOString() ?? null,
        })),
      };
    });

    /**
     * Changing an organization administrator's email address.
     *
     * The address *is* the login identity, so this is an account change and not a profile edit,
     * and three limits follow from that:
     *
     *   * **Only a member of this organization.** The row is found by (id, organizationId); a
     *     membership elsewhere is not found, so no tenant can reach another tenant's user.
     *   * **Never a platform administrator.** That account administers the product, not this
     *     customer, and letting a tenant admin move its login address would hand them the
     *     platform.
     *   * **The target's sessions end.** `credentialsChangedAt` is what invalidates sessions
     *     issued before it, and an identity change is exactly the case it exists for — including
     *     when an admin changes their own address, which signs them out here and back in as who
     *     they now are.
     */
    app.patch('/members/:memberId/email', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.USERS_MANAGE);
      const { memberId } = request.params as { memberId: string };
      const body = updateMemberEmailSchema.parse(request.body);

      const member = await services.prisma.organizationMember.findFirst({
        where: { id: memberId, organizationId: actor.organizationId },
        select: { id: true, user: { select: { id: true, email: true, isPlatformAdmin: true } } },
      });
      if (!member) throw new NotFoundError('members.not_found', 'No such member.');

      if (member.user.isPlatformAdmin) {
        throw new ValidationError(
          'members.platform_admin_immutable',
          'This account administers the platform; its email is not managed here.',
        );
      }

      if (member.user.email === body.email) {
        return { member: { id: member.id, email: member.user.email }, signedOut: false };
      }

      const taken = await services.prisma.user.findUnique({
        where: { email: body.email },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictError('auth.email_taken', 'That email address is already registered.');
      }

      const previousEmail = member.user.email;
      const now = services.clock.now();

      await services.prisma.user.update({
        where: { id: member.user.id },
        data: { email: body.email, credentialsChangedAt: now },
      });

      await recordAudit(services, request, actor, {
        action: 'member.email_changed',
        entityType: 'organization_member',
        entityId: member.id,
        // The old address is kept because "who moved this account, and from where" is the whole
        // question when an account changes hands.
        metadata: { userId: member.user.id, before: previousEmail, after: body.email },
      });

      return {
        member: { id: member.id, email: body.email },
        /** True when the caller just signed themselves out. The screen has to act on it. */
        signedOut: member.user.id === actor.userId,
      };
    });

    /* ------------------------------------------------------------------- live */

    /**
     * The workforce, counted.
     *
     * "How many people work here, how many are working right now, how many are on break" — the
     * question a manager asks before any other, and the one that needs no map to answer.
     *
     * Counted in the database rather than by summing a page of rows in the browser. The lists on
     * these screens are capped; a client adding up what it happened to receive would quietly
     * report a smaller workforce the moment an organization outgrew the cap, and it is the sort
     * of wrong number nobody notices because it looks plausible.
     *
     * `notReporting` deserves its own line rather than being folded into "working". Someone whose
     * phone has gone quiet is still at work — the honest statement is that we cannot currently see
     * where, and hiding that inside a green count is how a tracking product starts lying.
     */
    app.get('/workforce', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKERS_READ);
      const organizationId = actor.organizationId;
      const now = services.clock.now();

      const [employed, shifts, sessions] = await Promise.all([
        services.prisma.worker.count({ where: { organizationId, status: 'ACTIVE' } }),
        services.prisma.shift.groupBy({
          by: ['status'],
          where: { organizationId, status: { in: ['ACTIVE', 'ON_BREAK'] } },
          _count: { _all: true },
        }),
        services.prisma.trackingSession.findMany({
          where: { organizationId, endedAt: null },
          // `lastPointAt` and `lastAccuracyMeters` rather than the stored `trackingState`: that
          // column is only written when a point arrives, so a device that went quiet at lunch
          // would still be counted in the green number all afternoon. See `observedState`.
          select: {
            context: true,
            lastPointAt: true,
            lastAccuracyMeters: true,
            tripId: true,
            workerId: true,
          },
          take: 1000,
        }),
      ]);

      const byStatus = new Map(shifts.map((row) => [row.status, row._count._all]));
      const onShift = byStatus.get('ACTIVE') ?? 0;
      const onBreak = byStatus.get('ON_BREAK') ?? 0;

      const driving = await services.prisma.driverTrip.count({
        where: { organizationId, endedAt: null, startedAt: { not: null } },
      });

      /** Reporting means a fix arrived recently enough to be current. The rest are silent. */
      const reporting = sessions.filter((session) => {
        const state = observedState(session, now);
        return state === 'ACTIVE' || state === 'DEGRADED';
      }).length;

      return {
        serverTime: now.toISOString(),
        counts: {
          /** Everyone on the books. */
          employed,
          /** Clocked in and not on a break. */
          working: onShift,
          onBreak,
          /** Of those at work, how many are out in a vehicle. */
          driving,
          /** Sessions open and currently sending. */
          reporting,
          /**
           * Open sessions that have gone quiet. Not an accusation: a tunnel, a flat battery and
           * a force-quit are the same thing from here.
           */
          notReporting: sessions.length - reporting,
          /** At work with no tracking session at all — a shift started on a device that has none. */
          untracked: Math.max(0, onShift + onBreak - sessions.length),
        },
      };
    });

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
             *
             * Derived here against the clock rather than read off the column. The stored value is
             * only ever written by an ingest, so a phone that stops reporting leaves it frozen at
             * whatever it last was: the map showed a green dot for a device that died at lunch,
             * which is worse than showing nothing because somebody believes it. The scheduled
             * sweep that was meant to age these rows has no scheduler yet — see
             * docs/production-audit.md — and a map that tells the truth must not wait for one.
             */
            trackingState: observedState(session, now),
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
          select: SETTINGS_FIELDS,
        }),
        services.prisma.organization.findUnique({
          where: { id: actor.organizationId },
          select: { defaultCurrency: true, defaultTimezone: true },
        }),
      ]);

      return presentSettings(settings, organization);
    });

    app.patch('/settings', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.SETTINGS_UPDATE);
      const body = updateOperationalSettingsSchema.parse(request.body);

      /**
       * Only what the request carried.
       *
       * A patch that omits a field must not reset it to a default the caller never mentioned —
       * and `speedLimitKph` makes that more than a nicety: it is explicitly nullable, so
       * "absent" and "set to null" mean different things. Absent leaves the limit alone; null
       * turns speed alerting off.
       */
      const changes = definedOnly(body);

      /*
       * Upserted, because a settings row may not exist yet. Registration creates one, but an
       * organization seeded or imported before it did would otherwise fail here with a
       * record-not-found on the first save — which reads as "settings are broken" rather than
       * "there was nothing to update".
       */
      const settings = await services.prisma.organizationSettings.upsert({
        where: { organizationId: actor.organizationId },
        create: { organizationId: actor.organizationId, ...changes },
        update: changes,
        select: SETTINGS_FIELDS,
      });

      const organization = await services.prisma.organization.findUnique({
        where: { id: actor.organizationId },
        select: { defaultCurrency: true, defaultTimezone: true },
      });

      return presentSettings(settings, organization);
    });

    /**
     * Geofences: the places this organization cares about arriving at.
     *
     * Managed here rather than derived from sites, because most of them are customers rather
     * than premises — and a dispatcher adding "the new warehouse on the ring road" should not
     * have to create a site, a work area and a position to do it.
     */
    app.get('/geofences', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.SETTINGS_READ);

      const fences = await services.prisma.geofence.findMany({
        where: { organizationId: actor.organizationId },
        select: {
          id: true,
          name: true,
          kind: true,
          centerLatitude: true,
          centerLongitude: true,
          radiusMeters: true,
          isActive: true,
          notes: true,
          site: { select: { id: true, name: true } },
          _count: { select: { visits: true } },
        },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        take: 500,
      });

      return {
        geofences: fences.map((fence) => ({
          id: fence.id,
          name: fence.name,
          kind: fence.kind,
          latitude: Number(fence.centerLatitude),
          longitude: Number(fence.centerLongitude),
          radiusMeters: fence.radiusMeters,
          isActive: fence.isActive,
          notes: fence.notes,
          site: fence.site,
          visitCount: fence._count.visits,
        })),
      };
    });

    app.post('/geofences', async (request, reply) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.SETTINGS_UPDATE);
      const body = createGeofenceSchema.parse(request.body);

      if (body.siteId) {
        // Checked here for a decent error; the composite tenant foreign key is what actually
        // makes borrowing another organization's site impossible.
        const site = await services.prisma.site.findFirst({
          where: { id: body.siteId, organizationId: actor.organizationId },
          select: { id: true },
        });
        if (!site) throw new NotFoundError('site.not_found', 'Site not found.');
      }

      const fence = await services.prisma.geofence.create({
        data: {
          organizationId: actor.organizationId,
          name: body.name,
          kind: body.kind,
          centerLatitude: body.latitude.toFixed(6),
          centerLongitude: body.longitude.toFixed(6),
          radiusMeters: body.radiusMeters,
          siteId: body.siteId ?? null,
          notes: body.notes ?? null,
        },
        select: { id: true, name: true, kind: true, radiusMeters: true },
      });

      reply.code(201);
      return { geofence: fence };
    });

    app.patch('/geofences/:geofenceId', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.SETTINGS_UPDATE);
      const { geofenceId } = request.params as { geofenceId: string };
      const body = updateGeofenceSchema.parse(request.body);

      const existing = await services.prisma.geofence.findFirst({
        where: { id: geofenceId, organizationId: actor.organizationId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundError('geofence.not_found', 'Geofence not found.');

      const fence = await services.prisma.geofence.update({
        where: { id: geofenceId },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.latitude !== undefined ? { centerLatitude: body.latitude.toFixed(6) } : {}),
          ...(body.longitude !== undefined ? { centerLongitude: body.longitude.toFixed(6) } : {}),
          ...(body.radiusMeters !== undefined ? { radiusMeters: body.radiusMeters } : {}),
          ...(body.siteId !== undefined ? { siteId: body.siteId } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
        select: { id: true, name: true, kind: true, radiusMeters: true, isActive: true },
      });

      return { geofence: fence };
    });

    /**
     * Who is where, right now, and who was where today.
     *
     * An open visit — no exit — is the live answer. Deliberately no "estimated" exits: a device
     * that went quiet inside a fence is reported as still inside, because that is the last thing
     * the record actually supports.
     */
    app.get('/geofences/:geofenceId/visits', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.FLEET_TRACKING_READ);
      const { geofenceId } = request.params as { geofenceId: string };
      const now = services.clock.now();
      const { from, to } = resolveRange(rangeOnlyQuerySchema.parse(request.query ?? {}), now);

      const visits = await services.prisma.geofenceVisit.findMany({
        where: {
          organizationId: actor.organizationId,
          geofenceId,
          enteredAt: { gte: from, lte: to },
        },
        select: {
          id: true,
          enteredAt: true,
          exitedAt: true,
          dwellSeconds: true,
          tripId: true,
          trackingSession: {
            select: {
              context: true,
              worker: { select: { firstName: true, lastName: true, employeeNumber: true } },
              driver: { select: { driverCode: true } },
            },
          },
        },
        orderBy: { enteredAt: 'desc' },
        take: 500,
      });

      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        visits: visits.map((visit) => ({
          id: visit.id,
          who: visit.trackingSession.worker
            ? `${visit.trackingSession.worker.firstName} ${visit.trackingSession.worker.lastName}`
            : (visit.trackingSession.driver?.driverCode ?? '—'),
          employeeNumber: visit.trackingSession.worker?.employeeNumber ?? null,
          context: visit.trackingSession.context,
          enteredAt: visit.enteredAt.toISOString(),
          exitedAt: visit.exitedAt?.toISOString() ?? null,
          dwellSeconds: visit.dwellSeconds,
          tripId: visit.tripId,
          /** Still there as far as the record goes — not "unknown", and not a guessed exit. */
          isOpen: visit.exitedAt === null,
        })),
      };
    });
  };
}

/**
 * Writes the chosen logo onto the branding row, creating that row if the organization has never
 * branded anything.
 *
 * An upsert rather than an update: `OrganizationBranding` is created lazily, so the first logo a
 * customer picks is very often the first branding they have set at all.
 */
async function selectLogo(
  services: AppServices,
  organizationId: OrganizationId,
  logoId: string | null,
): Promise<void> {
  await services.prisma.organizationBranding.upsert({
    where: { organizationId },
    create: { organizationId, logoAssetId: logoId },
    update: { logoAssetId: logoId },
  });
}

/** The chosen logo's URL, falling back to an externally hosted one for a customer who has one. */
function resolveLogoUrl(
  services: AppServices,
  branding: { logoAssetId?: string | null; logoUrl?: string | null } | null,
): string | null {
  if (branding?.logoAssetId) return logoAssetUrl(services.config.env.API_URL, branding.logoAssetId);
  return branding?.logoUrl ?? null;
}

/**
 * One audit row, written after the change it describes.
 *
 * Deliberately not inside the transaction that made the change: an audit write that can fail the
 * operation turns a logging problem into an outage, and the operations recorded here are settings
 * changes rather than money. The trade is that a crash between the two loses the record, which is
 * why the *content* of the change is also visible in the row it changed.
 */
async function recordAudit(
  services: AppServices,
  request: FastifyRequest,
  actor: { organizationId: OrganizationId; userId?: string | undefined },
  entry: {
    action: string;
    entityType: string;
    entityId: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await services.prisma.auditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorUserId: actor.userId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata as never,
      ipAddress: request.ip,
      userAgent:
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      requestId: request.id,
    },
  });
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

interface HourBucket {
  readonly hour: string;
  readonly good: number;
  readonly scrap: number;
}

/**
 * Production per hour, grouped by PostgreSQL.
 *
 * Raw SQL rather than `groupBy`, for one reason Prisma cannot express: the grouping key is
 * `date_trunc('hour', …)`, not a column. Written in one tagged template, so the tenant and the
 * range are bound parameters and cannot be concatenated into SQL text.
 *
 * `AT TIME ZONE 'UTC'` and `to_char` rather than returning a timestamp: `date_trunc` is evaluated
 * in the *session's* time zone, so without it the chart's columns would shift whenever the
 * database server's default changed, and the buckets would stop lining up with the ISO strings
 * the zero-fill produces. The string built here is exactly what `Date.toISOString()` returns.
 */
async function productionByHour(
  services: AppServices,
  organizationId: OrganizationId,
  from: Date,
  to: Date,
): Promise<readonly HourBucket[]> {
  const rows = await services.prisma.$queryRaw<
    { hour: string; good: number; scrap: number }[]
  >`SELECT to_char(
             date_trunc('hour', "recordedAt" AT TIME ZONE 'UTC'),
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )                                AS hour,
           SUM("goodQuantity")::float8      AS good,
           SUM("defectQuantity")::float8    AS scrap
      FROM "production_entries"
     WHERE "organizationId" = ${organizationId}
       AND "recordedAt" >= ${from}
       AND "recordedAt" <= ${to}
     GROUP BY 1
     ORDER BY 1`;

  return rows.map((row) => ({
    hour: row.hour,
    good: Number(row.good),
    scrap: Number(row.scrap),
  }));
}

/**
 * Production per work area, grouped by PostgreSQL.
 *
 * The tenant is repeated on the joins as well as the filter. The composite foreign keys already
 * make a cross-tenant position unrepresentable, so this cannot change the result — it is here
 * because a hand-written join is the one place in this file where that guarantee is not being
 * applied by the query builder, and an unscoped join is how it would be lost.
 */
async function productionByWorkArea(
  services: AppServices,
  organizationId: OrganizationId,
  from: Date,
  to: Date,
): Promise<readonly { name: string; produced: number }[]> {
  const rows = await services.prisma.$queryRaw<
    { name: string; produced: number }[]
  >`SELECT COALESCE(area."name", '—')      AS name,
           SUM(entry."goodQuantity")::float8 AS produced
      FROM "production_entries" entry
      JOIN "positions" position
        ON position."id" = entry."positionId"
       AND position."organizationId" = entry."organizationId"
      LEFT JOIN "work_areas" area
        ON area."id" = position."workAreaId"
       AND area."organizationId" = entry."organizationId"
     WHERE entry."organizationId" = ${organizationId}
       AND entry."recordedAt" >= ${from}
       AND entry."recordedAt" <= ${to}
     GROUP BY 1
     ORDER BY 2 DESC`;

  return rows.map((row) => ({ name: row.name, produced: Math.round(Number(row.produced)) }));
}

/**
 * Fills in the hours nothing was produced, so the chart has no missing columns.
 *
 * An hour with no rows and an hour with zero output look the same to a reader, and a chart that
 * simply omits the quiet hours compresses the night shift into the day one.
 *
 * UTC throughout, deliberately: these keys have to match the ones the SQL produced, and a bucket
 * boundary that moved with the API process's `TZ` would put the same entry in different hours on
 * two machines serving the same organization.
 */
function zeroFillHours(
  buckets: readonly HourBucket[],
  from: Date,
  to: Date,
): readonly HourBucket[] {
  const found = new Map(buckets.map((bucket) => [bucket.hour, bucket]));
  const filled: HourBucket[] = [];

  const cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);
  while (cursor <= to) {
    const hour = cursor.toISOString();
    const bucket = found.get(hour);
    filled.push({
      hour,
      good: Math.round(bucket?.good ?? 0),
      scrap: Math.round(bucket?.scrap ?? 0),
    });
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  return filled;
}
