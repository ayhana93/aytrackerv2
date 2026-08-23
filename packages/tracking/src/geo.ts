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
  /**
   * Indices into the **usable** sequence — `usableTrackPoints(points, options)` — after which
   * the integrator refused to connect two fixes, because the silence was too long or the
   * implied speed was impossible.
   *
   * It exists so a renderer can break the line in exactly the places the distance was not
   * counted. Anything that draws a polyline from the raw rows instead will draw a straight line
   * through metres this function declined to believe, and the picture will disagree with the
   * number printed beside it.
   */
  readonly breakAfterIndices: readonly number[];
}

/**
 * The points the integrator will actually walk: time-ordered, and accurate enough to place the
 * subject anywhere in particular.
 *
 * Exported because the route renderer must draw *these* points and no others. A fix with a
 * two-kilometre error radius is not evidence of a location, and a polyline that includes it puts
 * a vertex — a spike out to a street the vehicle was never on — into a picture someone prints and
 * puts in front of a driver.
 */
export function usableTrackPoints(
  points: readonly TrackPoint[],
  options: DistanceOptions = DEFAULT_DISTANCE_OPTIONS,
): readonly TrackPoint[] {
  return [...points]
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .filter(
      (point) =>
        point.accuracyMeters === undefined ||
        point.accuracyMeters === null ||
        point.accuracyMeters <= options.maxAccuracyMeters,
    );
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
  const usable = usableTrackPoints(points, options);

  let distance = 0;
  let bridgedGaps = 0;
  let gapSeconds = 0;
  let movingSeconds = 0;
  const breakAfterIndices: number[] = [];

  for (let i = 1; i < usable.length; i += 1) {
    const previous = usable[i - 1]!;
    const current = usable[i]!;
    const elapsed = (current.timestamp.getTime() - previous.timestamp.getTime()) / 1000;
    // Two fixes stamped at the same instant: a duplicate, or a replay of a batch already stored.
    // Nothing travelled between them, and there is no line to break either.
    if (elapsed <= 0) continue;

    if (elapsed > options.maxGapSeconds) {
      bridgedGaps += 1;
      gapSeconds += elapsed;
      breakAfterIndices.push(i - 1);
      continue;
    }

    const segment = haversineMeters(previous, current);
    // Below the jitter floor: the same place twice, so the line stays whole.
    if (segment < options.minSegmentMeters) continue;
    if (segment / elapsed > options.maxSpeedMps) {
      // A teleport. The distance is not counted, so the line must not be drawn either.
      breakAfterIndices.push(i - 1);
      continue;
    }

    distance += segment;
    movingSeconds += elapsed;
  }

  return {
    distanceMeters: Math.round(distance),
    acceptedPoints: usable.length,
    rejectedPoints: points.length - usable.length,
    bridgedGaps,
    gapSeconds: Math.round(gapSeconds),
    movingSeconds: Math.round(movingSeconds),
    breakAfterIndices,
  };
}

export interface StopDetectionOptions {
  /** A stop needs the vehicle to stay inside this radius… */
  readonly radiusMeters: number;
  /** …for at least this long. */
  readonly minDurationSeconds: number;
  /**
   * Longer than this between two reports and the cluster breaks.
   *
   * Silence is not a stop. If the device reported nothing for half an hour, we do not know the
   * vehicle stood still — it may have driven a hundred kilometres and come back to the same
   * street. Two points an hour apart in the same car park are one arrival and one departure, and
   * calling that a one-hour stop asserts something the data does not support. The silence is
   * already reported for what it is, by `findTrackingGaps`.
   */
  readonly maxGapSeconds: number;
  /** Points less accurate than this are not evidence of standing anywhere in particular. */
  readonly maxAccuracyMeters: number;
}

export const DEFAULT_STOP_OPTIONS: StopDetectionOptions = {
  radiusMeters: 60,
  minDurationSeconds: 180,
  // The same threshold the distance integrator and the gap finder use, so all three agree on
  // what counts as a break in the record.
  maxGapSeconds: 300,
  maxAccuracyMeters: 100,
};

export interface DetectedStop {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationSeconds: number;
  readonly center: GeoPoint;
}

/**
 * Finds where the vehicle stood still — loading bays, breaks, traffic.
 *
 * Anchored on the cluster's first point rather than a rolling centre: an anchor that moves with
 * the cluster can drift, one radius at a time, along a road the vehicle was slowly driving down,
 * and report a crawling traffic jam as a stop.
 */
export function detectStops(
  points: readonly TrackPoint[],
  options: StopDetectionOptions = DEFAULT_STOP_OPTIONS,
): readonly DetectedStop[] {
  const ordered = [...points]
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .filter(
      (point) =>
        point.accuracyMeters === null ||
        point.accuracyMeters === undefined ||
        point.accuracyMeters <= options.maxAccuracyMeters,
    );
  const stops: DetectedStop[] = [];

  let anchorIndex = 0;
  for (let i = 1; i <= ordered.length; i += 1) {
    const anchor = ordered[anchorIndex];
    const current = ordered[i];
    if (!anchor) break;

    const previous = ordered[i - 1]!;
    const silence = current
      ? (current.timestamp.getTime() - previous.timestamp.getTime()) / 1000
      : 0;
    // A break in the record ends the cluster wherever it falls, even inside the radius.
    const leftRadius = current
      ? haversineMeters(anchor, current) > options.radiusMeters || silence > options.maxGapSeconds
      : true;
    if (!leftRadius) continue;

    const last = previous;
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
