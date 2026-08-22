import { type Clock, type EventBus } from '@aytracker/domain';
import type { DriverId, OrganizationId, VehicleId, WorkerId } from '@aytracker/types';
import {
  computeTrackDistance,
  deriveTrackingState,
  eventForTransition,
  findTrackingGaps,
  totalGapSeconds,
  type TrackingState,
} from '@aytracker/tracking';
import { admitPoints, type RawLocationPoint } from '../domain/admission.js';
import {
  assertCloseAfterStart,
  assertNoOpenSession,
  normalizeTelemetry,
  type DeviceTelemetry,
  type TrackingSessionId,
  type TrackingSessionState,
} from '../domain/session.js';
import type { TrackingTransactionRunner } from '../domain/ports.js';

/**
 * The one place location is written.
 *
 * There is a single ingestion path for the whole product. A worker's phone reporting during a
 * shift and a driver's phone reporting during a trip land in the same method, pass the same
 * admission rules, and are measured by the same arithmetic — because two paths would mean two
 * sets of rules, and the day the two disagree is the day nobody can defend a payroll number.
 *
 * What the caller supplies is coordinates. What this decides is everything else: which session
 * owns the point, which trip it falls inside, whether the timestamp is plausible, how far the
 * vehicle has actually gone, and what tracking state that adds up to.
 */
