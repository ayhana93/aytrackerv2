import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PERMISSIONS, assertPermission } from '@aytracker/auth';
import { FEATURES } from '@aytracker/billing';
import { reconcileClientTimestamp } from '@aytracker/module-shifts';
import { hashRequestBody } from '@aytracker/module-shifts';
import {
  beginDrivingSchema,
  changePositionSchema,
  endBreakSchema,
  endShiftSchema,
  startBreakSchema,
  startShiftSchema,
} from '@aytracker/validation';
import { withDrivingPermissions, withoutDrivingPermissions } from '@aytracker/module-shifts';
import type {
  ClientActionId,
  PositionId,
  ShiftTypeId,
  SiteId,
  VehicleId,
  WorkerId,
} from '@aytracker/types';
import { ForbiddenError } from '@aytracker/domain';
import type { AppServices } from '../services/container.js';

/**
 * /api/v1/worker — the worker portal.
 *
 * Every route here derives the worker from the session. There is no route in this file that
 * takes a worker id, which is what makes "worker A cannot act on worker B" structural rather
 * than a check someone has to remember.
 *
 * Every mutation is wrapped in the idempotency ledger, because these are exactly the actions a
 * worker queues offline and replays on reconnect.
 */

/** How far in the past a queued offline action may legitimately be: one long shift. */
const MAX_BACKLOG_SECONDS = 16 * 60 * 60;
/** Tolerance for a device clock running fast. */
const MAX_SKEW_AHEAD_SECONDS = 120;
const IDEMPOTENCY_TTL_SECONDS = 48 * 60 * 60;

