import { describe, expect, it } from 'vitest';
import {
  computeShiftDuration,
  canTransition,
  assertTransition,
  reconcileClientTimestamp,
  shouldAutoClose,
  autoCloseAt,
} from '@aytracker/module-shifts';

const at = (iso: string) => new Date(iso);

describe('computeShiftDuration', () => {
  it('subtracts unpaid breaks from elapsed time', () => {
    const result = computeShiftDuration({
      actualStart: at('2026-03-10T06:00:00Z'),
      actualEnd: at('2026-03-10T14:00:00Z'),
      breaks: [
        { type: 'MEAL', startedAt: at('2026-03-10T10:00:00Z'), endedAt: at('2026-03-10T10:30:00Z') },
      ],
    });

    expect(result.elapsedSeconds).toBe(8 * 3600);
    expect(result.breakSeconds).toBe(1800);
    expect(result.unpaidBreakSeconds).toBe(1800);
    expect(result.workedSeconds).toBe(8 * 3600 - 1800);
  });

  it('counts paid breaks without deducting them', () => {
    const result = computeShiftDuration({
      actualStart: at('2026-03-10T06:00:00Z'),
      actualEnd: at('2026-03-10T14:00:00Z'),
      breaks: [
        { type: 'PAID', startedAt: at('2026-03-10T09:00:00Z'), endedAt: at('2026-03-10T09:15:00Z') },
        { type: 'TECHNICAL', startedAt: at('2026-03-10T11:00:00Z'), endedAt: at('2026-03-10T11:10:00Z') },
      ],
    });

    expect(result.breakSeconds).toBe(1500);
    expect(result.unpaidBreakSeconds).toBe(0);
    expect(result.workedSeconds).toBe(8 * 3600);
  });

  /**
   * The duplicate-break case. A double-tapped button or a correction can produce two rows
   * covering the same minutes; summing them would deduct the time twice.
   */
  it('counts overlapping breaks once', () => {
    const result = computeShiftDuration({
      actualStart: at('2026-03-10T06:00:00Z'),
      actualEnd: at('2026-03-10T14:00:00Z'),
      breaks: [
        { type: 'UNPAID', startedAt: at('2026-03-10T10:00:00Z'), endedAt: at('2026-03-10T10:30:00Z') },
        { type: 'UNPAID', startedAt: at('2026-03-10T10:15:00Z'), endedAt: at('2026-03-10T10:45:00Z') },
      ],
    });

    // 10:00–10:45 is 45 minutes, not 60.
    expect(result.unpaidBreakSeconds).toBe(45 * 60);
    expect(result.workedSeconds).toBe(8 * 3600 - 45 * 60);
  });

  it('closes an open break at the shift end rather than letting it run', () => {
    const result = computeShiftDuration({
      actualStart: at('2026-03-10T06:00:00Z'),
      actualEnd: at('2026-03-10T14:00:00Z'),
      breaks: [{ type: 'UNPAID', startedAt: at('2026-03-10T13:30:00Z'), endedAt: null }],
    });

    expect(result.unpaidBreakSeconds).toBe(30 * 60);
    expect(result.workedSeconds).toBe(8 * 3600 - 30 * 60);
  });

  it('clamps a break that extends past the shift boundaries', () => {
    const result = computeShiftDuration({
      actualStart: at('2026-03-10T06:00:00Z'),
      actualEnd: at('2026-03-10T14:00:00Z'),
      breaks: [
        { type: 'UNPAID', startedAt: at('2026-03-10T05:00:00Z'), endedAt: at('2026-03-10T15:00:00Z') },
      ],
    });

    expect(result.unpaidBreakSeconds).toBe(8 * 3600);
    expect(result.workedSeconds).toBe(0);
  });

  /**
   * An overnight shift crossing the European DST spring-forward. The wall clock jumps from
   * 03:00 to 04:00 local, but the worker was there for 8 real hours — and gets paid for 8.
   */
  it('measures real elapsed time across a DST spring-forward', () => {
    // 2026-03-29 is the EU DST transition; 01:00 UTC becomes 03:00 local in Europe/Sofia.
    const result = computeShiftDuration({
      actualStart: at('2026-03-28T20:00:00Z'),
      actualEnd: at('2026-03-29T04:00:00Z'),
      breaks: [],
    });

    expect(result.elapsedSeconds).toBe(8 * 3600);
    expect(result.workedSeconds).toBe(8 * 3600);
  });

  it('measures real elapsed time across a DST fall-back', () => {
    // 2026-10-25: the local hour repeats, so a naive wall-clock subtraction would report 7 h.
    const result = computeShiftDuration({
      actualStart: at('2026-10-24T20:00:00Z'),
      actualEnd: at('2026-10-25T04:00:00Z'),
      breaks: [],
    });

    expect(result.elapsedSeconds).toBe(8 * 3600);
  });

  it('rejects an end before the start', () => {
    expect(() =>
      computeShiftDuration({
        actualStart: at('2026-03-10T14:00:00Z'),
        actualEnd: at('2026-03-10T06:00:00Z'),
        breaks: [],
      }),
    ).toThrowError(/end must not precede/i);
  });
});

