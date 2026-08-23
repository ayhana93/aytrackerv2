import type { GeoPoint } from '@aytracker/types';
import { computeTrackDistance, usableTrackPoints, type TrackPoint } from './geo.js';

/**
 * RoutingProvider — the seam between the tracking domain and any map/routing vendor.
 *
 * The domain never imports Google Maps, Mapbox, OSRM or anything else. Distance and route
 * reconstruction from our own stored points are always available through the built-in
 * provider below; a vendor is only ever an enhancement (road snapping, human-readable place
 * names), never a dependency the system stops working without.
 */

export interface RouteSegment {
  readonly from: GeoPoint;
  readonly to: GeoPoint;
  readonly distanceMeters: number;
}

export interface ReconstructedRoute {
  /**
   * The vertices the line is drawn through — the fixes the distance was actually integrated
   * from, not every row in the table. A point too inaccurate to place the subject anywhere is
   * not a place they went, and is left out of both.
   */
  readonly points: readonly GeoPoint[];
  /** Indices in `points` after which a tracking gap occurs — rendered as a break in the line. */
  readonly gapAfterIndices: readonly number[];
  readonly distanceMeters: number;
}

export interface PlaceLabel {
  readonly label: string;
  readonly countryCode?: string;
}

export interface RoutingProvider {
  readonly name: string;
  /** Rebuilds the travelled route from stored points. Must work offline from our own data. */
  reconstruct(points: readonly TrackPoint[]): Promise<ReconstructedRoute>;
  /** Optional: a human-readable label for a point. Null when the provider cannot supply one. */
  reverseGeocode?(point: GeoPoint): Promise<PlaceLabel | null>;
}

/**
 * The default provider: pure geometry over our own points, no network calls, no API key.
 *
 * This is what runs unless an organization opts into a vendor, which means route history and
 * distance keep working when a vendor is down, rate-limited or unpaid.
 */
export class HaversineRoutingProvider implements RoutingProvider {
  readonly name = 'haversine';

  constructor(private readonly maxGapSeconds = 300) {}

  /**
   * The drawn line and the reported distance come from the same walk over the same points.
   *
   * They used to come from two: distance from the filtered sequence, the polyline from every
   * stored row, and the breaks from the raw timeline. That is three ways to disagree, and all
   * three showed up on the same screen. A stretch where the phone reported nothing but 2 km
   * cell-tower fixes has no silence in the raw timeline, so the line was drawn straight across
   * minutes the integrator had already refused to count — the exact fabrication
   * `gapAfterIndices` exists to prevent — and each of those fixes was drawn as a place the
   * vehicle had been.
   *
   * So: filter once, integrate once, and break the line wherever the integration refused to
   * bridge. What the map shows is now what the distance is made of.
   */
  async reconstruct(points: readonly TrackPoint[]): Promise<ReconstructedRoute> {
    const options = {
      maxAccuracyMeters: 100,
      maxSpeedMps: 60,
      minSegmentMeters: 10,
      maxGapSeconds: this.maxGapSeconds,
    };
    const usable = usableTrackPoints(points, options);
    const result = computeTrackDistance(usable, options);

    return {
      points: usable.map((point) => ({ latitude: point.latitude, longitude: point.longitude })),
      gapAfterIndices: result.breakAfterIndices,
      distanceMeters: result.distanceMeters,
    };
  }
}
