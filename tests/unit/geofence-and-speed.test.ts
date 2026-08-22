import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEOFENCE_OPTIONS,
  DEFAULT_SPEED_ALERT_OPTIONS,
  detectGeofenceVisits,
  detectSpeedAlerts,
  isInsideGeofence,
  speedKphAt,
  type Geofence,
  type TrackPoint,
} from '@aytracker/tracking';

/**
 * Geofences and speed alerts.
 *
 * Both features exist to produce a small number of true statements, and both fail in the same
 * way if written naively: they produce a large number of technically-defensible ones instead.
 * A fence that fires every fifteen seconds and a speed alert per GPS sample are worse than no
 * feature, because the supervisor turns them off and stops seeing the one that mattered.
 *
 * So most of what is tested here is restraint.
 */

const DEPOT: Geofence = {
  id: 'fence-depot',
  name: 'Депо',
  center: { latitude: 42.7, longitude: 23.32 },
  radiusMeters: 150,
};

const START = new Date('2026-03-10T08:00:00Z');

/** A point `seconds` into the day, `meters` east of the depot centre. */
function near(seconds: number, meters: number, overrides: Partial<TrackPoint> = {}): TrackPoint {
  // At this latitude one degree of longitude is roughly 81.9 km.
  const degrees = meters / 81_900;
  return {
    timestamp: new Date(START.getTime() + seconds * 1000),
    latitude: DEPOT.center.latitude,
    longitude: DEPOT.center.longitude + degrees,
    accuracyMeters: 8,
    speedMps: 0,
    ...overrides,
  } as TrackPoint;
}

describe('geofences', () => {
  it('records one visit for an arrival, a stay and a departure', () => {
    const points = [
      near(0, 600),
      near(60, 400),
      near(120, 50), // arrived
      near(180, 40),
      near(240, 45),
      near(300, 60),
      // Leaving, and staying gone: a departure has to hold past the debounce just as an arrival
      // does, or backing the van out of the gate would end the visit.
      near(360, 600),
      near(420, 900),
      near(480, 1400),
    ];

    const visits = detectGeofenceVisits(points, [DEPOT]);
    expect(visits).toHaveLength(1);
    expect(visits[0]!.geofenceId).toBe('fence-depot');
    expect(visits[0]!.enteredAt.toISOString()).toBe(near(120, 0).timestamp.toISOString());
    expect(visits[0]!.exitedAt?.toISOString()).toBe(near(360, 0).timestamp.toISOString());
    expect(visits[0]!.dwellSeconds).toBe(240);
  });

  /**
   * The failure that makes a geofence unusable in production. A phone parked on the boundary
   * scatters either side of it all afternoon; without hysteresis and a debounce that is a
   * transition every fifteen seconds and an alert list nobody reads.
   */
  it('does not flap when a device sits on the boundary', () => {
    const scatter = [148, 152, 149, 153, 147, 151, 150, 154, 146, 152];
    const points = scatter.map((meters, index) => near(index * 15, meters));

    const visits = detectGeofenceVisits(points, [DEPOT]);
    // One visit at most — never one per crossing of the line.
    expect(visits.length).toBeLessThanOrEqual(1);
  });

  it('does not invent a visit from driving past', () => {
    // Through the fence at speed: two fixes inside, twenty seconds apart.
    const points = [near(0, 900), near(20, 100), near(40, 80), near(60, 900), near(80, 2000)];
    expect(detectGeofenceVisits(points, [DEPOT])).toHaveLength(0);
  });

  it('ignores fixes too inaccurate to place anyone inside the fence', () => {
    const points = [
      near(0, 900),
      near(60, 50, { accuracyMeters: 400 }),
      near(120, 50, { accuracyMeters: 400 }),
      near(180, 50, { accuracyMeters: 400 }),
      near(240, 900),
    ];
    // A 400 m error cannot place a device inside a 150 m fence. Nothing is concluded.
    expect(detectGeofenceVisits(points, [DEPOT])).toHaveLength(0);
  });

  it('reports a visit that is still open, rather than inventing a departure', () => {
    const points = [near(0, 900), near(60, 40), near(120, 35), near(180, 30), near(240, 42)];
    const visits = detectGeofenceVisits(points, [DEPOT]);
    expect(visits).toHaveLength(1);
    expect(visits[0]!.exitedAt).toBeNull();
    expect(visits[0]!.dwellSeconds).toBe(180);
  });

  it('handles several fences over one stream', () => {
    const yard: Geofence = { ...DEPOT, id: 'fence-yard', name: 'Двор', radiusMeters: 1000 };
    const points = [near(0, 2000), near(60, 40), near(120, 35), near(180, 30), near(240, 2000)];
    const visits = detectGeofenceVisits(points, [DEPOT, yard]);
    expect(new Set(visits.map((visit) => visit.geofenceId))).toEqual(
      new Set(['fence-depot', 'fence-yard']),
    );
  });

  it('answers a point-in-fence question directly', () => {
    expect(isInsideGeofence({ latitude: 42.7, longitude: 23.32 }, DEPOT)).toBe(true);
    expect(isInsideGeofence({ latitude: 42.8, longitude: 23.32 }, DEPOT)).toBe(false);
  });

  it('has no opinion when there are no fences', () => {
    expect(detectGeofenceVisits([near(0, 10)], [])).toEqual([]);
    expect(DEFAULT_GEOFENCE_OPTIONS.debounceSeconds).toBeGreaterThan(0);
  });
});