export class TrackingCommandService {
  constructor(
    private readonly transactions: TrackingTransactionRunner,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  /**
   * Opens the session that authorises a device to report.
   *
   * Called by whatever opens the thing being tracked — a shift, or a trip. Never called from a
   * route on its own, because a session with no shift and no trip would be exactly the 24/7
   * surveillance this design exists to make unrepresentable.
   */
  async openSession(input: {
    organizationId: OrganizationId;
    context: 'WORK' | 'DRIVER_TRIP';
    workerId: WorkerId | null;
    driverId: DriverId | null;
    shiftId: string | null;
    tripId: string | null;
    vehicleId: VehicleId | null;
    at: Date;
  }): Promise<TrackingSessionState> {
    const session = await this.transactions.run(input.organizationId, async (uow) => {
      const existing =
        input.context === 'WORK'
          ? await uow.sessions.findOpenWorkForWorker(input.organizationId, input.workerId!)
          : await uow.sessions.findOpenTripForDriver(input.organizationId, input.driverId!);
      assertNoOpenSession(existing);

      const opened = await uow.sessions.open({
        organizationId: input.organizationId,
        context: input.context,
        workerId: input.workerId,
        driverId: input.driverId,
        shiftId: input.shiftId,
        tripId: input.tripId,
        vehicleId: input.vehicleId,
        startedAt: input.at,
      });

      await uow.events.record({
        organizationId: input.organizationId,
        trackingSessionId: opened.id,
        tripId: input.tripId,
        type: 'TRACKING_STARTED',
        state: 'ACTIVE',
        occurredAt: input.at,
      });

      return opened;
    });

    await this.events.publish({
      name: 'tracking.session_started',
      organizationId: input.organizationId,
      occurredAt: input.at,
      payload: {
        sessionId: session.id,
        context: input.context,
        workerId: input.workerId,
        driverId: input.driverId,
      },
    });

    return session;
  }

  /**
   * A trip is starting. Decide whether it needs a session of its own.
   *
   * This is the whole of Option C in one method. A worker who is already being tracked keeps the
   * session they have — their phone does not start reporting twice, and the trip's points are
   * the working day's points with a trip attached. A driver who signed in at the driver door and
   * has no working day gets a DRIVER_TRIP session, because otherwise nothing would authorise
   * their device to report at all.
   *
   * Returns the session the trip's points will land in, whichever kind it turned out to be.
   */
  async attachTrip(input: {
    organizationId: OrganizationId;
    driverId: DriverId;
    workerId: WorkerId | null;
    tripId: string;
    vehicleId: VehicleId | null;
    at: Date;
  }): Promise<TrackingSessionState> {
    if (input.workerId) {
      const work = await this.transactions.run(input.organizationId, (uow) =>
        uow.sessions.findOpenWorkForWorker(input.organizationId, input.workerId!),
      );
      if (work) {
        // Already reporting. The trip rides along on the stream that is already running.
        await this.events.publish({
          name: 'tracking.trip_attached',
          organizationId: input.organizationId,
          occurredAt: input.at,
          payload: { sessionId: work.id, tripId: input.tripId, context: 'WORK' },
        });
        return work;
      }
    }

    return this.openSession({
      organizationId: input.organizationId,
      context: 'DRIVER_TRIP',
      workerId: null,
      driverId: input.driverId,
      shiftId: null,
      tripId: input.tripId,
      vehicleId: input.vehicleId,
      at: input.at,
    });
  }

  /**
   * A trip has ended.
   *
   * Closes the session **only** when the session was the trip's own. A trip that ran inside a
   * working day ends without touching the tracking that day depends on — which is the behaviour
   * Option C exists for: end the trip, keep tracking the employee, until they end their shift.
   */
  async detachTrip(input: {
    organizationId: OrganizationId;
    tripId: string;
    at: Date;
  }): Promise<{ closedSession: boolean }> {
    const session = await this.transactions.run(input.organizationId, (uow) =>
      uow.sessions.findByTripId(input.organizationId, input.tripId),
    );
    if (!session || session.endedAt !== null) return { closedSession: false };

    await this.closeSession({
      organizationId: input.organizationId,
      sessionId: session.id,
      at: input.at,
    });
    return { closedSession: true };
  }

  /**
   * Closes a session and finalises its numbers.
   *
   * Distance is recomputed from every stored point rather than trusted from the running total,
   * so a day whose points arrived out of order after an offline stretch still ends with the
   * right figure.
   *
   * Idempotent: a session already closed returns null. Closing a shift that was closed by the
   * auto-close sweep a second earlier must not fail.
   */
  async closeSession(input: {
    organizationId: OrganizationId;
    sessionId: TrackingSessionId;
    at: Date;
  }): Promise<{ distanceMeters: number; untrackedSeconds: number } | null> {
    const result = await this.transactions.run(input.organizationId, async (uow) => {
      const session = await uow.sessions.findById(input.organizationId, input.sessionId);
      if (!session || session.endedAt !== null) return null;
      assertCloseAfterStart(session, input.at);

      const points = await uow.points.listForSession(input.organizationId, session.id);
      const distance = computeTrackDistance(points);
      const gaps = findTrackingGaps({
        pointTimestamps: points.map((point) => point.timestamp),
        tripStartedAt: session.startedAt,
        tripEndedAt: input.at,
        now: input.at,
      });

      const elapsedSeconds = Math.max(
        0,
        Math.round((input.at.getTime() - session.startedAt.getTime()) / 1000),
      );
      const untrackedSeconds = Math.min(totalGapSeconds(gaps), elapsedSeconds);

      await uow.sessions.close({
        organizationId: input.organizationId,
        sessionId: session.id,
        endedAt: input.at,
        distanceMeters: distance.distanceMeters,
        untrackedSeconds,
      });

      await uow.events.record({
        organizationId: input.organizationId,
        trackingSessionId: session.id,
        tripId: session.tripId,
        type: 'TRACKING_STOPPED',
        state: 'STOPPED',
        occurredAt: input.at,
      });

      return { distanceMeters: distance.distanceMeters, untrackedSeconds };
    });

    if (result) {
      await this.events.publish({
        name: 'tracking.session_stopped',
        organizationId: input.organizationId,
        occurredAt: input.at,
        payload: { sessionId: input.sessionId, ...result },
      });
    }
    return result;
  }

  /** Closes the session attached to a shift, if the organization opened one. */
  async closeSessionForShift(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    at: Date;
  }): Promise<{ distanceMeters: number; untrackedSeconds: number } | null> {
    const session = await this.transactions.run(input.organizationId, (uow) =>
      uow.sessions.findOpenWorkForWorker(input.organizationId, input.workerId),
    );
    if (!session) return null;
    return this.closeSession({
      organizationId: input.organizationId,
      sessionId: session.id,
      at: input.at,
    });
  }

  /** Closes the session attached to a trip, if one is open. */
  async closeSessionForTrip(input: {
    organizationId: OrganizationId;
    tripId: string;
    at: Date;
  }): Promise<{ distanceMeters: number; untrackedSeconds: number } | null> {
    const session = await this.transactions.run(input.organizationId, (uow) =>
      uow.sessions.findByTripId(input.organizationId, input.tripId),
    );
    if (!session || session.endedAt !== null) return null;
    return this.closeSession({
      organizationId: input.organizationId,
      sessionId: session.id,
      at: input.at,
    });
  }