describe('shift transitions', () => {
  it('allows the normal lifecycle', () => {
    expect(canTransition('SCHEDULED', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'ON_BREAK')).toBe(true);
    expect(canTransition('ON_BREAK', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'COMPLETED')).toBe(true);
  });

  it('refuses to reopen a finished shift', () => {
    expect(canTransition('COMPLETED', 'ACTIVE')).toBe(false);
    expect(canTransition('CANCELLED', 'ACTIVE')).toBe(false);
    expect(() => assertTransition('COMPLETED', 'ACTIVE')).toThrowError(/cannot move a shift/i);
  });

  it('refuses to go straight from scheduled to a break', () => {
    expect(canTransition('SCHEDULED', 'ON_BREAK')).toBe(false);
  });
});

describe('reconcileClientTimestamp', () => {
  const serverNow = at('2026-03-10T12:00:00Z');
  const bounds = { maxBacklogSeconds: 3600, maxSkewAheadSeconds: 120 };

  it('accepts a plausible queued timestamp', () => {
    const result = reconcileClientTimestamp({
      clientTimestamp: at('2026-03-10T11:30:00Z'),
      serverNow,
      ...bounds,
    });
    expect(result.wasAdjusted).toBe(false);
    expect(result.timestamp.toISOString()).toBe('2026-03-10T11:30:00.000Z');
  });

  it('clamps a timestamp older than the backlog window', () => {
    const result = reconcileClientTimestamp({
      clientTimestamp: at('2026-03-09T12:00:00Z'),
      serverNow,
      ...bounds,
    });
    expect(result.wasAdjusted).toBe(true);
    expect(result.timestamp.toISOString()).toBe('2026-03-10T11:00:00.000Z');
  });

  it('never accepts a timestamp from the future', () => {
    const result = reconcileClientTimestamp({
      clientTimestamp: at('2026-03-10T18:00:00Z'),
      serverNow,
      ...bounds,
    });
    expect(result.wasAdjusted).toBe(true);
    expect(result.timestamp).toEqual(serverNow);
  });

  it('tolerates a small forward clock skew', () => {
    const result = reconcileClientTimestamp({
      clientTimestamp: at('2026-03-10T12:01:00Z'),
      serverNow,
      ...bounds,
    });
    expect(result.wasAdjusted).toBe(false);
  });
});

describe('auto-close', () => {
  it('closes at the cap, not at the time the job happened to run', () => {
    const start = at('2026-03-10T06:00:00Z');
    expect(
      shouldAutoClose({ actualStart: start, now: at('2026-03-11T03:00:00Z'), maxShiftDurationMinutes: 960 }),
    ).toBe(true);
    expect(autoCloseAt(start, 960).toISOString()).toBe('2026-03-10T22:00:00.000Z');
  });

  it('leaves a shift inside its cap alone', () => {
    expect(
      shouldAutoClose({
        actualStart: at('2026-03-10T06:00:00Z'),
        now: at('2026-03-10T14:00:00Z'),
        maxShiftDurationMinutes: 960,
      }),
    ).toBe(false);
  });
});
