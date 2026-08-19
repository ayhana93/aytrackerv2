/**
 * Tracking state.
 *
 * The single most important rule in this file is what it does NOT do: it never concludes that a
 * driver *chose* to stop tracking. A phone in a tunnel, a dead battery, an OS killing a
 * background task and a deliberately revoked permission all look similar from the server. So
 * the model reports what is observable — "no location received since 14:32" — and leaves intent
 * out of it. See docs/tracking.md § anti-tampering.
 */

export type TrackingState =
  /** Fresh, accurate points arriving on schedule. */
  | 'ACTIVE'
  /** Points still arriving, but late or low-accuracy. */
  | 'DEGRADED'
  /** The driver paused the trip. Not an anomaly. */
  | 'PAUSED'
  /** Nothing received for longer than the stale threshold, trip still open. */
  | 'INTERRUPTED'
  /** The device told us it lost connectivity; points are expected to arrive later. */
  | 'OFFLINE'
  /** No active tracking session. */
  | 'STOPPED';

export type TrackingEventType =
  | 'TRACKING_STARTED'
  | 'TRACKING_STOPPED'
  | 'TRACKING_PAUSED'
  | 'TRACKING_RESUMED'
  | 'SIGNAL_DEGRADED'
  | 'LOCATION_UNAVAILABLE'
  | 'PERMISSION_DISABLED'
  | 'DEVICE_OFFLINE'
  | 'APP_NOT_REPORTING'
  | 'REPORTING_RECOVERED';

/**
 * Neutral message keys. The client looks up the localized string; no wording here accuses
 * anyone of anything.
 */
export const TRACKING_EVENT_MESSAGE_KEYS: Readonly<Record<TrackingEventType, string>> = {
  TRACKING_STARTED: 'tracking.event.started',
  TRACKING_STOPPED: 'tracking.event.stopped',
  TRACKING_PAUSED: 'tracking.event.paused',
  TRACKING_RESUMED: 'tracking.event.resumed',
  SIGNAL_DEGRADED: 'tracking.event.signal_degraded',
  LOCATION_UNAVAILABLE: 'tracking.event.location_unavailable',
  PERMISSION_DISABLED: 'tracking.event.permission_disabled',
  DEVICE_OFFLINE: 'tracking.event.device_offline',
  APP_NOT_REPORTING: 'tracking.event.app_not_reporting',
  REPORTING_RECOVERED: 'tracking.event.reporting_recovered',
};

export interface TrackingThresholds {
  /** Beyond this since the last point, tracking is DEGRADED. */
  readonly degradedAfterSeconds: number;
  /** Beyond this since the last point, tracking is INTERRUPTED. */
  readonly staleAfterSeconds: number;
  /** Points less accurate than this count as degraded quality. */
  readonly degradedAccuracyMeters: number;
}

export const DEFAULT_THRESHOLDS: TrackingThresholds = {
  degradedAfterSeconds: 90,
  staleAfterSeconds: 180,
  degradedAccuracyMeters: 100,
};

export interface TrackingObservation {
  readonly tripStatus: 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  readonly lastPointAt: Date | null;
  readonly lastPointAccuracyMeters: number | null;
  /** Last thing the device told us about itself, if anything. */
  readonly deviceReported: 'ONLINE' | 'OFFLINE' | 'PERMISSION_DENIED' | null;
  readonly now: Date;
  readonly thresholds?: TrackingThresholds;
}

/**
 * Derives the current tracking state from observable facts only.
 *
 * Order matters: an explicit device report beats an inference, and a paused trip is never
 * called interrupted — the driver told us they stopped.
 */
