import { haversineMeters, type TrackPoint } from './geo.js';

/**
 * Speed alerts.
 *
 * The point of this file is restraint. A van on a motorway produces a speeding reading every
 * fifteen seconds for half an hour; a system that reports each one has told a supervisor nothing
 * and buried the one alert that mattered. So an alert is a *stretch* — one alert per continuous
 * period over the limit, carrying the peak reached and how long it lasted.
 *
 * Two further rules keep it truthful:
 *
 * **The device's own speed is preferred over derived speed.** A GPS receiver measures velocity
 * from Doppler shift and is good at it; dividing the distance between two fixes by the time
 * between them turns every position error into a speed error. Derived speed is the fallback for
 * devices that report no velocity, and it is where a 40 m position jump becomes an imaginary
 * 90 km/h.
 *
 * **A limit is never invented.** If nobody configured one, there are no alerts. There is no
 * national default here and no guess from the road type: reporting an employee for exceeding a
 * number the company never set is the kind of thing that ends up in a disciplinary meeting.
 */

export interface SpeedAlertOptions {
  /** The limit, in km/h. */
  readonly limitKph: number;
  /**
   * How long a reading must stay over the limit before it counts.
   *
   * One fix over the line is a measurement; thirty seconds over it is driving. This is also what
   * absorbs the odd bad fix that would otherwise report 180 km/h in a car park.
   */
  readonly sustainedSeconds: number;
  /**
   * How long after a stretch ends before a new one can be reported.
   *
   * Stop-start motorway traffic crosses the limit repeatedly; without a cooldown that is twenty
   * alerts for one journey.
   */
  readonly cooldownSeconds: number;
  /** Fixes less accurate than this are skipped: they cannot support a speed claim. */
  readonly maxAccuracyMeters: number;
}

export const DEFAULT_SPEED_ALERT_OPTIONS: Omit<SpeedAlertOptions, 'limitKph'> = {
  sustainedSeconds: 30,
  cooldownSeconds: 600,
  maxAccuracyMeters: 50,
};

export interface SpeedAlert {
  readonly startedAt: Date;
  readonly endedAt: Date;
  /** The highest speed observed during the stretch, in km/h, rounded to a whole number. */
  readonly peakKph: number;
  readonly limitKph: number;
  readonly latitude: number;
  readonly longitude: number;
  /** How the speed was obtained. A derived figure is weaker evidence and says so. */
  readonly source: 'DEVICE' | 'DERIVED';
}

const MPS_TO_KPH = 3.6;

/**
 * The speed at a point, in km/h, or null when it cannot be established.
 *
 * `previous` is only used for the derived fallback.
 */
export function speedKphAt(
  point: TrackPoint,
  previous: TrackPoint | null,
): { kph: number; source: 'DEVICE' | 'DERIVED' } | null {
  if (point.speedMps !== null && point.speedMps !== undefined && point.speedMps >= 0) {
    return { kph: point.speedMps * MPS_TO_KPH, source: 'DEVICE' };
  }
  if (!previous) return null;

  const seconds = (point.timestamp.getTime() - previous.timestamp.getTime()) / 1000;
  if (seconds <= 0) return null;
  return { kph: (haversineMeters(previous, point) / seconds) * MPS_TO_KPH, source: 'DERIVED' };
}

/**
 * Every speeding stretch in a stream of points.
 *
 * Recomputed from stored points rather than accumulated as they arrive, so a late offline replay
 * that fills in the middle of a journey produces the same answer as if it had arrived on time.
 */
export function detectSpeedAlerts(
  points: readonly TrackPoint[],
  options: SpeedAlertOptions,
): readonly SpeedAlert[] {
  if (points.length === 0 || options.limitKph <= 0) return [];

  const ordered = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const alerts: SpeedAlert[] = [];

  let open: {
    startedAt: Date;
    endedAt: Date;
    peakKph: number;
    latitude: number;
    longitude: number;
    source: 'DEVICE' | 'DERIVED';
  } | null = null;
  let previous: TrackPoint | null = null;
  let lastAlertEndedAt: Date | null = null;

  const flush = () => {
    if (!open) return;
    const heldSeconds = (open.endedAt.getTime() - open.startedAt.getTime()) / 1000;
    const withinCooldown =
      lastAlertEndedAt !== null &&
      (open.startedAt.getTime() - lastAlertEndedAt.getTime()) / 1000 < options.cooldownSeconds;

    if (heldSeconds >= options.sustainedSeconds && !withinCooldown) {
      alerts.push({
        startedAt: open.startedAt,
        endedAt: open.endedAt,
        peakKph: Math.round(open.peakKph),
        limitKph: options.limitKph,
        latitude: open.latitude,
        longitude: open.longitude,
        source: open.source,
      });
      lastAlertEndedAt = open.endedAt;
    }
    open = null;
  };

  for (const point of ordered) {
    if (
      point.accuracyMeters !== null &&
      point.accuracyMeters !== undefined &&
      point.accuracyMeters > options.maxAccuracyMeters
    ) {
      continue;
    }

    const speed = speedKphAt(point, previous);
    previous = point;
    if (speed === null) continue;

    if (speed.kph <= options.limitKph) {
      flush();
      continue;
    }

    if (open === null) {
      open = {
        startedAt: point.timestamp,
        endedAt: point.timestamp,
        peakKph: speed.kph,
        latitude: point.latitude,
        longitude: point.longitude,
        source: speed.source,
      };
      continue;
    }

    open.endedAt = point.timestamp;
    if (speed.kph > open.peakKph) {
      // The alert is placed where the worst of it happened, not where it began.
      open.peakKph = speed.kph;
      open.latitude = point.latitude;
      open.longitude = point.longitude;
      open.source = speed.source;
    }
  }

  flush();
  return alerts;
}
