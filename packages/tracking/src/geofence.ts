import type { GeoPoint } from '@aytracker/types';
import { haversineMeters, type TrackPoint } from './geo.js';

/**
 * Geofences: places that matter, and the arithmetic of entering and leaving one.
 *
 * A geofence answers questions an operations manager actually asks — did the van reach the
 * customer, how long was it at the depot, is anyone inside the yard right now. It is a circle
 * on the map, not a policy: nothing here decides what a visit *means*.
 *
 * Two problems make the naive version useless, and both are solved here rather than in the
 * caller.
 *
 * **Flapping.** A phone parked on the boundary reports 48 m, 51 m, 49 m, 52 m — the fence would
 * fire enter/exit every fifteen seconds all afternoon, and a supervisor would switch the alerts
 * off by lunchtime. So the fence has two radii: you are inside once you cross the radius, and
 * outside only once you pass a wider one. The band between them is where nothing happens.
 *
 * **Noise.** A single wild fix — a reflected signal off a warehouse wall, a network-derived
 * position with 300 m of error — must not manufacture a visit to a place nobody went. So a
 * crossing has to hold for a minimum time before it counts, and fixes too inaccurate to place
 * inside the fence at all are ignored rather than guessed at.
 *
 * Everything is computed from the stored points and is therefore reproducible: run it twice on
 * the same day and it produces the same visits, which is what makes it safe to recompute after
 * an offline replay arrives late and changes the middle of an afternoon.
 */

export interface Geofence {
  readonly id: string;
  readonly name: string;
  readonly center: GeoPoint;
  readonly radiusMeters: number;
}

export interface GeofenceOptions {
  /**
   * How far past the radius you must travel before you count as having left.
   *
   * The anti-flap band. Wide enough to swallow ordinary GPS scatter next to a building, narrow
   * enough that leaving a site is detected before the van reaches the next street.
   */
  readonly exitHysteresisMeters: number;
  /**
   * How long a crossing must hold before it is believed.
   *
   * A visit shorter than this is not reported at all: at motorway speed a fence 100 m across is
   * crossed in four seconds, and "visited the depot" is not a true description of driving past
   * it.
   */
  readonly debounceSeconds: number;
  /**
   * Fixes less accurate than this are skipped.
   *
   * A point with 200 m of error cannot place anyone inside a 100 m fence. Skipping it leaves
   * the previous state standing, which is the honest answer: we do not know, so nothing changed.
   */
  readonly maxAccuracyMeters: number;
}

export const DEFAULT_GEOFENCE_OPTIONS: GeofenceOptions = {
  exitHysteresisMeters: 40,
  debounceSeconds: 90,
  maxAccuracyMeters: 100,
};

export interface GeofenceVisit {
  readonly geofenceId: string;
  readonly enteredAt: Date;
  /** Null while the visit is still open at the end of the point stream. */
  readonly exitedAt: Date | null;
  /** Wall-clock seconds between entry and exit, or entry and the last known fix. */
  readonly dwellSeconds: number;
  /** Where the crossing was observed. The fix that confirmed it, not the fence centre. */
  readonly entryLatitude: number;
  readonly entryLongitude: number;
}

/**
 * Every visit to every fence, from one ordered stream of points.
 *
 * O(points × fences), which is the same shape as the distance computation that already runs on
 * every batch. Fences are few — a site, a handful of customers — and points are thinned to the
 * sampling floor before they get here.
 */
export function detectGeofenceVisits(
  points: readonly TrackPoint[],
  fences: readonly Geofence[],
  options: GeofenceOptions = DEFAULT_GEOFENCE_OPTIONS,
): readonly GeofenceVisit[] {
  if (points.length === 0 || fences.length === 0) return [];

  const ordered = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const visits: GeofenceVisit[] = [];

  for (const fence of fences) {
    visits.push(...visitsForFence(ordered, fence, options));
  }

  return visits.sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime());
}

function visitsForFence(
  ordered: readonly TrackPoint[],
  fence: Geofence,
  options: GeofenceOptions,
): readonly GeofenceVisit[] {
  const visits: GeofenceVisit[] = [];

  /** Confirmed state. What we currently believe about this fence. */
  let inside = false;
  /** The candidate crossing we are waiting to confirm, and the fix that started it. */
  let pending: { readonly inside: boolean; readonly point: TrackPoint } | null = null;
  /** The open visit's entry fix, once a crossing has been confirmed. */
  let openedAt: TrackPoint | null = null;
  let lastPoint: TrackPoint | null = null;

  for (const point of ordered) {
    if (
      point.accuracyMeters !== null &&
      point.accuracyMeters !== undefined &&
      point.accuracyMeters > options.maxAccuracyMeters
    ) {
      // Too vague to place. The previous belief stands.
      continue;
    }
    lastPoint = point;

    const distance = haversineMeters(fence.center, point);
    /*
     * The hysteresis band. Entering takes crossing the radius; leaving takes crossing a wider
     * one, so a phone sitting on the line does not produce a stream of transitions.
     */
    const observed: boolean = inside
      ? distance <= fence.radiusMeters + options.exitHysteresisMeters
      : distance <= fence.radiusMeters;

    if (observed === inside) {
      // Nothing to confirm; any candidate crossing has been contradicted.
      pending = null;
      continue;
    }

    if (pending === null) {
      pending = { inside: observed, point };
      continue;
    }

    const heldSeconds = (point.timestamp.getTime() - pending.point.timestamp.getTime()) / 1000;
    if (heldSeconds < options.debounceSeconds) continue;

    // Confirmed. The crossing is dated from the fix that first observed it, not from the one
    // that confirmed it — the van arrived when it arrived, not ninety seconds later.
    inside = observed;
    if (inside) {
      openedAt = pending.point;
    } else if (openedAt) {
      visits.push(closeVisit(fence, openedAt, pending.point.timestamp));
      openedAt = null;
    }
    pending = null;
  }

  // A visit still open when the points run out is reported open, with dwell measured to the last
  // fix we have. Guessing an exit that was never observed would invent a departure.
  if (inside && openedAt) {
    visits.push({
      geofenceId: fence.id,
      enteredAt: openedAt.timestamp,
      exitedAt: null,
      dwellSeconds: lastPoint
        ? Math.max(
            0,
            Math.round((lastPoint.timestamp.getTime() - openedAt.timestamp.getTime()) / 1000),
          )
        : 0,
      entryLatitude: openedAt.latitude,
      entryLongitude: openedAt.longitude,
    });
  }

  return visits;
}

function closeVisit(fence: Geofence, entry: TrackPoint, exitedAt: Date): GeofenceVisit {
  return {
    geofenceId: fence.id,
    enteredAt: entry.timestamp,
    exitedAt,
    dwellSeconds: Math.max(0, Math.round((exitedAt.getTime() - entry.timestamp.getTime()) / 1000)),
    entryLatitude: entry.latitude,
    entryLongitude: entry.longitude,
  };
}

/** Whether a single point falls inside a fence. For "who is on site right now" reads. */
export function isInsideGeofence(point: GeoPoint, fence: Geofence): boolean {
  return haversineMeters(fence.center, point) <= fence.radiusMeters;
}
