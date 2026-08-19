import { describe, expect, it } from 'vitest';
import {
  admitPoints,
  computeTrackDistance,
  consumptionFromRefuels,
  costPerKm,
  decideSampling,
  deriveTrackingState,
  detectStops,
  estimateFuel,
  calculateFuelTotal,
  eventForTransition,
  findTrackingGaps,
  haversineMeters,
  toLitersPer100Km,
  totalGapSeconds,
  type TrackPoint,
} from '@aytracker/tracking';
import { money } from '@aytracker/domain';

const at = (iso: string) => new Date(iso);

describe('haversineMeters', () => {
  it('measures a known distance', () => {
    // Sofia → Plovdiv, great-circle ≈ 132.5 km (the road distance is ~148 km).
    const distance = haversineMeters(
      { latitude: 42.6977, longitude: 23.3219 },
      { latitude: 42.1354, longitude: 24.7453 },
    );
    expect(distance).toBeGreaterThan(131_000);
    expect(distance).toBeLessThan(134_000);
  });

  it('returns zero for the same point', () => {
    const point = { latitude: 42.6977, longitude: 23.3219 };
    expect(haversineMeters(point, point)).toBe(0);
  });
});

describe('computeTrackDistance', () => {
  const base = at('2026-03-10T08:00:00Z');
  const point = (offsetSeconds: number, lat: number, lon: number, accuracy = 10): TrackPoint => ({
    timestamp: new Date(base.getTime() + offsetSeconds * 1000),
    latitude: lat,
    longitude: lon,
    accuracyMeters: accuracy,
  });

  it('sums consecutive segments', () => {
    const result = computeTrackDistance([
      point(0, 42.7, 23.32),
      point(60, 42.71, 23.32),
      point(120, 42.72, 23.32),
    ]);
    // Two segments of ~1.11 km each.
    expect(result.distanceMeters).toBeGreaterThan(2000);
    expect(result.distanceMeters).toBeLessThan(2400);
  });

  /**
   * The single most important behaviour here. A phone sitting on a dashboard jitters by a few
   * metres; summing that over a lunch break invents kilometres that were never driven.
   */
  it('ignores GPS jitter from a stationary vehicle', () => {
    const jitter = Array.from({ length: 60 }, (_, index) =>
      point(index * 30, 42.7 + (index % 2) * 0.00003, 23.32 + (index % 3) * 0.00002),
    );
    expect(computeTrackDistance(jitter).distanceMeters).toBe(0);
  });

  it('drops low-accuracy points before integrating', () => {
    const result = computeTrackDistance([
      point(0, 42.7, 23.32, 10),
      point(60, 43.5, 23.32, 5000),
      point(120, 42.71, 23.32, 10),
    ]);
    expect(result.rejectedPoints).toBe(1);
    expect(result.distanceMeters).toBeLessThan(2000);
  });

  it('rejects a segment implying an impossible speed', () => {
    const result = computeTrackDistance([point(0, 42.7, 23.32), point(1, 43.7, 23.32)]);
    expect(result.distanceMeters).toBe(0);
  });

  /** A gap is reported, never bridged: the straight line across it would be a guess. */
  it('does not bridge a long gap', () => {
    const result = computeTrackDistance([
      point(0, 42.7, 23.32),
      point(60, 42.71, 23.32),
      point(3600, 42.9, 23.32),
      point(3660, 42.91, 23.32),
    ]);
    expect(result.bridgedGaps).toBe(1);
    expect(result.gapSeconds).toBeGreaterThan(3000);
    // Only the two short segments are counted, not the 20 km jump across the gap.
    expect(result.distanceMeters).toBeLessThan(3000);
  });

  it('handles an empty and a single-point track', () => {
    expect(computeTrackDistance([]).distanceMeters).toBe(0);
    expect(computeTrackDistance([point(0, 42.7, 23.32)]).distanceMeters).toBe(0);
  });

  it('orders points by timestamp before integrating', () => {
    const ordered = computeTrackDistance([point(0, 42.7, 23.32), point(60, 42.71, 23.32)]);
    const shuffled = computeTrackDistance([point(60, 42.71, 23.32), point(0, 42.7, 23.32)]);
    expect(shuffled.distanceMeters).toBe(ordered.distanceMeters);
  });
});