  /**
   * Ingests a batch of points into a session.
   *
   * The hot path of the whole system, so it does the minimum: admit → append → recompute the
   * running distance and state. Route reconstruction, stop detection and gap analysis are
   * read-side concerns and stay out of here.
   *
   * The trip overlay is resolved once per batch from the session's open trip, and then decided
   * per point by timestamp — so a batch that spans the moment a driver ended their trip splits
   * correctly between the trip and the rest of the working day.
   */
  async ingest(input: {
    organizationId: OrganizationId;
    sessionId: TrackingSessionId;
    points: readonly RawLocationPoint[];
    deviceReported: 'ONLINE' | 'OFFLINE' | 'PERMISSION_DENIED' | null;
    telemetry?: Partial<DeviceTelemetry> | null;
    now: Date;
    backfillThresholdSeconds?: number;
  }): Promise<{
    accepted: number;
    rejected: number;
    clamped: number;
    state: TrackingState;
    distanceMeters: number;
  }> {
    const telemetry = normalizeTelemetry(input.telemetry ?? null);

    return this.transactions.run(input.organizationId, async (uow) => {
      const session = await uow.sessions.findById(input.organizationId, input.sessionId);
      const trip = session
        ? await uow.trips.openTripForSession(input.organizationId, session)
        : null;

      const batch = admitPoints({
        session,
        points: input.points,
        trip,
        now: input.now,
        backfillThresholdSeconds: input.backfillThresholdSeconds ?? 120,
      });
      // `admitPoints` asserts the session is open, so it is non-null past this line.
      const open = session!;

      if (batch.accepted.length > 0) {
        await uow.points.appendMany({
          organizationId: input.organizationId,
          trackingSessionId: open.id,
          points: batch.accepted,
        });
      }

      const allPoints = await uow.points.listForSession(input.organizationId, open.id);
      const distance = computeTrackDistance(allPoints);
      const last = allPoints.at(-1) ?? null;

      const previousState =
        (await uow.events.latestState(input.organizationId, open.id)) ?? 'STOPPED';
      const state = deriveTrackingState({
        // A tracking session has no notion of pausing; the union is shared with trips, and
        // ACTIVE is what "this session is open" means here.
        tripStatus: 'ACTIVE',
        lastPointAt: last?.timestamp ?? null,
        lastPointAccuracyMeters: last?.accuracyMeters ?? null,
        deviceReported: input.deviceReported,
        now: input.now,
      });

      const transition = eventForTransition(previousState, state);
      if (transition) {
        await uow.events.record({
          organizationId: input.organizationId,
          trackingSessionId: open.id,
          tripId: trip?.id ?? null,
          type: transition,
          state,
          occurredAt: input.now,
          lastLatitude: last?.latitude ?? null,
          lastLongitude: last?.longitude ?? null,
          metadata: {
            previousState,
            deviceReported: input.deviceReported,
            // Recorded on the event, not just the session, so "the phone was on 4%" is still
            // answerable a week later when somebody asks why the afternoon is thin.
            batteryLevel: telemetry.batteryLevel,
            permission: telemetry.permission,
          },
        });
      }

      await uow.sessions.updateLiveState({
        organizationId: input.organizationId,
        sessionId: open.id,
        distanceMeters: distance.distanceMeters,
        lastPointAt: last?.timestamp ?? open.lastPointAt,
        lastLatitude: last?.latitude ?? null,
        lastLongitude: last?.longitude ?? null,
        lastSpeedMps: last?.speedMps ?? null,
        lastAccuracyMeters: last?.accuracyMeters ?? null,
        trackingState: state,
        telemetry,
      });

      return {
        accepted: batch.accepted.length,
        rejected: batch.rejected,
        clamped: batch.clamped,
        state,
        distanceMeters: distance.distanceMeters,
      };
    });
  }

  /**
   * Sweeps open sessions and records an interruption for any that have gone quiet.
   *
   * Run on a schedule. Without it a session whose device died sits at ACTIVE for ever, and the
   * live map shows a green dot for a phone that stopped reporting at lunchtime — which is worse
   * than showing nothing, because somebody believes it.
   */
  async detectInterruptions(input: {
    organizationId: OrganizationId;
  }): Promise<{ interrupted: number }> {
    const now = this.clock.now();
    return this.transactions.run(input.organizationId, async (uow) => {
      const open = await uow.sessions.listOpen(input.organizationId);
      let interrupted = 0;

      for (const session of open) {
        const lastPointAt = await uow.points.lastPointAt(input.organizationId, session.id);
        const previousState =
          (await uow.events.latestState(input.organizationId, session.id)) ?? 'STOPPED';
        const state = deriveTrackingState({
          tripStatus: 'ACTIVE',
          lastPointAt,
          lastPointAccuracyMeters: null,
          deviceReported: null,
          now,
        });

        const transition = eventForTransition(previousState, state);
        if (!transition) continue;

        await uow.events.record({
          organizationId: input.organizationId,
          trackingSessionId: session.id,
          tripId: session.tripId,
          type: transition,
          state,
          occurredAt: lastPointAt ?? session.startedAt,
          gapSeconds: lastPointAt
            ? Math.round((now.getTime() - lastPointAt.getTime()) / 1000)
            : null,
          metadata: { previousState, detectedBy: 'sweep' },
        });
        if (state === 'INTERRUPTED') interrupted += 1;
      }

      return { interrupted };
    });
  }
}
