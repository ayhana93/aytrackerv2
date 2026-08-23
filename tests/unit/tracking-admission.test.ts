import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MAX_LOCATION_BATCH_SIZE,
  admitPoints,
  tripForTimestamp,
  type TrackingSessionState,
} from '@aytracker/module-tracking';
import { ValidationError, PreconditionFailedError } from '@aytracker/domain';

/**
 * Server-side admission: what a device is allowed to add to the record.
 *
 * These tests defend the boundary between "what a phone claims" and "what the company is
 * invoiced for". Every number a customer sees — hours, kilometres, litres, leva — is derived
 * from the rows this function decides to keep, so a client that lies, drifts or misbehaves has
 * to be stopped here rather than filtered out by whoever reads the map later.
 */

const SESSION_START = new Date('2026-03-10T08:00:00Z');
const NOW = new Date('2026-03-10T12:00:00Z');

function session(overrides: Partial<TrackingSessionState> = {}): TrackingSessionState {
  return {
    id: 'session-1',
    organizationId: 'org-1',
    context: 'WORK',
    workerId: 'worker-1',
    driverId: null,
    shiftId: 'shift-1',
    tripId: null,
    vehicleId: null,
    startedAt: SESSION_START,
    endedAt: null,
    ...overrides,
  } as TrackingSessionState;
}

function fix(timestamp: Date, latitude = 42.7, longitude = 23.32) {
  return { timestamp, latitude, longitude, accuracyMeters: 8, speedMps: 12 };
}

describe('admitPoints — the session gate', () => {
  it('refuses everything when there is no session', () => {
    expect(() =>
      admitPoints({
        session: null,
        points: [fix(NOW)],
        trip: null,
        now: NOW,
        backfillThresholdSeconds: 120,
      }),
    ).toThrow(PreconditionFailedError);
  });

  it('refuses everything once the session is closed', () => {
    expect(() =>
      admitPoints({
        session: session({ endedAt: new Date('2026-03-10T11:00:00Z') }),
        points: [fix(NOW)],
        trip: null,
        now: NOW,
        backfillThresholdSeconds: 120,
      }),
    ).toThrow(PreconditionFailedError);
  });

  it('caps a batch, because this is the easiest endpoint to flood', () => {
    const points = Array.from({ length: MAX_LOCATION_BATCH_SIZE + 1 }, (_, index) =>
      fix(new Date(SESSION_START.getTime() + index * 1000)),
    );
    expect(() =>
      admitPoints({
        session: session(),
        points,
        trip: null,
        now: NOW,
        backfillThresholdSeconds: 120,
      }),
    ).toThrow(ValidationError);
  });
});

describe('admitPoints — timestamps outside the session window', () => {
  /**
   * The rule that matters most here.
   *
   * Dragging an out-of-window fix to the nearest edge would place an employee somewhere they
   * were not, at a time they were not there — and the distance, the route and the fuel figure
   * derived from it would all then be wrong. A fix we cannot place in this session is not
   * evidence about this session, so it is dropped and counted rather than moved.
   */
  it('rejects a fix from a previous day instead of clamping it to the session start', () => {
    const result = admitPoints({
      session: session(),
      points: [fix(new Date('2026-03-09T08:00:00Z'), 41, 22)],
      trip: null,
      now: NOW,
      backfillThresholdSeconds: 120,
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toBe(1);
    expect(result.clamped).toBe(0);
  });

  it('rejects a fix from the future instead of clamping it to now', () => {
    const result = admitPoints({
      session: session(),
      points: [fix(new Date('2026-03-10T15:00:00Z'), 41, 22)],
      trip: null,
      now: NOW,
      backfillThresholdSeconds: 120,
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toBe(1);
  });

  /**
   * Real clock drift is corrected rather than punished. A phone whose clock is a minute fast is
   * still reporting where it genuinely is, and losing those fixes would blank the live map for
   * an employee who did nothing wrong.
   */
  it('clamps drift small enough to be a clock artefact', () => {
    const withinTolerance = new Date(NOW.getTime() + (CLOCK_SKEW_TOLERANCE_SECONDS - 5) * 1000);
    const result = admitPoints({
      session: session(),
      points: [fix(withinTolerance)],
      trip: null,
      now: NOW,
      backfillThresholdSeconds: 120,
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.clamped).toBe(1);
    expect(result.accepted[0]!.timestamp.toISOString()).toBe(NOW.toISOString());
  });

  it('keeps a queued offline replay from inside the window', () => {
    const points = Array.from({ length: 20 }, (_, index) =>
      fix(new Date(SESSION_START.getTime() + (index + 1) * 60_000)),
    );
    const result = admitPoints({
      session: session(),
      points,
      trip: null,
      now: NOW,
      backfillThresholdSeconds: 120,
    });
    expect(result.accepted).toHaveLength(20);
    expect(result.rejected).toBe(0);
    // Hours old on arrival: recorded as backfill so the reader knows it was not live.
    expect(result.accepted.every((point) => point.isBackfilled)).toBe(true);
  });
});

describe('admitPoints — coordinates', () => {
  it('drops malformed coordinates rather than storing them', () => {
    const result = admitPoints({
      session: session(),
      points: [
        fix(new Date('2026-03-10T09:00:00Z'), Number.NaN, 23),
        fix(new Date('2026-03-10T09:01:00Z'), 91, 23),
        fix(new Date('2026-03-10T09:02:00Z'), 42, 181),
        fix(new Date('2026-03-10T09:03:00Z'), 42.7, 23.3),
      ],
      trip: null,
      now: NOW,
      backfillThresholdSeconds: 120,
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toBe(3);
  });

  it('drops a negative accuracy, which is not a reading', () => {
    const result = admitPoints({
      session: session(),
      points: [{ ...fix(new Date('2026-03-10T09:00:00Z')), accuracyMeters: -1 }],
      trip: null,
      now: NOW,
      backfillThresholdSeconds: 120,
    });
    expect(result.rejected).toBe(1);
  });
});

describe('the trip overlay is decided by the server, from the timestamp', () => {
  const trip = {
    id: 'trip-1',
    startedAt: new Date('2026-03-10T09:00:00Z'),
    endedAt: new Date('2026-03-10T10:00:00Z'),
  };

  it('splits one batch across the moment the trip ended', () => {
    const result = admitPoints({
      session: session(),
      points: [
        fix(new Date('2026-03-10T08:30:00Z')), // before the trip: the working day
        fix(new Date('2026-03-10T09:30:00Z')), // during the trip
        fix(new Date('2026-03-10T10:30:00Z')), // after it: the working day again
      ],
      trip,
      now: NOW,
      backfillThresholdSeconds: 120,
    });
    expect(result.accepted.map((point) => point.tripId)).toEqual([null, 'trip-1', null]);
  });

  it('places the boundaries where a half-open interval puts them', () => {
    expect(tripForTimestamp(trip.startedAt, trip)).toBe('trip-1');
    expect(tripForTimestamp(trip.endedAt, trip)).toBeNull();
  });

  it('attributes nothing when no trip is running', () => {
    const result = admitPoints({
      session: session(),
      points: [fix(new Date('2026-03-10T09:30:00Z'))],
      trip: null,
      now: NOW,
      backfillThresholdSeconds: 120,
    });
    expect(result.accepted[0]!.tripId).toBeNull();
  });
});
