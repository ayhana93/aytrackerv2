import { type Clock, type EventBus } from '@aytracker/domain';
import type { DriverId, OrganizationId, VehicleId, WorkerId } from '@aytracker/types';
import {
  DEFAULT_GEOFENCE_OPTIONS,
  DEFAULT_SAMPLING_POLICY,
  DEFAULT_SPEED_ALERT_OPTIONS,
  // The package's own admission control is the sampling floor, and shares a name with this
  // module's session admission. Aliased so the two are never confused at a call site.
  admitPoints as admitAtInterval,
  computeTrackDistance,
  deriveTrackingState,
  detectGeofenceVisits,
  detectSpeedAlerts,
  eventForTransition,
  findTrackingGaps,
  totalGapSeconds,
  type GeofenceOptions,
  type SpeedAlertOptions,
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
import type {
  TrackedPoint,
  TrackingTransactionRunner,
  TrackingUnitOfWork,
} from '../domain/ports.js';

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
    /** The organization's sampling floor. The device is told this; here it is enforced. */
    minIntervalSeconds?: number;
    /** Set false to skip geofence derivation entirely — used by tests and by bulk imports. */
    geofencing?: boolean;
    geofenceOptions?: Partial<GeofenceOptions>;
    /**
     * The organization's speed limit in km/h, or null/absent for no speed alerting at all.
     * There is no default: alerting on a number nobody set is not a feature.
     */
    speedLimitKph?: number | null;
    speedAlertOptions?: Partial<Omit<SpeedAlertOptions, 'limitKph'>>;
  }): Promise<{
    accepted: number;
    rejected: number;
    clamped: number;
    dropped: number;
    duplicates: number;
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

      /**
       * The sampling floor, enforced rather than requested.
       *
       * `/tracking/state` hands every device a minimum interval. A client that ignores it — a
       * bug, an old build, or someone curious what happens — must not be able to write a point a
       * second into the busiest table in the system.
       *
       * The floor is applied in two buckets. Points newer than the last one stored are live, and
       * are thinned against it. Points at or before it are an offline replay arriving late, and
       * are thinned only against each other: measuring a two-hour-old queued fix against the
       * newest stored point would discard the entire replay, which is real data about a stretch
       * of the day we would otherwise have no evidence for.
       */
      const storedLastAt = await uow.points.lastPointAt(input.organizationId, open.id);
      const floorSeconds = input.minIntervalSeconds ?? DEFAULT_SAMPLING_POLICY.minIntervalSeconds;
      const live = batch.accepted.filter(
        (point) => storedLastAt === null || point.timestamp.getTime() > storedLastAt.getTime(),
      );
      const replay = batch.accepted.filter(
        (point) => storedLastAt !== null && point.timestamp.getTime() <= storedLastAt.getTime(),
      );
      const thinnedLive = admitAtInterval(live, {
        lastAcceptedAt: storedLastAt,
        minIntervalSeconds: floorSeconds,
      });
      const thinnedReplay = admitAtInterval(replay, {
        lastAcceptedAt: null,
        minIntervalSeconds: floorSeconds,
      });
      const keep = [...thinnedReplay.accepted, ...thinnedLive.accepted];
      const dropped = thinnedLive.dropped + thinnedReplay.dropped;

      /**
       * Stored, not merely kept.
       *
       * The unique index on (organization, session, instant) skips a point already held for that
       * instant, which is what a re-sent batch is made of — so the count that comes back is the
       * number of genuinely new fixes, and a replay honestly reports zero rather than claiming to
       * have recorded the afternoon twice.
       */
      const stored =
        keep.length > 0
          ? await uow.points.appendMany({
              organizationId: input.organizationId,
              trackingSessionId: open.id,
              points: keep,
            })
          : 0;
      const duplicates = keep.length - stored;

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

      /**
       * The trip's own running numbers, when the batch touched one.
       *
       * The driver's screen and the admin trip list read `driver_trips.distanceMeters` — one
       * indexed row rather than a scan of the day. Without this the trip shows 0 km until it
       * closes, which is precisely the number a driver would dispute while it is happening.
       *
       * Computed over the trip's points, not the session's: a working day that included a
       * fifteen-kilometre commute before the trip must not have that distance land on the trip.
       */
      if (trip) {
        const tripPoints = await uow.points.listForTrip(input.organizationId, trip.id);
        const tripLast = tripPoints.at(-1);
        if (tripLast) {
          await uow.trips.updateLiveMetrics({
            organizationId: input.organizationId,
            tripId: trip.id,
            distanceMeters: computeTrackDistance(tripPoints).distanceMeters,
            lastPointAt: tripLast.timestamp,
            trackingState: state,
          });
        }
      }

      /**
       * What the day's points imply about places and speed.
       *
       * Both derivations are skipped entirely unless the organization configured them — no
       * fences, no speed limit, no work. That matters because both recompute over the session's
       * whole point stream rather than over the batch: a crossing that takes ninety seconds to
       * confirm can straddle two uploads, and a speeding stretch can straddle five, so deciding
       * either from one batch would produce a different answer depending on how the phone
       * happened to group its points. Recomputing is also what lets a late offline replay
       * *correct* an afternoon rather than append a second version of it.
       */
      if (input.geofencing !== false) {
        await this.deriveGeofenceVisits({
          uow,
          organizationId: input.organizationId,
          session: open,
          points: allPoints,
          state,
          options: input.geofenceOptions,
        });
      }
      if (input.speedLimitKph) {
        await this.deriveSpeedAlerts({
          uow,
          organizationId: input.organizationId,
          session: open,
          points: allPoints,
          state,
          options: {
            ...DEFAULT_SPEED_ALERT_OPTIONS,
            ...input.speedAlertOptions,
            limitKph: input.speedLimitKph,
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
        accepted: stored,
        rejected: batch.rejected,
        clamped: batch.clamped,
        dropped,
        /** Already held for this session at this instant — a re-sent batch, not new evidence. */
        duplicates,
        state,
        distanceMeters: distance.distanceMeters,
      };
    });
  }

  /**
   * Recomputes this session's geofence visits and logs the crossings that are new.
   *
   * The visit rows are made equal to what the points support — created, closed or removed — and
   * only the differences produce events. Logging every re-derived crossing would fill the event
   * log with the same arrival two hundred times over the course of an afternoon.
   */
  private async deriveGeofenceVisits(input: {
    uow: TrackingUnitOfWork;
    organizationId: OrganizationId;
    session: TrackingSessionState;
    points: readonly TrackedPoint[];
    state: TrackingState;
    options?: Partial<GeofenceOptions>;
  }): Promise<void> {
    const fences = await input.uow.geofences.listActive(input.organizationId);
    if (fences.length === 0) return;

    const visits = detectGeofenceVisits(input.points, fences, {
      ...DEFAULT_GEOFENCE_OPTIONS,
      ...input.options,
    });

    const nameById = new Map(fences.map((fence) => [fence.id, fence.name]));
    // The trip overlay is read off the point the crossing was observed at, exactly as it is for
    // the point itself — so a visit made during a trip carries the trip, and one made on foot
    // between two trips does not.
    const tripAt = new Map(input.points.map((point) => [point.timestamp.getTime(), point.tripId]));

    const computed = visits.map((visit) => ({
      ...visit,
      geofenceName: nameById.get(visit.geofenceId) ?? '',
      tripId: tripAt.get(visit.enteredAt.getTime()) ?? null,
    }));

    const { entered, exited } = await input.uow.geofences.syncVisits({
      organizationId: input.organizationId,
      trackingSessionId: input.session.id,
      visits: computed,
    });

    for (const visit of entered) {
      await input.uow.events.record({
        organizationId: input.organizationId,
        trackingSessionId: input.session.id,
        tripId: visit.tripId,
        type: 'GEOFENCE_ENTER',
        state: input.state,
        occurredAt: visit.enteredAt,
        lastLatitude: visit.entryLatitude,
        lastLongitude: visit.entryLongitude,
        metadata: { geofenceId: visit.geofenceId, geofenceName: visit.geofenceName },
      });
    }
    for (const visit of exited) {
      if (!visit.exitedAt) continue;
      await input.uow.events.record({
        organizationId: input.organizationId,
        trackingSessionId: input.session.id,
        tripId: visit.tripId,
        type: 'GEOFENCE_EXIT',
        state: input.state,
        occurredAt: visit.exitedAt,
        metadata: {
          geofenceId: visit.geofenceId,
          geofenceName: visit.geofenceName,
          dwellSeconds: visit.dwellSeconds,
        },
      });
    }
  }

  /**
   * Recomputes this session's speeding stretches and logs the ones not already logged.
   *
   * One event per stretch, keyed on when the stretch began. A stretch that is still in progress
   * gets its event once and is not re-logged as it lengthens: a supervisor needs to know it is
   * happening, not to be told again every fifteen seconds while it continues.
   */
  private async deriveSpeedAlerts(input: {
    uow: TrackingUnitOfWork;
    organizationId: OrganizationId;
    session: TrackingSessionState;
    points: readonly TrackedPoint[];
    state: TrackingState;
    options: SpeedAlertOptions;
  }): Promise<void> {
    const alerts = detectSpeedAlerts(input.points, input.options);
    if (alerts.length === 0) return;

    const logged = new Set(
      (
        await input.uow.events.occurrencesOf(
          input.organizationId,
          input.session.id,
          'SPEED_EXCEEDED',
        )
      ).map((occurredAt) => occurredAt.getTime()),
    );
    const tripAt = new Map(input.points.map((point) => [point.timestamp.getTime(), point.tripId]));

    for (const alert of alerts) {
      if (logged.has(alert.startedAt.getTime())) continue;
      await input.uow.events.record({
        organizationId: input.organizationId,
        trackingSessionId: input.session.id,
        tripId: tripAt.get(alert.startedAt.getTime()) ?? null,
        type: 'SPEED_EXCEEDED',
        state: input.state,
        occurredAt: alert.startedAt,
        lastLatitude: alert.latitude,
        lastLongitude: alert.longitude,
        metadata: {
          peakKph: alert.peakKph,
          limitKph: alert.limitKph,
          endedAt: alert.endedAt.toISOString(),
          durationSeconds: Math.round((alert.endedAt.getTime() - alert.startedAt.getTime()) / 1000),
          /**
           * How the speed was established. A figure derived from two positions is weaker
           * evidence than one the receiver measured, and anything acting on this event — a
           * report, a conversation with a driver — should be able to tell which it is.
           */
          source: alert.source,
        },
      });
    }
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