export function deriveTrackingState(observation: TrackingObservation): TrackingState {
  const thresholds = observation.thresholds ?? DEFAULT_THRESHOLDS;

  if (observation.tripStatus === 'PAUSED') return 'PAUSED';
  if (observation.tripStatus !== 'ACTIVE') return 'STOPPED';

  // The device explicitly told us it cannot report. Believe it; it is more specific than silence.
  if (observation.deviceReported === 'PERMISSION_DENIED') return 'INTERRUPTED';
  if (observation.deviceReported === 'OFFLINE') return 'OFFLINE';

  if (observation.lastPointAt === null) return 'INTERRUPTED';

  const silenceSeconds = (observation.now.getTime() - observation.lastPointAt.getTime()) / 1000;
  if (silenceSeconds >= thresholds.staleAfterSeconds) return 'INTERRUPTED';

  const poorAccuracy =
    observation.lastPointAccuracyMeters !== null &&
    observation.lastPointAccuracyMeters > thresholds.degradedAccuracyMeters;
  if (silenceSeconds >= thresholds.degradedAfterSeconds || poorAccuracy) return 'DEGRADED';

  return 'ACTIVE';
}

/** The event to record for a state transition, or null when nothing changed. */
export function eventForTransition(
  from: TrackingState,
  to: TrackingState,
): TrackingEventType | null {
  if (from === to) return null;
  switch (to) {
    case 'ACTIVE':
      return from === 'STOPPED'
        ? 'TRACKING_STARTED'
        : from === 'PAUSED'
          ? 'TRACKING_RESUMED'
          : 'REPORTING_RECOVERED';
    case 'DEGRADED':
      return 'SIGNAL_DEGRADED';
    case 'PAUSED':
      return 'TRACKING_PAUSED';
    case 'INTERRUPTED':
      return 'APP_NOT_REPORTING';
    case 'OFFLINE':
      return 'DEVICE_OFFLINE';
    case 'STOPPED':
      return 'TRACKING_STOPPED';
  }
}

export interface TrackingGap {
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly seconds: number;
  readonly isOpen: boolean;
}

/**
 * Finds the intervals during an active trip when no location was received.
 *
 * These become the visible holes in the admin route view. The route is NOT drawn across them:
 * a straight line over a 19-minute gap is a fabrication, and the whole point of recording gaps
 * is to be honest that we do not know what happened.
 */
export function findTrackingGaps(input: {
  pointTimestamps: readonly Date[];
  tripStartedAt: Date;
  tripEndedAt: Date | null;
  now: Date;
  /** Intervals the driver explicitly paused; not counted as gaps. */
  pausedIntervals?: readonly { start: Date; end: Date | null }[];
  thresholds?: TrackingThresholds;
}): readonly TrackingGap[] {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const threshold = thresholds.staleAfterSeconds * 1000;
  const end = input.tripEndedAt ?? input.now;

  const boundaries = [
    input.tripStartedAt,
    ...[...input.pointTimestamps].sort((a, b) => a.getTime() - b.getTime()),
    end,
  ];

  const gaps: TrackingGap[] = [];
  for (let i = 1; i < boundaries.length; i += 1) {
    const previous = boundaries[i - 1]!;
    const current = boundaries[i]!;
    const span = current.getTime() - previous.getTime();
    if (span < threshold) continue;
    if (overlapsPause(previous, current, input.pausedIntervals ?? [])) continue;

    const isOpen = i === boundaries.length - 1 && input.tripEndedAt === null;
    gaps.push({
      startedAt: previous,
      endedAt: isOpen ? null : current,
      seconds: Math.round(span / 1000),
      isOpen,
    });
  }
  return gaps;
}

function overlapsPause(
  start: Date,
  end: Date,
  pauses: readonly { start: Date; end: Date | null }[],
): boolean {
  return pauses.some((pause) => {
    const pauseEnd = pause.end?.getTime() ?? Number.POSITIVE_INFINITY;
    return pause.start.getTime() < end.getTime() && pauseEnd > start.getTime();
  });
}

export function totalGapSeconds(gaps: readonly TrackingGap[]): number {
  return gaps.reduce((total, gap) => total + gap.seconds, 0);
}