describe('detectStops', () => {
  it('finds where the vehicle stood still', () => {
    const base = at('2026-03-10T08:00:00Z');
    const points: TrackPoint[] = [
      ...Array.from({ length: 12 }, (_, index) => ({
        timestamp: new Date(base.getTime() + index * 60_000),
        latitude: 42.7 + index * 0.00001,
        longitude: 23.32,
      })),
      { timestamp: new Date(base.getTime() + 20 * 60_000), latitude: 42.8, longitude: 23.32 },
    ];

    const stops = detectStops(points);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.durationSeconds).toBeGreaterThanOrEqual(660);
  });
});

describe('deriveTrackingState', () => {
  const now = at('2026-03-10T09:00:00Z');

  it('is ACTIVE while fresh points arrive', () => {
    expect(
      deriveTrackingState({
        tripStatus: 'ACTIVE',
        lastPointAt: at('2026-03-10T08:59:30Z'),
        lastPointAccuracyMeters: 12,
        deviceReported: null,
        now,
      }),
    ).toBe('ACTIVE');
  });

  it('is DEGRADED when points are late', () => {
    expect(
      deriveTrackingState({
        tripStatus: 'ACTIVE',
        lastPointAt: at('2026-03-10T08:58:00Z'),
        lastPointAccuracyMeters: 12,
        deviceReported: null,
        now,
      }),
    ).toBe('DEGRADED');
  });

  it('is DEGRADED when accuracy is poor even if points are fresh', () => {
    expect(
      deriveTrackingState({
        tripStatus: 'ACTIVE',
        lastPointAt: at('2026-03-10T08:59:50Z'),
        lastPointAccuracyMeters: 500,
        deviceReported: null,
        now,
      }),
    ).toBe('DEGRADED');
  });

  it('is INTERRUPTED after the stale threshold', () => {
    expect(
      deriveTrackingState({
        tripStatus: 'ACTIVE',
        lastPointAt: at('2026-03-10T08:50:00Z'),
        lastPointAccuracyMeters: 12,
        deviceReported: null,
        now,
      }),
    ).toBe('INTERRUPTED');
  });

  /** A paused trip is never called interrupted: the driver told us they stopped. */
  it('reports a paused trip as PAUSED, not INTERRUPTED', () => {
    expect(
      deriveTrackingState({
        tripStatus: 'PAUSED',
        lastPointAt: at('2026-03-10T07:00:00Z'),
        lastPointAccuracyMeters: null,
        deviceReported: null,
        now,
      }),
    ).toBe('PAUSED');
  });

  it('believes the device when it reports being offline', () => {
    expect(
      deriveTrackingState({
        tripStatus: 'ACTIVE',
        lastPointAt: at('2026-03-10T08:59:00Z'),
        lastPointAccuracyMeters: 10,
        deviceReported: 'OFFLINE',
        now,
      }),
    ).toBe('OFFLINE');
  });

  it('reports a revoked permission as INTERRUPTED — an observation, not an accusation', () => {
    const state = deriveTrackingState({
      tripStatus: 'ACTIVE',
      lastPointAt: at('2026-03-10T08:59:00Z'),
      lastPointAccuracyMeters: 10,
      deviceReported: 'PERMISSION_DENIED',
      now,
    });
    expect(state).toBe('INTERRUPTED');
    // There is no state in the model that asserts the driver did it deliberately.
    expect(['ACTIVE', 'DEGRADED', 'PAUSED', 'INTERRUPTED', 'OFFLINE', 'STOPPED']).toContain(state);
  });
});

describe('eventForTransition', () => {
  it('records recovery when reporting resumes after an interruption', () => {
    expect(eventForTransition('INTERRUPTED', 'ACTIVE')).toBe('REPORTING_RECOVERED');
  });

  it('records a start when tracking begins', () => {
    expect(eventForTransition('STOPPED', 'ACTIVE')).toBe('TRACKING_STARTED');
  });

  it('records nothing when the state has not changed', () => {
    expect(eventForTransition('ACTIVE', 'ACTIVE')).toBeNull();
  });

  it('uses neutral wording for a silent app', () => {
    expect(eventForTransition('ACTIVE', 'INTERRUPTED')).toBe('APP_NOT_REPORTING');
  });
});

