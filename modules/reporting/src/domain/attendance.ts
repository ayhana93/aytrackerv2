import type { TimezoneId } from '@aytracker/types';
import { localDateString } from '@aytracker/domain';

/**
 * Attendance aggregation.
 *
 * Server-side by design: a browser summing 500 workers × 30 days of shifts would be slow, and
 * two clients on different versions would disagree. The rules for what counts as "a day" also
 * belong here, because they are not obvious.
 */

export interface ShiftFact {
  readonly workerId: string;
  readonly siteId: string;
  readonly actualStart: Date;
  readonly actualEnd: Date | null;
  readonly workedSeconds: number | null;
  readonly breakSeconds: number | null;
  readonly autoClosed: boolean;
}

export interface AttendanceRow {
  readonly workerId: string;
  /** Local calendar date the shift is attributed to. */
  readonly date: string;
  readonly shiftCount: number;
  readonly workedSeconds: number;
  readonly breakSeconds: number;
  readonly autoClosedCount: number;
}

/**
 * Groups shifts into local calendar days.
 *
 * A shift is attributed to the day it *started* in the site's timezone. That is the convention
 * a night-shift worker expects: a shift running 22:00–06:00 belongs to the evening it began,
 * not split across two dates — and it means a DST night with 23 or 25 hours still produces
 * exactly one row.
 */
export function aggregateAttendance(
  shifts: readonly ShiftFact[],
  timezone: TimezoneId,
): readonly AttendanceRow[] {
  const rows = new Map<string, AttendanceRow>();

  for (const shift of shifts) {
    const date = localDateString(shift.actualStart, timezone);
    const key = `${shift.workerId}|${date}`;
    const existing = rows.get(key) ?? {
      workerId: shift.workerId,
      date,
      shiftCount: 0,
      workedSeconds: 0,
      breakSeconds: 0,
      autoClosedCount: 0,
    };

    rows.set(key, {
      ...existing,
      shiftCount: existing.shiftCount + 1,
      workedSeconds: existing.workedSeconds + (shift.workedSeconds ?? 0),
      breakSeconds: existing.breakSeconds + (shift.breakSeconds ?? 0),
      autoClosedCount: existing.autoClosedCount + (shift.autoClosed ? 1 : 0),
    });
  }

  return [...rows.values()].sort((a, b) =>
    a.date === b.date ? a.workerId.localeCompare(b.workerId) : a.date.localeCompare(b.date),
  );
}

export interface AttendanceTotals {
  readonly workerCount: number;
  readonly dayCount: number;
  readonly totalWorkedSeconds: number;
  readonly totalBreakSeconds: number;
  readonly averageWorkedSecondsPerDay: number | null;
  /** Shifts that had to be closed by the system — a data-quality signal, not a verdict. */
  readonly autoClosedCount: number;
}

export function totalAttendance(rows: readonly AttendanceRow[]): AttendanceTotals {
  if (rows.length === 0) {
    return {
      workerCount: 0,
      dayCount: 0,
      totalWorkedSeconds: 0,
      totalBreakSeconds: 0,
      averageWorkedSecondsPerDay: null,
      autoClosedCount: 0,
    };
  }

  const totalWorkedSeconds = rows.reduce((sum, row) => sum + row.workedSeconds, 0);
  return {
    workerCount: new Set(rows.map((row) => row.workerId)).size,
    dayCount: new Set(rows.map((row) => row.date)).size,
    totalWorkedSeconds,
    totalBreakSeconds: rows.reduce((sum, row) => sum + row.breakSeconds, 0),
    averageWorkedSecondsPerDay: Math.round(totalWorkedSeconds / rows.length),
    autoClosedCount: rows.reduce((sum, row) => sum + row.autoClosedCount, 0),
  };
}