describe('speed alerts', () => {
  const options = { ...DEFAULT_SPEED_ALERT_OPTIONS, limitKph: 90 };

  /** A point at a given speed, spaced a minute apart so the stretch is sustained. */
  function driving(index: number, kph: number, overrides: Partial<TrackPoint> = {}): TrackPoint {
    return {
      timestamp: new Date(START.getTime() + index * 60_000),
      latitude: 42.7 + index * 0.01,
      longitude: 23.32 + index * 0.01,
      accuracyMeters: 8,
      speedMps: kph / 3.6,
      ...overrides,
    } as TrackPoint;
  }

  it('reports one alert for one continuous stretch, not one per sample', () => {
    const points = [
      driving(0, 80),
      driving(1, 105),
      driving(2, 118),
      driving(3, 112),
      driving(4, 99),
      driving(5, 70),
    ];
    const alerts = detectSpeedAlerts(points, options);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.peakKph).toBe(118);
    expect(alerts[0]!.limitKph).toBe(90);
    expect(alerts[0]!.source).toBe('DEVICE');
  });

  it('places the alert where the worst of it happened', () => {
    const points = [driving(0, 95), driving(1, 130), driving(2, 95), driving(3, 40)];
    const alerts = detectSpeedAlerts(points, options);
    expect(alerts[0]!.latitude).toBeCloseTo(driving(1, 130).latitude, 5);
  });

  it('says nothing at all when no limit is configured', () => {
    const points = [driving(0, 160), driving(1, 170), driving(2, 180)];
    // A limit of zero is "not configured", not "alert on everything".
    expect(detectSpeedAlerts(points, { ...options, limitKph: 0 })).toEqual([]);
  });

  it('ignores a single wild reading', () => {
    const points = [driving(0, 50), driving(1, 210), driving(2, 50), driving(3, 50)];
    // One sample over the line is a measurement, not driving. Sixty seconds is over the
    // sustained threshold, so this is held by the stretch ending immediately.
    const alerts = detectSpeedAlerts(points, { ...options, sustainedSeconds: 120 });
    expect(alerts).toEqual([]);
  });

  it('does not report a second alert inside the cooldown', () => {
    const points = [
      driving(0, 120),
      driving(1, 125),
      driving(2, 60), // dropped below
      driving(3, 121), // straight back over, two minutes later
      driving(4, 124),
      driving(5, 50),
    ];
    const alerts = detectSpeedAlerts(points, { ...options, cooldownSeconds: 600 });
    expect(alerts).toHaveLength(1);
  });

  it('reports again once the cooldown has passed', () => {
    const points = [
      driving(0, 120),
      driving(1, 125),
      driving(2, 60),
      driving(30, 121), // half an hour later
      driving(31, 124),
      driving(32, 50),
    ];
    const alerts = detectSpeedAlerts(points, { ...options, cooldownSeconds: 600 });
    expect(alerts).toHaveLength(2);
  });

  it('skips fixes too inaccurate to support a speed claim', () => {
    const points = [
      driving(0, 130, { accuracyMeters: 300 }),
      driving(1, 140, { accuracyMeters: 300 }),
      driving(2, 40),
    ];
    expect(detectSpeedAlerts(points, options)).toEqual([]);
  });

  /**
   * A GPS receiver measures velocity from Doppler shift and is good at it. Dividing distance by
   * time turns every position error into a speed error, so it is the fallback, and it is
   * labelled as weaker evidence when it is used.
   */
  it('prefers the device’s own speed and falls back to a derived one', () => {
    const device = speedKphAt(driving(1, 100), driving(0, 100));
    expect(device).toEqual({ kph: expect.closeTo(100, 6), source: 'DEVICE' });

    const a = { ...driving(0, 0), speedMps: null } as TrackPoint;
    const b = { ...driving(1, 0), speedMps: null } as TrackPoint;
    const derived = speedKphAt(b, a);
    expect(derived?.source).toBe('DERIVED');
    expect(derived!.kph).toBeGreaterThan(0);
  });

  it('cannot derive a speed from a single point', () => {
    const only = { ...driving(0, 0), speedMps: null } as TrackPoint;
    expect(speedKphAt(only, null)).toBeNull();
  });
});