export function workerRoutes(services: AppServices): FastifyPluginAsync {
  return async (app) => {
    // Everything below requires a worker session — not merely a session with worker permissions.
    app.addHook('preHandler', app.requireActorType(['WORKER']));

    /**
     * Runs a command exactly once per clientActionId.
     *
     * On a replay the stored response is returned verbatim, so the client sees the same result
     * it would have seen the first time — including the ids it needs to reconcile local state.
     * A command that throws releases the claim, so a genuine retry can proceed.
     */
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
        actorType: 'WORKER',
        actorId: actor.workerId!,
        clientActionId,
        endpoint,
        requestHash: hashRequestBody(body),
        ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
      });

      if (claim.replayed) {
        request.log.info({ clientActionId, endpoint }, 'idempotent replay');
        return claim.response;
      }

      try {
        const result = await run();
        await services.idempotency.complete({
          organizationId: actor.organizationId,
          actorType: 'WORKER',
          actorId: actor.workerId!,
          clientActionId,
          response: result,
          status: 200,
        });
        return result;
      } catch (error) {
        await services.idempotency.release({
          organizationId: actor.organizationId,
          actorType: 'WORKER',
          actorId: actor.workerId!,
          clientActionId,
        });
        throw error;
      }
    }

    /** Resolves the effective timestamp for an action, honouring an offline queue's clock. */
    function resolveOccurredAt(request: FastifyRequest, clientTimestamp?: Date): Date {
      const serverNow = services.clock.now();
      if (!clientTimestamp) return serverNow;
      const reconciled = reconcileClientTimestamp({
        clientTimestamp,
        serverNow,
        maxBacklogSeconds: MAX_BACKLOG_SECONDS,
        maxSkewAheadSeconds: MAX_SKEW_AHEAD_SECONDS,
      });
      if (reconciled.wasAdjusted) {
        request.log.warn(
          { requestId: request.requestId, claimed: clientTimestamp, used: reconciled.timestamp },
          'client timestamp clamped',
        );
      }
      return reconciled.timestamp;
    }

    /** The worker's current state: open shift, current position, available positions. */
    app.get('/state', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKER_PORTAL_ACCESS);

      const worker = await services.prisma.worker.findFirst({
        where: { id: actor.workerId!, organizationId: actor.organizationId },
        select: { id: true, firstName: true, lastName: true, siteId: true, preferredLocale: true },
      });
      if (!worker) throw new ForbiddenError('worker.not_found', 'Worker profile unavailable.');

      const shift = await services.prisma.shift.findFirst({
        where: {
          organizationId: actor.organizationId,
          workerId: actor.workerId!,
          status: { in: ['ACTIVE', 'ON_BREAK'] },
        },
        select: {
          id: true,
          status: true,
          actualStart: true,
          siteId: true,
          positionSessions: {
            where: { endedAt: null },
            select: { id: true, positionId: true, startedAt: true },
            take: 1,
          },
          breaks: {
            where: { endedAt: null },
            select: { id: true, startedAt: true, type: true },
            take: 1,
          },
        },
      });

      const siteId = (shift?.siteId ?? worker.siteId) as SiteId | null;
      const availablePositions = siteId
        ? await services.workforce.listAvailablePositions({
            organizationId: actor.organizationId,
            workerId: actor.workerId as WorkerId,
            siteId,
            now: services.clock.now(),
          })
        : [];

      return {
        worker: {
          id: worker.id,
          firstName: worker.firstName,
          lastName: worker.lastName,
          preferredLocale: worker.preferredLocale,
        },
        shift: shift
          ? {
              id: shift.id,
              status: shift.status,
              actualStart: shift.actualStart?.toISOString() ?? null,
              currentPositionSession: shift.positionSessions[0] ?? null,
              openBreak: shift.breaks[0] ?? null,
            }
          : null,
        // Only positions this worker may actually occupy are sent. An ineligible position never
        // reaches the client, so the picker cannot be tampered with to select one.
        availablePositions,
      };
    });

    app.post('/shift/start', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKER_SHIFT_START);
      const body = startShiftSchema.parse(request.body);

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'worker.shift.start',
        request.body,
        async () => {
          const policy = await services.prisma.organizationSettings.findUnique({
            where: { organizationId: actor.organizationId },
            select: { maxShiftDurationMinutes: true, allowWorkerSelfShiftStart: true },
          });

          return services.shifts.startShift(
            {
              organizationId: actor.organizationId,
              workerId: actor.workerId as WorkerId,
              siteId: body.siteId as SiteId,
              shiftTypeId: body.shiftTypeId as ShiftTypeId,
              initialPositionId: body.initialPositionId as PositionId | null,
              at: resolveOccurredAt(request, body.occurredAt),
              startedBySupervisor: false,
            },
            {
              maxShiftDurationMinutes: policy?.maxShiftDurationMinutes ?? 960,
              allowWorkerSelfShiftStart: policy?.allowWorkerSelfShiftStart ?? true,
            },
          );
        },
      );
    });

    app.post('/shift/end', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKER_SHIFT_END);
      const body = endShiftSchema.parse(request.body);

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'worker.shift.end',
        request.body,
        async () => {
          const result = await services.shifts.endShift({
            organizationId: actor.organizationId,
            workerId: actor.workerId as WorkerId,
            at: resolveOccurredAt(request, body.occurredAt),
          });
          // A worker who ends their shift while driving loses the elevation with the trip.
          if (result.endedDriving) {
            await services.sessions.setDrivingContext({
              sessionId: actor.sessionId,
              driverId: null,
              permissions: withoutDrivingPermissions(actor.permissions),
            });
          }
          return result;
        },
      );
    });

    app.post('/break/start', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKER_BREAK_MANAGE);
      const body = startBreakSchema.parse(request.body);

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'worker.break.start',
        request.body,
        () =>
          services.shifts.startBreak({
            organizationId: actor.organizationId,
            workerId: actor.workerId as WorkerId,
            type: body.type,
            at: resolveOccurredAt(request, body.occurredAt),
          }),
      );
    });

    app.post('/break/end', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKER_BREAK_MANAGE);
      const body = endBreakSchema.parse(request.body);

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'worker.break.end',
        request.body,
        () =>
          services.shifts.endBreak({
            organizationId: actor.organizationId,
            workerId: actor.workerId as WorkerId,
            at: resolveOccurredAt(request, body.occurredAt),
          }),
      );
    });

    /**
     * The two-second path.
     *
     * A tap in the picker or a QR scan both land here. The QR token is resolved to a position
     * server-side and then runs the identical eligibility check — the code is an addressing
     * shortcut, never a credential.
     */
    app.post('/position/change', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKER_POSITION_CHANGE);
      const body = changePositionSchema.parse(request.body);
      const at = resolveOccurredAt(request, body.occurredAt);

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'worker.position.change',
        request.body,
        async () => {
          let targetPositionId: PositionId;
          let source: 'MANUAL' | 'QR';

          if (body.qrToken) {
            const resolved = await services.workforce.checkEligibilityByQr({
              organizationId: actor.organizationId,
              workerId: actor.workerId as WorkerId,
              qrToken: body.qrToken,
              now: at,
            });
            targetPositionId = resolved.position.positionId;
            source = 'QR';
          } else {
            targetPositionId = body.positionId as PositionId;
            source = 'MANUAL';
          }

          const result = await services.shifts.changePosition({
            organizationId: actor.organizationId,
            workerId: actor.workerId as WorkerId,
            targetPositionId,
            at,
            source,
          });
          // Moving back onto the floor ends the trip; the session must lose the driver
          // permissions in the same breath, or a worker at Machine 2 could still post GPS.
          if (result.endedDriving) {
            await services.sessions.setDrivingContext({
              sessionId: actor.sessionId,
              driverId: null,
              permissions: withoutDrivingPermissions(actor.permissions),
            });
          }
          return result;
        },
      );
    });

    /**
     * The vehicle picker.
     *
     * Reached only after tapping a DRIVING position. The list is filtered server-side to
     * vehicles this driver may actually take — active, and not held by someone else — so a
     * vehicle the worker cannot have is never sent to the device.
     */
    app.get('/positions/:positionId/vehicles', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKER_POSITION_CHANGE);
      const { positionId } = request.params as { positionId: string };

      const worker = await services.prisma.worker.findFirst({
        where: { id: actor.workerId!, organizationId: actor.organizationId },
        select: { siteId: true },
      });

      const result = await services.driving.listSelectableVehicles({
        organizationId: actor.organizationId,
        workerId: actor.workerId as WorkerId,
        positionId: positionId as PositionId,
        siteId: (worker?.siteId ?? null) as SiteId | null,
      });

      return {
        vehicles: result.vehicles.map((vehicle) => ({
          id: vehicle.vehicleId,
          registrationNumber: vehicle.registrationNumber,
          make: vehicle.make,
          model: vehicle.model,
          vehicleType: vehicle.vehicleType,
          fuelType: vehicle.fuelType,
          odometer: vehicle.odometer,
          /** True for the vehicle this driver already holds — the picker puts it first. */
          isCurrent: vehicle.assignedToSelf,
        })),
      };
    });

    /**
     * Confirms the handoff: position change + vehicle assignment + trip, in one transaction.
     *
     * On success the worker's own session is elevated with the driver permission set, so the
     * device can go straight to the driver portal without a second login. The elevation lasts
     * exactly as long as the driving position session.
     */
    app.post('/driving/begin', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKER_POSITION_CHANGE);
      const body = beginDrivingSchema.parse(request.body);

      return idempotent(
        request,
        body.clientActionId as ClientActionId,
        'worker.driving.begin',
        request.body,
        async () => {
          const context = await services.driving.beginDriving({
            organizationId: actor.organizationId,
            workerId: actor.workerId as WorkerId,
            positionId: body.positionId as PositionId,
            vehicleId: body.vehicleId as VehicleId,
            label: body.label,
            startLatitude: body.startLatitude,
            startLongitude: body.startLongitude,
            at: resolveOccurredAt(request, body.occurredAt),
          });

          await services.sessions.setDrivingContext({
            sessionId: actor.sessionId,
            driverId: context.driverId,
            permissions: withDrivingPermissions(actor.permissions),
          });

          return {
            ...context,
            /** The client navigates here. Sent by the server so the route is not hardcoded. */
            redirectTo: '/driver',
          };
        },
      );
    });

    /** The worker's own position history for the current shift. Read-only, by design. */
    app.get('/position/history', async (request) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, PERMISSIONS.WORKER_HISTORY_READ);

      const shift = await services.prisma.shift.findFirst({
        where: {
          organizationId: actor.organizationId,
          workerId: actor.workerId!,
          status: { in: ['ACTIVE', 'ON_BREAK'] },
        },
        select: { id: true },
      });
      if (!shift) return { sessions: [] };

      const sessions = await services.prisma.positionSession.findMany({
        where: { organizationId: actor.organizationId, shiftId: shift.id },
        select: {
          id: true,
          positionId: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          position: { select: { name: true, code: true } },
        },
        orderBy: { startedAt: 'asc' },
      });
      return { sessions };
    });

    /** Offline sync status: what the server believes, so the client can reconcile its queue. */
    app.get(
      '/sync/state',
      { preHandler: app.requireEntitlement(FEATURES.OFFLINE_MODE) },
      async (request) => {
        const actor = app.requireAuth(request);
        const recent = await services.prisma.idempotencyKey.findMany({
          where: {
            organizationId: actor.organizationId,
            actorType: 'WORKER',
            actorId: actor.workerId!,
            state: 'COMPLETED',
          },
          select: { clientActionId: true, responseStatus: true },
          orderBy: { createdAt: 'desc' },
          take: 200,
        });
        return { serverTime: services.clock.now().toISOString(), applied: recent };
      },
    );
  };
}