describe('findTrackingGaps', () => {
  it('finds the interval where no location arrived', () => {
    // The example from the specification: last update 14:32, tracking unavailable 14:32 → 14:51.
    const gaps = findTrackingGaps({
      pointTimestamps: [at('2026-03-10T14:32:00Z'), at('2026-03-10T14:51:00Z')],
      tripStartedAt: at('2026-03-10T14:31:00Z'),
      tripEndedAt: at('2026-03-10T14:52:00Z'),
      now: at('2026-03-10T14:52:00Z'),
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.seconds).toBe(19 * 60);
    expect(gaps[0]!.startedAt.toISOString()).toBe('2026-03-10T14:32:00.000Z');
    expect(gaps[0]!.endedAt?.toISOString()).toBe('2026-03-10T14:51:00.000Z');
    expect(totalGapSeconds(gaps)).toBe(19 * 60);
  });

  /**
   * Silence between the last point and the end of the trip is untracked time too — a driver
   * whose phone died 10 minutes before arriving has 10 minutes we cannot account for, and
   * saying so is the whole point.
   */
  it('counts silence before the trip ends as a gap', () => {
    const gaps = findTrackingGaps({
      pointTimestamps: [at('2026-03-10T14:30:00Z')],
      tripStartedAt: at('2026-03-10T14:29:00Z'),
      tripEndedAt: at('2026-03-10T14:45:00Z'),
      now: at('2026-03-10T14:45:00Z'),
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.seconds).toBe(15 * 60);
    expect(gaps[0]!.isOpen).toBe(false);
  });

  it('does not count a driver-initiated pause as a gap', () => {
    const gaps = findTrackingGaps({
      pointTimestamps: [at('2026-03-10T14:00:00Z'), at('2026-03-10T15:00:00Z')],
      tripStartedAt: at('2026-03-10T14:00:00Z'),
      tripEndedAt: at('2026-03-10T15:00:00Z'),
      now: at('2026-03-10T15:00:00Z'),
      pausedIntervals: [{ start: at('2026-03-10T14:00:00Z'), end: at('2026-03-10T15:00:00Z') }],
    });
    expect(gaps).toHaveLength(0);
  });

  it('marks an ongoing gap on a live trip as open', () => {
    const gaps = findTrackingGaps({
      pointTimestamps: [at('2026-03-10T14:00:00Z')],
      tripStartedAt: at('2026-03-10T13:55:00Z'),
      tripEndedAt: null,
      now: at('2026-03-10T14:30:00Z'),
    });
    expect(gaps.at(-1)!.isOpen).toBe(true);
    expect(gaps.at(-1)!.endedAt).toBeNull();
  });
});

describe('fuel calculations', () => {
  it('matches the worked example from the specification', () => {
    // 240 km at 8 L/100 km = 19.2 L; at €1.50/L = €28.80
    const estimate = estimateFuel({
      distanceMeters: 240_000,
      averageConsumption: 8,
      consumptionUnit: 'L_PER_100KM',
      pricePerLiter: '1.50',
      currency: 'EUR',
    });
    expect(estimate.liters).toBe(19.2);
    expect(estimate.cost.amount).toBe('28.80');
    expect(estimate.isEstimate).toBe(true);
  });

  it('converts mpg to litres per 100 km', () => {
    expect(toLitersPer100Km(30, 'MPG_US')).toBeCloseTo(7.84, 2);
    expect(toLitersPer100Km(30, 'MPG_UK')).toBeCloseTo(9.42, 2);
  });

  /** The client's total is never trusted; it is recomputed from litres and unit price. */
  it('computes a fuel total from litres and unit price', () => {
    expect(
      calculateFuelTotal({ liters: '62.4', pricePerLiter: '1.49', currency: 'EUR' }).amount,
    ).toBe('92.98');
  });

  it('rejects a non-positive litre quantity', () => {
    expect(() =>
      calculateFuelTotal({ liters: '0', pricePerLiter: '1.49', currency: 'EUR' }),
    ).toThrowError(/positive/i);
  });

  it('computes real consumption between two full-tank refuels', () => {
    // 500 km on 42 L → 8.4 L/100 km
    expect(
      consumptionFromRefuels({ previousOdometer: 147_820, currentOdometer: 148_320, liters: 42 }),
    ).toBe(8.4);
  });

  it('refuses a backwards odometer span', () => {
    expect(() =>
      consumptionFromRefuels({ previousOdometer: 148_320, currentOdometer: 147_820, liters: 42 }),
    ).toThrowError(/must exceed/i);
  });

  it('computes cost per km', () => {
    expect(costPerKm({ totalCost: money('92.98', 'EUR'), distanceMeters: 148_000 })?.amount).toBe(
      '0.63',
    );
  });

  /** Zero distance returns null, not zero: "no data" and "free" are different claims. */
  it('returns null cost per km for zero distance', () => {
    expect(costPerKm({ totalCost: money('92.98', 'EUR'), distanceMeters: 0 })).toBeNull();
  });
});

describe('adaptive sampling', () => {
  const now = at('2026-03-10T09:00:00Z');
  const point = { latitude: 42.7, longitude: 23.32 };

  it('always sends the first point', () => {
    const decision = decideSampling({
      lastSentAt: null,
      lastSentPoint: null,
      current: point,
      currentSpeedMps: 20,
      batteryLevel: 0.8,
      now,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe('FIRST_POINT');
  });

  it('refuses to send faster than the minimum interval', () => {
    const decision = decideSampling({
      lastSentAt: at('2026-03-10T08:59:55Z'),
      lastSentPoint: point,
      current: { latitude: 42.75, longitude: 23.32 },
      currentSpeedMps: 25,
      batteryLevel: 0.8,
      now,
    });
    expect(decision.shouldSend).toBe(false);
    expect(decision.reason).toBe('BELOW_MIN_INTERVAL');
  });

  it('sends once the vehicle has moved far enough', () => {
    const decision = decideSampling({
      lastSentAt: at('2026-03-10T08:59:30Z'),
      lastSentPoint: point,
      current: { latitude: 42.702, longitude: 23.32 },
      currentSpeedMps: 25,
      batteryLevel: 0.8,
      now,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe('DISTANCE_THRESHOLD');
  });

  it('backs off when the battery is low', () => {
    const decision = decideSampling({
      lastSentAt: at('2026-03-10T08:59:00Z'),
      lastSentPoint: point,
      current: point,
      currentSpeedMps: 25,
      batteryLevel: 0.1,
      now,
    });
    expect(decision.shouldSend).toBe(false);
    expect(decision.nextCheckSeconds).toBeGreaterThan(60);
  });

  it('slows right down while stationary', () => {
    const decision = decideSampling({
      lastSentAt: at('2026-03-10T08:59:00Z'),
      lastSentPoint: point,
      current: point,
      currentSpeedMps: 0.2,
      batteryLevel: 0.9,
      now,
    });
    expect(decision.shouldSend).toBe(false);
  });
});

describe('admitPoints', () => {
  const base = at('2026-03-10T08:00:00Z');

  /**
   * Server-side admission control. The device decides what to send; the server decides what to
   * keep — so an over-eager or hostile client cannot flood the table.
   */
  it('drops points arriving faster than the floor', () => {
    const points = Array.from({ length: 20 }, (_, index) => ({
      timestamp: new Date(base.getTime() + index * 1000),
    }));
    const result = admitPoints(points, { lastAcceptedAt: null, minIntervalSeconds: 15 });
    expect(result.accepted.length).toBeLessThanOrEqual(3);
    expect(result.dropped).toBeGreaterThan(15);
  });

  it('accepts points at the configured cadence', () => {
    const points = Array.from({ length: 5 }, (_, index) => ({
      timestamp: new Date(base.getTime() + index * 20_000),
    }));
    const result = admitPoints(points, { lastAcceptedAt: null, minIntervalSeconds: 15 });
    expect(result.accepted).toHaveLength(5);
    expect(result.dropped).toBe(0);
  });
});
