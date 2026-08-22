import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PERMISSIONS, assertPermission } from '@aytracker/auth';
import { FEATURES } from '@aytracker/billing';
import { hashRequestBody } from '@aytracker/module-shifts';
import { endTripSchema, startTripSchema, submitLocationsSchema } from '@aytracker/validation';
import { DEFAULT_SAMPLING_POLICY, estimateFuel } from '@aytracker/tracking';
import type {
  ClientActionId,
  CurrencyCode,
  DriverId,
  TripId,
  VehicleId,
  WorkerId,
} from '@aytracker/types';
import { ForbiddenError, NotFoundError } from '@aytracker/domain';
import type { TrackingSessionId } from '@aytracker/module-tracking';
import type { AppServices } from '../services/container.js';

/**
 * /api/v1/driver — the driver portal.
 *
 * Same shape as the worker portal and for the same reason: the driver comes from the session,
 * never from the request. A driver id appears nowhere in a request body in this file.
 *
 * Location ingestion is rate limited far more generously than the rest of the API — it is the
 * one endpoint expected to be called every few seconds by every active driver — but it is
 * limited, because "high frequency" and "unbounded" are different things.
 *
 * There is no pause endpoint. See `PERMISSIONS.DRIVER_*` for why: a trip records from start to
 * end, and the only two things a driver can do to it are begin it and finish it.
 */

const IDEMPOTENCY_TTL_SECONDS = 48 * 60 * 60;

/**
 * What a trip has cost in fuel so far, as an estimate.
 *
 * Returns null rather than a zero whenever an input is missing. A vehicle with no recorded
 * consumption and an organization that has never entered a fuel price cannot produce a cost, and
 * showing "0.00 лв." for that is worse than showing nothing — one is an absence, the other is a
 * claim. `isEstimate` travels with the number so no screen can render it as a real expense.
 */
function fuelEstimateFor(input: {
  distanceMeters: number;
  averageConsumption: unknown;
  consumptionUnit: string;
  pricePerLiter: unknown;
  currency: string;
}): { liters: number; cost: string | null; currency: string; pricePerLiter: string | null } | null {
  const consumption = input.averageConsumption === null ? null : Number(input.averageConsumption);
  if (consumption === null || !Number.isFinite(consumption) || consumption <= 0) return null;

  const price = input.pricePerLiter === null ? null : String(input.pricePerLiter);

  // Litres are knowable from consumption alone; the cost additionally needs a price. Splitting
  // them means a customer who has told us the vehicle drinks 8 L/100 km still sees litres.
  const estimate = estimateFuel({
    distanceMeters: input.distanceMeters,
    averageConsumption: consumption,
    consumptionUnit: input.consumptionUnit as 'L_PER_100KM',
    pricePerLiter: price ?? '1',
    currency: input.currency as CurrencyCode,
  });

  return {
    liters: estimate.liters,
    cost: price === null ? null : estimate.cost.amount,
    currency: input.currency,
    pricePerLiter: price,
  };
}

