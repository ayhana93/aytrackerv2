import type { GeoPoint } from '@aytracker/types';

/** Mean Earth radius (WGS-84 authalic), metres. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two points, in metres.
 *
 * Haversine rather than Vincenty: for the segment lengths we actually integrate (tens of metres
 * to a few kilometres) the ellipsoidal correction is far below GPS noise, and haversine has no
 * convergence failure mode.
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface TrackPoint extends GeoPoint {
  readonly timestamp: Date;
  readonly accuracyMeters?: number | null;
  readonly speedMps?: number | null;
}

export interface DistanceOptions {
  /** Points less accurate than this are dropped before integrating. */
  readonly maxAccuracyMeters: number;
  /** Segments implying a speed above this are treated as noise, not travel. */
  readonly maxSpeedMps: number;
  /**
   * Segments shorter than this are dropped: a stationary phone jitters by several metres, and
   * summing that jitter over a lunch break invents kilometres that were never driven.
   */
  readonly minSegmentMeters: number;
  /**
   * A gap longer than this is not bridged — the straight line across it would be a guess.
   * The distance is excluded and reported separately.
   */
  readonly maxGapSeconds: number;
}

export const DEFAULT_DISTANCE_OPTIONS: DistanceOptions = {
  maxAccuracyMeters: 100,
  maxSpeedMps: 60, // 216 km/h
  minSegmentMeters: 10,
  maxGapSeconds: 300,
};

export interface DistanceResult {
  readonly distanceMeters: number;
  readonly acceptedPoints: number;
  readonly rejectedPoints: number;
  /** Segments skipped because the time gap was too large to interpolate honestly. */
  readonly bridgedGaps: number;
  readonly gapSeconds: number;
  readonly movingSeconds: number;
}

/**
 * Reconstructs travelled distance from stored points.
 *
 * Deliberately conservative: it under-reports rather than over-reports. Distance is the input
 * to fuel-cost estimates and, in some organizations, to driver pay — inventing metres from GPS
 * noise would be the worst kind of bug this system could have.
 */
export function computeTrackDistance(
  points: readonly TrackPoint[],
  options: DistanceOptions = DEFAULT_DISTANCE_OPTIONS,
): DistanceResult {
  const ordered = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const usable = ordered.filter(
    (point) =>
      point.accuracyMeters === undefined ||
      point.accuracyMeters === null ||
      point.accuracyMeters <= options.maxAccuracyMeters,
  );

  let distance = 0;
  let bridgedGaps = 0;
  let gapSeconds = 0;
  let movingSeconds = 0;

  for (let i = 1; i < usable.length; i += 1) {
    const previous = usable[i - 1]!;
    const current = usable[i]!;
    const elapsed = (current.timestamp.getTime() - previous.timestamp.getTime()) / 1000;
    if (elapsed <= 0) continue;

    if (elapsed > options.maxGapSeconds) {
      bridgedGaps += 1;
      gapSeconds += elapsed;
      continue;
    }

    const segment = haversineMeters(previous, current);
    if (segment < options.minSegmentMeters) continue;
    if (segment / elapsed > options.maxSpeedMps) continue;

    distance += segment;
    movingSeconds += elapsed;
  }

  return {
    distanceMeters: Math.round(distance),
    acceptedPoints: usable.length,
    rejectedPoints: ordered.length - usable.length,
    bridgedGaps,
    gapSeconds: Math.round(gapSeconds),
    movingSeconds: Math.round(movingSeconds),
  };
}

export interface StopDetectionOptions {
  /** A stop needs the vehicle to stay inside this radius… */
  readonly radiusMeters: number;
  /** …for at least this long. */
  readonly minDurationSeconds: number;
}

export const DEFAULT_STOP_OPTIONS: StopDetectionOptions = {
  radiusMeters: 60,
  minDurationSeconds: 180,
};

export interface DetectedStop {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationSeconds: number;
  readonly center: GeoPoint;
}

/** Finds where the vehicle stood still — loading bays, breaks, traffic. */
export function detectStops(
  points: readonly TrackPoint[],
  options: StopDetectionOptions = DEFAULT_STOP_OPTIONS,
): readonly DetectedStop[] {
  const ordered = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const stops: DetectedStop[] = [];

  let anchorIndex = 0;
  for (let i = 1; i <= ordered.length; i += 1) {
    const anchor = ordered[anchorIndex];
    const current = ordered[i];
    if (!anchor) break;

    const leftRadius = current ? haversineMeters(anchor, current) > options.radiusMeters : true;
    if (!leftRadius) continue;

    const last = ordered[i - 1]!;
    const duration = (last.timestamp.getTime() - anchor.timestamp.getTime()) / 1000;
    if (i - 1 > anchorIndex && duration >= options.minDurationSeconds) {
      const cluster = ordered.slice(anchorIndex, i);
      stops.push({
        startedAt: anchor.timestamp,
        endedAt: last.timestamp,
        durationSeconds: Math.round(duration),
        center: centroid(cluster),
      });
    }
    anchorIndex = i;
  }

  return stops;
}

export function centroid(points: readonly GeoPoint[]): GeoPoint {
  if (points.length === 0) return { latitude: 0, longitude: 0 };
  const sum = points.reduce(
    (acc, point) => ({
      latitude: acc.latitude + point.latitude,
      longitude: acc.longitude + point.longitude,
    }),
    { latitude: 0, longitude: 0 },
  );
  return {
    latitude: roundCoordinate(sum.latitude / points.length),
    longitude: roundCoordinate(sum.longitude / points.length),
  };
}

/**
 * Rounds to six decimal places (~0.11 m).
 *
 * Storing more precision than the sensor provides is a privacy cost with no operational
 * benefit: consumer GPS is accurate to metres, not centimetres.
 */
export function roundCoordinate(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
