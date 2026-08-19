import type { TimezoneId } from '@aytracker/types';
import { ValidationError } from './errors.js';

/**
 * Time rules for AYtracker (docs/architecture.md § time):
 *   * Everything is stored and computed in UTC.
 *   * A wall-clock time only means something together with an IANA timezone, which comes from
 *     the site (falling back to the organization).
 *   * DST is handled by asking Intl for the offset at a specific instant, never by adding a
 *     fixed number of hours.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at a given instant. Every duration test uses one of these. */
export function fixedClock(instant: Date): Clock {
  return { now: () => new Date(instant.getTime()) };
}

export function assertValidTimezone(timezone: string): asserts timezone is TimezoneId {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new ValidationError('time.invalid_timezone', `Unknown IANA timezone: ${timezone}`);
  }
}

/**
 * Offset of `timezone` from UTC, in minutes, at the given instant.
 * Positive east of Greenwich. Correct across DST because it asks for that instant specifically.
 */
export function timezoneOffsetMinutes(instant: Date, timezone: TimezoneId): number {
  assertValidTimezone(timezone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  // Intl renders hour 24 for midnight in some locales; normalize to 0.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The local calendar date (YYYY-MM-DD) an instant falls on in a timezone. */
export function localDateString(instant: Date, timezone: TimezoneId): string {
  assertValidTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return parts;
}

/** Minutes from local midnight for an instant in a timezone. */
export function localMinuteOfDay(instant: Date, timezone: TimezoneId): number {
  assertValidTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * Resolves a local wall-clock time in a timezone to the UTC instant it denotes.
 *
 * Two-pass because the offset depends on the instant we are trying to find. Ambiguous times
 * (the repeated hour when DST ends) resolve to the earlier instant; nonexistent times (the
 * skipped hour when DST starts) resolve forward past the gap — the same choices the IANA
 * "compatible" disambiguation rule makes.
 */
export function zonedTimeToUtc(
  localDate: string,
  minuteOfDay: number,
  timezone: TimezoneId,
): Date {
  assertValidTimezone(timezone);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) {
    throw new ValidationError('time.invalid_date', `Expected YYYY-MM-DD, got: ${localDate}`);
  }
  const [, year, month, day] = match;
  const naiveUtc = Date.UTC(Number(year), Number(month) - 1, Number(day)) + minuteOfDay * 60_000;

  const firstGuess = new Date(naiveUtc - timezoneOffsetMinutes(new Date(naiveUtc), timezone) * 60_000);
  const secondOffset = timezoneOffsetMinutes(firstGuess, timezone);
  return new Date(naiveUtc - secondOffset * 60_000);
}

export function differenceInSeconds(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 1000);
}

export function addSeconds(instant: Date, seconds: number): Date {
  return new Date(instant.getTime() + seconds * 1000);
}

export function addMinutes(instant: Date, minutes: number): Date {
  return addSeconds(instant, minutes * 60);
}

export function addDays(instant: Date, days: number): Date {
  return addSeconds(instant, days * 86_400);
}

/**
 * Total seconds covered by a set of intervals, counting overlapping regions once.
 *
 * Used for break time: two overlapping break rows (a correction artefact, or a client that
 * fired twice) must not inflate the deduction.
 */
export function mergedIntervalSeconds(
  intervals: readonly { start: Date; end: Date }[],
): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals]
    .filter((i) => i.end.getTime() > i.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (sorted.length === 0) return 0;

  let total = 0;
  let currentStart = sorted[0]!.start.getTime();
  let currentEnd = sorted[0]!.end.getTime();

  for (let i = 1; i < sorted.length; i += 1) {
    const interval = sorted[i]!;
    const start = interval.start.getTime();
    const end = interval.end.getTime();
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  total += currentEnd - currentStart;
  return Math.round(total / 1000);
}

/** Clamps an instant into [min, max]. Used to keep device timestamps inside a trip window. */
export function clampInstant(instant: Date, min: Date, max: Date): Date {
  if (instant.getTime() < min.getTime()) return new Date(min.getTime());
  if (instant.getTime() > max.getTime()) return new Date(max.getTime());
  return instant;
}
