import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PERMISSIONS, assertPermission } from '@aytracker/auth';
import { FEATURES } from '@aytracker/billing';
import { hashRequestBody } from '@aytracker/module-shifts';
import {
  endTripSchema,
  startTripSchema,
  submitLocationsSchema,
  tripActionSchema,
} from '@aytracker/validation';
import { DEFAULT_SAMPLING_POLICY } from '@aytracker/tracking';
import type { ClientActionId, DriverId, TripId } from '@aytracker/types';
import { NotFoundError } from '@aytracker/domain';
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
 */

const IDEMPOTENCY_TTL_SECONDS = 48 * 60 * 60;

export function driverRoutes(services: AppServices): FastifyPluginAsync {
  return async (app) => {
    app.addHook('preHandler', app.requireActorType(['DRIVER']));
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
        actorType: 'DRIVER',
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
          actorType: 'DRIVER',
          actorId: actor.driverId!,
          clientActionId,
          response: result,
          status: 200,
        });
        return result;
      } catch (error) {
        await services.idempotency.release({
          organizationId: actor.organizationId,
          actorType: 'DRIVER',
          actorId: actor.driverId!,
          clientActionId,
        });
        throw error;
      }
    }

    /** The driver's home screen: assigned vehicle, active trip, tracking state. */
    app.get('/state', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_PORTAL_ACCESS);

      const assignment = await services.prisma.vehicleAssignment.findFirst({
        where: { organizationId: actor.organizationId, driverId: actor.driverId!, endedAt: null },
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
            },
          },
        },
      });

      const trip = await services.prisma.driverTrip.findFirst({
        where: {
          organizationId: actor.organizationId,
          driverId: actor.driverId!,
          status: { in: ['ACTIVE', 'PAUSED'] },
        },
        select: {
          id: true,
          label: true,
          status: true,
          startedAt: true,
          distanceMeters: true,
          durationSeconds: true,
          trackingState: true,
          lastPointAt: true,
        },
      });

      const settings = await services.prisma.organizationSettings.findUnique({
        where: { organizationId: actor.organizationId },
        select: { gpsMinIntervalSeconds: true, gpsMinDistanceMeters: true },
      });

      return {
        vehicle: assignment
          ? {
              ...assignment.vehicle,
              odometerCurrent: assignment.vehicle.odometerCurrent.toString(),
              assignedSince: assignment.startedAt.toISOString(),
            }
          : null,
        trip: trip
          ? {
              ...trip,
              startedAt: trip.startedAt?.toISOString() ?? null,
              lastPointAt: trip.lastPointAt?.toISOString() ?? null,
            }
          : null,
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

    app.post('/trip/start', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_TRIP_START);
      const body = startTripSchema.parse(request.body);

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'driver.trip.start',
        request.body,
        () =>
          services.trips.startTrip({
            organizationId: actor.organizationId,
            driverId: actor.driverId as DriverId,
            label: body.label,
            startLatitude: body.startLatitude,
            startLongitude: body.startLongitude,
            startOdometer: body.startOdometer,
            at: body.occurredAt ?? services.clock.now(),
          }),
      );
    });

    app.post('/trip/:tripId/pause', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_TRIP_PAUSE);
      const body = tripActionSchema.parse(request.body);
      const { tripId } = request.params as { tripId: string };

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'driver.trip.pause',
        request.body,
        async () => {
          await services.trips.pauseTrip({
            organizationId: actor.organizationId,
            driverId: actor.driverId as DriverId,
            tripId: tripId as TripId,
            at: body.occurredAt ?? services.clock.now(),
          });
          return { ok: true };
        },
      );
    });

    app.post('/trip/:tripId/resume', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.DRIVER_TRIP_PAUSE);
      const body = tripActionSchema.parse(request.body);
      const { tripId } = request.params as { tripId: string };

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'driver.trip.resume',
        request.body,
        async () => {
          await services.trips.resumeTrip({
            organizationId: actor.organizationId,
            driverId: actor.driverId as DriverId,
            tripId: tripId as TripId,
            at: body.occurredAt ?? services.clock.now(),
          });
          return { ok: true };
        },
      );
    });

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
        () =>
          services.trips.endTrip({
            organizationId: actor.organizationId,
            driverId: actor.driverId as DriverId,
            tripId: tripId as TripId,
            endLatitude: body.endLatitude,
            endLongitude: body.endLongitude,
            endOdometer: body.endOdometer,
            at: body.occurredAt ?? services.clock.now(),
          }),
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

        return services.trips.ingestLocations({
          organizationId: actor.organizationId,
          driverId: actor.driverId as DriverId,
          tripId: body.tripId as TripId,
          points: body.points,
          deviceReported: body.deviceReported,
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