export function driverRoutes(services: AppServices): FastifyPluginAsync {
  return async (app) => {
    // Accepts a driver who logged in here, and a worker whose session is currently elevated by
    // an open driving position. Both carry `actor.driverId`; neither can be a plain worker.
    app.addHook('preHandler', app.requireDriverContext());
    app.addHook('preHandler', app.requireEntitlement(FEATURES.DRIVER_PORTAL));

    async function idempotent<T>(
      request: FastifyRequest,
      clientActionId: ClientActionId,
      endpoint: string,
      body: unknown,
      run: () => Promise<T>,
    ): Promise<T | unknown> {
      const actor = app.requireAuth(request);
      const claim = await services.idempotency.claim({
        organizationId: actor.organizationId,
        actorType: actor.actorType,
        actorId: actor.driverId!,
        clientActionId,
        endpoint,
        requestHash: hashRequestBody(body),
        ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
      });
      if (claim.replayed) return claim.response;

      try {
        const result = await run();
        await services.idempotency.complete({
          organizationId: actor.organizationId,
          actorType: actor.actorType,
          actorId: actor.driverId!,
          clientActionId,
          response: result,
          status: 200,
        });
        return result;
      } catch (error) {
        await services.idempotency.release({
          organizationId: actor.organizationId,
          actorType: actor.actorType,
          actorId: actor.driverId!,
          clientActionId,
        });
        throw error;
      }
    }

    /**
     * The driver's home screen, in one request.
     *
     * Everything the screen renders is here, already decided: which vehicle, whether a trip is
     * running, how far it has gone, what that has cost in fuel. The device holds no state of its
     * own beyond the points still queued for upload — reload the page mid-route and the same
     * screen comes back, because the screen was never the record.
     */
    app.get('/state', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_PORTAL_ACCESS);
      const now = services.clock.now();

      const [driver, assignment, trip, settings, organization, trackingSession] = await Promise.all(
        [
          services.prisma.driver.findFirst({
            where: { id: actor.driverId!, organizationId: actor.organizationId },
            select: {
              id: true,
              driverCode: true,
              worker: { select: { firstName: true, lastName: true } },
            },
          }),
          services.prisma.vehicleAssignment.findFirst({
            where: {
              organizationId: actor.organizationId,
              driverId: actor.driverId!,
              endedAt: null,
            },
            select: {
              startedAt: true,
              vehicle: {
                select: {
                  id: true,
                  registrationNumber: true,
                  make: true,
                  model: true,
                  fuelType: true,
                  odometerCurrent: true,
                  averageConsumption: true,
                  consumptionUnit: true,
                },
              },
            },
          }),
          services.prisma.driverTrip.findFirst({
            where: {
              organizationId: actor.organizationId,
              driverId: actor.driverId!,
              status: { in: ['ACTIVE', 'PAUSED'] },
            },
            select: {
              id: true,
              label: true,
              plannedDistanceMeters: true,
              status: true,
              startedAt: true,
              distanceMeters: true,
              durationSeconds: true,
              trackingState: true,
              lastPointAt: true,
            },
          }),
          services.prisma.organizationSettings.findUnique({
            where: { organizationId: actor.organizationId },
            select: {
              gpsMinIntervalSeconds: true,
              gpsMinDistanceMeters: true,
              fuelPricePerLiter: true,
            },
          }),
          services.prisma.organization.findUnique({
            where: { id: actor.organizationId },
            select: { defaultCurrency: true },
          }),
          services.prisma.trackingSession.findFirst({
            where: {
              organizationId: actor.organizationId,
              endedAt: null,
              OR: [
                { context: 'DRIVER_TRIP', driverId: actor.driverId! },
                ...(actor.workerId ? [{ context: 'WORK' as const, workerId: actor.workerId }] : []),
              ],
            },
            select: { id: true },
            orderBy: { context: 'asc' },
          }),
        ],
      );

      const vehicle = assignment?.vehicle ?? null;
      const fuel =
        trip && vehicle
          ? fuelEstimateFor({
              distanceMeters: trip.distanceMeters,
              averageConsumption: vehicle.averageConsumption,
              consumptionUnit: vehicle.consumptionUnit,
              pricePerLiter: settings?.fuelPricePerLiter ?? null,
              currency: organization?.defaultCurrency ?? 'EUR',
            })
          : null;

      return {
        /**
         * The server's clock, sent with every read.
         *
         * Every elapsed time on the driver's screen is measured against this rather than against
         * the device's own clock. A tablet three hours out of sync would otherwise render a trip
         * that started a minute ago as three hours long — which is exactly the number a driver
         * then disputes, correctly.
         */
        serverTime: now.toISOString(),
        driver: driver
          ? {
              id: driver.id,
              code: driver.driverCode,
              firstName: driver.worker?.firstName ?? null,
              lastName: driver.worker?.lastName ?? null,
            }
          : null,
        vehicle: vehicle
          ? {
              id: vehicle.id,
              registrationNumber: vehicle.registrationNumber,
              make: vehicle.make,
              model: vehicle.model,
              fuelType: vehicle.fuelType,
              odometerCurrent: vehicle.odometerCurrent.toString(),
              averageConsumption:
                vehicle.averageConsumption === null ? null : vehicle.averageConsumption.toString(),
              consumptionUnit: vehicle.consumptionUnit,
              assignedSince: assignment!.startedAt.toISOString(),
            }
          : null,
        trip: trip
          ? {
              id: trip.id,
              label: trip.label,
              plannedDistanceMeters: trip.plannedDistanceMeters,
              status: trip.status,
              startedAt: trip.startedAt?.toISOString() ?? null,
              distanceMeters: trip.distanceMeters,
              durationSeconds: trip.durationSeconds,
              trackingState: trip.trackingState,
              lastPointAt: trip.lastPointAt?.toISOString() ?? null,
            }
          : null,
        /**
         * Fuel for the distance covered so far, and never anything else.
         *
         * An estimate, flagged as one, computed from the vehicle's recorded consumption and the
         * organization's fuel price. Null when either is missing, so the screen shows nothing
         * rather than a confident zero.
         */
        fuel,
        /**
         * Where this device should send its points.
         *
         * Resolved here rather than assumed by the client: a worker driving during their shift
         * reports into the working day's session, and a driver who signed in at the driver door
         * reports into the trip's own. One id, decided by the server, either way.
         */
        trackingSessionId: trackingSession?.id ?? null,
        /**
         * The sampling policy the device should follow. Sent from the server so it can be tuned
         * per organization without shipping a new client — and treated as a floor on ingestion,
         * so a client that ignores it gains nothing.
         */
        samplingPolicy: {
          ...DEFAULT_SAMPLING_POLICY,
          minIntervalSeconds:
            settings?.gpsMinIntervalSeconds ?? DEFAULT_SAMPLING_POLICY.minIntervalSeconds,
          minDistanceMeters:
            settings?.gpsMinDistanceMeters ?? DEFAULT_SAMPLING_POLICY.minDistanceMeters,
        },
      };
    });

    /**
     * The vehicles this driver may take right now.
     *
     * Filtered server-side, like every list in this product: out of service, sold, deleted, or
     * held by another driver, and it is not sent. A driver cannot start a trip on a vehicle that
     * is missing from this list, because `startTrip` re-decides the same thing rather than
     * trusting that the client only ever chooses from what it was shown.
     *
     * The vehicle they drove most recently sorts first — on most mornings that turns a list into
     * a confirmation.
     */
    app.get('/vehicles', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_VEHICLE_VIEW);

      const [vehicles, recent] = await Promise.all([
        services.prisma.vehicle.findMany({
          where: {
            organizationId: actor.organizationId,
            deletedAt: null,
            status: 'ACTIVE',
            // Either free, or already this driver's.
            OR: [
              { assignments: { none: { endedAt: null } } },
              { assignments: { some: { endedAt: null, driverId: actor.driverId! } } },
            ],
          },
          select: {
            id: true,
            registrationNumber: true,
            make: true,
            model: true,
            vehicleType: true,
            fuelType: true,
            odometerCurrent: true,
            assignments: {
              where: { endedAt: null },
              select: { driverId: true },
              take: 1,
            },
          },
          orderBy: { registrationNumber: 'asc' },
          take: 200,
        }),
        services.prisma.driverTrip.findFirst({
          where: { organizationId: actor.organizationId, driverId: actor.driverId! },
          select: { vehicleId: true },
          orderBy: { startedAt: 'desc' },
        }),
      ]);

      const rows = vehicles.map((vehicle) => ({
        id: vehicle.id,
        registrationNumber: vehicle.registrationNumber,
        make: vehicle.make,
        model: vehicle.model,
        vehicleType: vehicle.vehicleType,
        fuelType: vehicle.fuelType,
        odometer: vehicle.odometerCurrent.toString(),
        /** True when this driver already holds it — no claim is needed to drive it. */
        isHeldByYou: vehicle.assignments.length > 0,
        /** True for the last vehicle this driver took out. Sorted to the top. */
        isYourUsual: vehicle.id === recent?.vehicleId,
      }));

      rows.sort((a, b) => {
        if (a.isHeldByYou !== b.isHeldByYou) return a.isHeldByYou ? -1 : 1;
        if (a.isYourUsual !== b.isYourUsual) return a.isYourUsual ? -1 : 1;
        return a.registrationNumber.localeCompare(b.registrationNumber);
      });

      return { vehicles: rows };
    });

    app.post('/trip/start', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_TRIP_START);
      const body = startTripSchema.parse(request.body);

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'driver.trip.start',
        request.body,
        async () => {
          const at = body.occurredAt ?? services.clock.now();
          const started = await services.trips.startTrip({
            organizationId: actor.organizationId,
            driverId: actor.driverId as DriverId,
            label: body.label,
            // Kilometres on the wire, metres in the domain. Converted here rather than in the
            // schema so the unit a person typed stays the unit the request describes.
            plannedDistanceMeters:
              body.plannedDistanceKm === null ? null : Math.round(body.plannedDistanceKm * 1000),
            requestedVehicleId: (body.vehicleId as VehicleId | null) ?? null,
            startLatitude: body.startLatitude,
            startLongitude: body.startLongitude,
            startOdometer: body.startOdometer,
            at,
          });

          /**
           * Does this trip need a session of its own?
           *
           * Only if nobody is already tracking this person. A driver who is also on shift keeps
           * the working day's stream and the trip rides inside it; a driver who signed in at the
           * driver door gets a DRIVER_TRIP session, because otherwise nothing would authorise
           * their phone to report at all.
           */
          const driver = await services.prisma.driver.findFirst({
            where: { id: actor.driverId!, organizationId: actor.organizationId },
            select: { workerId: true },
          });
          const session = await services.tracking.attachTrip({
            organizationId: actor.organizationId,
            driverId: actor.driverId as DriverId,
            workerId: (driver?.workerId as WorkerId | null) ?? null,
            tripId: started.tripId,
            vehicleId: started.vehicleId as VehicleId,
            at,
          });

          return { ...started, trackingSessionId: session.id, trackingContext: session.context };
        },
      );
    });

    /*
     * No pause, no resume.
     *
     * They existed, and they were the hole in the product: a driver could stop the recording,
     * drive a hundred kilometres, and resume — leaving fuel burned against no trip and a route
     * with a straight line through the middle of it. A trip now records from the moment it
     * starts until the moment it ends, and a stationary vehicle is visible as a stop on its own
     * track without anybody pressing anything.
     */

    app.post('/trip/:tripId/end', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_TRIP_STOP);
      const body = endTripSchema.parse(request.body);
      const { tripId } = request.params as { tripId: string };

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'driver.trip.end',
        request.body,
        async () => {
          const at = body.occurredAt ?? services.clock.now();
          const summary = await services.trips.endTrip({
            organizationId: actor.organizationId,
            driverId: actor.driverId as DriverId,
            tripId: tripId as TripId,
            endLatitude: body.endLatitude,
            endLongitude: body.endLongitude,
            endOdometer: body.endOdometer,
            at,
          });

          /**
           * Ends the session only if the trip owned one.
           *
           * A worker whose trip has finished is still at work, and their day keeps recording
           * until they clock out. That is the behaviour Option C exists for, and closing the
           * session here would be the bug it exists to prevent.
           */
          const { closedSession } = await services.tracking.detachTrip({
            organizationId: actor.organizationId,
            tripId: tripId as TripId,
            at,
          });

          return { ...summary, trackingStopped: closedSession };
        },
      );
    });

    /**
     * Location ingestion.
     *
     * Not wrapped in the idempotency ledger: a batch is a set of points, and appending the same
     * point twice is prevented by ordering and the accepted-timestamp cursor rather than by
     * storing a response for every batch a driver ever sends. Writing an idempotency row per
     * batch would double the write volume of the busiest endpoint in the system.
     */
    app.post(
      '/location',
      {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        preHandler: app.requireEntitlement(FEATURES.GPS_TRACKING),
      },
      async (request) => {
        const actor = app.requireAuth(request);
        assertPermission(actor, PERMISSIONS.DRIVER_LOCATION_SUBMIT);
        const body = submitLocationsSchema.parse(request.body);

        /**
         * Resolved from the trip, not trusted from the body.
         *
         * The session that owns a trip's points may be the trip's own or the working day it
         * runs inside — `attachTrip` decided that when the trip started. Either way the client
         * does not get to say, and a trip belonging to another driver is simply not found.
         */
        const trip = await services.prisma.driverTrip.findFirst({
          where: {
            id: body.tripId,
            organizationId: actor.organizationId,
            driverId: actor.driverId!,
          },
          select: { id: true, driverId: true, driver: { select: { workerId: true } } },
        });
        if (!trip) throw new NotFoundError('trip.not_found', 'Trip not found.');

        const session = await services.prisma.trackingSession.findFirst({
          where: {
            organizationId: actor.organizationId,
            endedAt: null,
            OR: [
              { context: 'DRIVER_TRIP', tripId: trip.id },
              ...(trip.driver.workerId
                ? [{ context: 'WORK' as const, workerId: trip.driver.workerId }]
                : []),
            ],
          },
          select: { id: true },
        });
        if (!session) {
          throw new ForbiddenError(
            'tracking.no_open_session',
            'Location is only recorded during an open shift or trip.',
          );
        }

        return services.tracking.ingest({
          organizationId: actor.organizationId,
          sessionId: session.id as TrackingSessionId,
          points: body.points,
          deviceReported: body.deviceReported,
          telemetry: { batteryLevel: body.batteryLevel },
          now: services.clock.now(),
        });
      },
    );

    /** The driver's own trip history. Scoped by the session; no driver id parameter exists. */
    app.get('/trips', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_TRIP_HISTORY);
      const query = request.query as { from?: string; to?: string; limit?: string };

      const to = query.to ? new Date(query.to) : services.clock.now();
      const from = query.from
        ? new Date(query.from)
        : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

      const trips = await services.prisma.driverTrip.findMany({
        where: {
          organizationId: actor.organizationId,
          driverId: actor.driverId!,
          startedAt: { gte: from, lte: to },
        },
        select: {
          id: true,
          label: true,
          plannedDistanceMeters: true,
          status: true,
          startedAt: true,
          endedAt: true,
          distanceMeters: true,
          durationSeconds: true,
          untrackedSeconds: true,
          vehicle: { select: { registrationNumber: true } },
        },
        orderBy: { startedAt: 'desc' },
        take: Math.min(Number(query.limit ?? 50), 200),
      });

      return { trips };
    });

    /**
     * One trip's detail, including its tracking events.
     *
     * Gaps are returned explicitly so the driver's own history shows the same holes the admin
     * sees. There is no version of this data where the route is silently drawn as continuous.
     */
    app.get('/trips/:tripId', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_TRIP_HISTORY);
      const { tripId } = request.params as { tripId: string };

      const trip = await services.prisma.driverTrip.findFirst({
        where: {
          id: tripId,
          organizationId: actor.organizationId,
          // The driver filter is part of the query, not a check afterwards: another driver's
          // trip is simply not found.
          driverId: actor.driverId!,
        },
        select: {
          id: true,
          label: true,
          plannedDistanceMeters: true,
          status: true,
          startedAt: true,
          endedAt: true,
          distanceMeters: true,
          durationSeconds: true,
          pausedSeconds: true,
          untrackedSeconds: true,
          trackingState: true,
          vehicle: { select: { registrationNumber: true, make: true, model: true } },
          trackingEvents: {
            select: { type: true, state: true, occurredAt: true, gapSeconds: true },
            orderBy: { occurredAt: 'asc' },
          },
        },
      });

      if (!trip) throw new NotFoundError('trip.not_found', 'Trip not found.');
      return { trip };
    });
  };
}
