import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS, assertPermission } from '@aytracker/auth';
import { FEATURES } from '@aytracker/billing';
import { DEFAULT_SAMPLING_POLICY } from '@aytracker/tracking';
import { submitTrackingPointsSchema } from '@aytracker/validation';
import type { DriverId, OrganizationId, WorkerId } from '@aytracker/types';
import { ForbiddenError } from '@aytracker/domain';
import type { TrackingSessionId } from '@aytracker/module-tracking';
import type { AppServices } from '../services/container.js';

/**
 * /api/v1/tracking — where a device reports where it is.
 *
 * One endpoint for the whole product. A worker's phone on shift and a driver's phone on a trip
 * post the same body to the same URL; the server decides which session owns the points and
 * whether a trip was running when each fix was taken. Two endpoints would have meant two sets of
 * admission rules, and the day they disagree is the day a payroll figure and a fuel figure stop
 * adding up.
 *
 * The device never names the session. It could not be trusted to, and it does not need to: the
 * open session for the authenticated actor is a server-side lookup.
 */
export function trackingRoutes(services: AppServices): FastifyPluginAsync {
  return async (app) => {
    // A worker on shift, a driver on a trip, or a worker elevated for driving. Never an admin
    // user: a management account has no device stream and no session to write to.
    app.addHook('preHandler', app.requireActorType(['WORKER', 'DRIVER']));

    /**
     * The session this actor may currently write to.
     *
     * A worker's WORK session wins over a driver trip session when both somehow exist, because
     * the working day is the outer context and the trip rides inside it. Nothing here reads an
     * id from the request.
     */
    async function resolveSession(
      organizationId: OrganizationId,
      workerId: WorkerId | null,
      driverId: DriverId | null,
    ): Promise<TrackingSessionId | null> {
      const row = await services.prisma.trackingSession.findFirst({
        where: {
          organizationId,
          endedAt: null,
          OR: [
            ...(workerId ? [{ context: 'WORK' as const, workerId }] : []),
            ...(driverId ? [{ context: 'DRIVER_TRIP' as const, driverId }] : []),
          ],
        },
        select: { id: true, context: true },
        orderBy: { context: 'asc' },
      });
      return (row?.id as TrackingSessionId | undefined) ?? null;
    }

    /**
     * Location ingestion.
     *
     * Not wrapped in the idempotency ledger: a batch is a set of points, and appending the same
     * point twice is prevented by ordering and the session's timestamp window rather than by
     * storing a response for every batch every device ever sends. An idempotency row per batch
     * would double the write volume of the busiest endpoint in the system.
     *
     * Rate limited generously — this is the one endpoint expected to be called every few seconds
     * by every device on shift — but limited, because "high frequency" and "unbounded" are
     * different things.
     */
    app.post(
      '/points',
      {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        preHandler: app.requireEntitlement(FEATURES.GPS_TRACKING),
      },
      async (request) => {
        const actor = app.requireAuth(request);
        assertPermission(actor, PERMISSIONS.TRACKING_SUBMIT);
        const body = submitTrackingPointsSchema.parse(request.body);

        const [sessionId, settings] = await Promise.all([
          resolveSession(
            actor.organizationId,
            (actor.workerId as WorkerId | undefined) ?? null,
            (actor.driverId as DriverId | undefined) ?? null,
          ),
          services.prisma.organizationSettings.findUnique({
            where: { organizationId: actor.organizationId },
            select: { gpsMinIntervalSeconds: true },
          }),
        ]);
        if (!sessionId) {
          /**
           * No session, no collection. This is the privacy rule at the edge.
           *
           * A device that keeps reporting after a shift ended gets this, every time, and stores
           * nothing. It is a precondition rather than a silent discard so the client knows to
           * stop its collector rather than draining its battery into a void.
           */
          throw new ForbiddenError(
            'tracking.no_open_session',
            'Location is only recorded during an open shift or trip.',
          );
        }

        return services.tracking.ingest({
          organizationId: actor.organizationId,
          sessionId,
          points: body.points,
          deviceReported: body.deviceReported,
          telemetry: {
            batteryLevel: body.batteryLevel,
            isCharging: body.isCharging,
            permission: body.permission,
          },
          now: services.clock.now(),
          /**
           * The same floor `/tracking/state` tells the device to sample at. Read here rather
           * than assumed, because an organization may configure a finer interval than the
           * default and a hard-coded floor would then quietly discard points it asked for.
           */
          minIntervalSeconds:
            settings?.gpsMinIntervalSeconds ?? DEFAULT_SAMPLING_POLICY.minIntervalSeconds,
        });
      },
    );

    /**
     * What the device should do right now.
     *
     * The sampling policy and whether a session is open, in one small read the collector can
     * poll cheaply. A client that has been offline for an hour asks this on reconnect and finds
     * out whether it should still be running at all.
     */
    app.get('/state', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.TRACKING_SUBMIT);

      const [session, settings] = await Promise.all([
        services.prisma.trackingSession.findFirst({
          where: {
            organizationId: actor.organizationId,
            endedAt: null,
            OR: [
              ...(actor.workerId ? [{ context: 'WORK' as const, workerId: actor.workerId }] : []),
              ...(actor.driverId
                ? [{ context: 'DRIVER_TRIP' as const, driverId: actor.driverId }]
                : []),
            ],
          },
          select: {
            id: true,
            context: true,
            startedAt: true,
            distanceMeters: true,
            trackingState: true,
            lastPointAt: true,
          },
          orderBy: { context: 'asc' },
        }),
        services.prisma.organizationSettings.findUnique({
          where: { organizationId: actor.organizationId },
          select: { gpsMinIntervalSeconds: true, gpsMinDistanceMeters: true },
        }),
      ]);

      return {
        serverTime: services.clock.now().toISOString(),
        session: session
          ? {
              id: session.id,
              context: session.context,
              startedAt: session.startedAt.toISOString(),
              distanceMeters: session.distanceMeters,
              trackingState: session.trackingState,
              lastPointAt: session.lastPointAt?.toISOString() ?? null,
            }
          : null,
        /**
         * The floor the device should sample at. Sent from the server so it can be tuned per
         * organization without shipping a new client — and enforced on ingestion, so a client
         * that ignores it gains nothing but a flatter battery.
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
  };
}
