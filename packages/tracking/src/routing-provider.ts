import type { GeoPoint } from '@aytracker/types';
import { computeTrackDistance, type TrackPoint } from './geo.js';

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
  readonly points: readonly GeoPoint[];
  readonly distanceMeters: number;
  /** Indices in `points` after which a tracking gap occurs — rendered as a break in the line. */
  readonly gapAfterIndices: readonly number[];
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

  async reconstruct(points: readonly TrackPoint[]): Promise<ReconstructedRoute> {
    const ordered = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const result = computeTrackDistance(ordered, {
      maxAccuracyMeters: 100,
      maxSpeedMps: 60,
      minSegmentMeters: 10,
      maxGapSeconds: this.maxGapSeconds,
    });

    const gapAfterIndices: number[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const elapsed =
        (ordered[i]!.timestamp.getTime() - ordered[i - 1]!.timestamp.getTime()) / 1000;
      if (elapsed > this.maxGapSeconds) gapAfterIndices.push(i - 1);
    }

    return {
      points: ordered.map((point) => ({ latitude: point.latitude, longitude: point.longitude })),
      distanceMeters: result.distanceMeters,
      gapAfterIndices,
    };
  }
}
