import { ConflictError, PreconditionFailedError, mergedIntervalSeconds } from '@aytracker/domain';

/**
 * Shift rules, as pure functions over plain data.
 *
 * Nothing here reads a clock or a database — the caller passes `now`. That is what makes
 * overnight shifts, DST transitions and month boundaries testable without a time machine.
 */

export type ShiftStatus = 'SCHEDULED' | 'ACTIVE' | 'ON_BREAK' | 'COMPLETED' | 'CANCELLED';
export type BreakType = 'PAID' | 'UNPAID' | 'MEAL' | 'TECHNICAL';

export interface ShiftState {
  readonly id: string;
  readonly status: ShiftStatus;
  readonly actualStart: Date | null;
  readonly actualEnd: Date | null;
}

export interface BreakInterval {
  readonly type: BreakType;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

const OPEN_STATUSES: ReadonlySet<ShiftStatus> = new Set(['ACTIVE', 'ON_BREAK']);

export function isOpen(status: ShiftStatus): boolean {
  return OPEN_STATUSES.has(status);
}

/** Transitions allowed from each status. Anything not listed is rejected. */
const ALLOWED_TRANSITIONS: Readonly<Record<ShiftStatus, readonly ShiftStatus[]>> = {
  SCHEDULED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ON_BREAK', 'COMPLETED', 'CANCELLED'],
  ON_BREAK: ['ACTIVE', 'COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: ShiftStatus, to: ShiftStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: ShiftStatus, to: ShiftStatus): void {
  if (!canTransition(from, to)) {
    throw new PreconditionFailedError(
      'shift.invalid_transition',
      `Cannot move a shift from ${from} to ${to}.`,
      { details: { from, to } },
    );
  }
}

export interface ShiftDuration {
  /** Wall-clock span from start to end. */
  readonly elapsedSeconds: number;
  /** Total break time, overlaps counted once. */
  readonly breakSeconds: number;
  /** Break time that is not paid, and therefore deducted. */
  readonly unpaidBreakSeconds: number;
  /** elapsed − unpaid breaks. Never negative. */
  readonly workedSeconds: number;
}

/**
 * Computes shift duration.
 *
 * Three decisions worth stating, because each is a bug someone will otherwise reintroduce:
 *
 *   * Overlapping breaks are merged, not summed. A duplicate break row (a double-tapped
 *     button, a correction) must not deduct the same minutes twice.
 *   * PAID and TECHNICAL breaks are counted but not deducted; UNPAID and MEAL are deducted.
 *   * An open break at shift end is closed at the shift end, not left running. Otherwise a
 *     worker who ends their shift while on break gets an infinite deduction.
 *
 * All arithmetic is on absolute instants, so a shift crossing a DST boundary is measured in
 * real elapsed time — 8 hours of work stays 8 hours even when the wall clock jumps.
 */
export function computeShiftDuration(input: {
  actualStart: Date;
  actualEnd: Date;
  breaks: readonly BreakInterval[];
}): ShiftDuration {
  const elapsedMs = input.actualEnd.getTime() - input.actualStart.getTime();
  if (elapsedMs < 0) {
    throw new PreconditionFailedError(
      'shift.end_before_start',
      'Shift end must not precede its start.',
    );
  }

  const closed = input.breaks.map((entry) => ({
    type: entry.type,
    start: clamp(entry.startedAt, input.actualStart, input.actualEnd),
    end: clamp(entry.endedAt ?? input.actualEnd, input.actualStart, input.actualEnd),
  }));

  const breakSeconds = mergedIntervalSeconds(closed);
  const unpaidBreakSeconds = mergedIntervalSeconds(
    closed.filter((entry) => isDeductible(entry.type)),
  );

  const elapsedSeconds = Math.round(elapsedMs / 1000);
  return {
    elapsedSeconds,
    breakSeconds,
    unpaidBreakSeconds,
    workedSeconds: Math.max(0, elapsedSeconds - unpaidBreakSeconds),
  };
}

export function isDeductible(type: BreakType): boolean {
  return type === 'UNPAID' || type === 'MEAL';
}

function clamp(instant: Date, min: Date, max: Date): Date {
  if (instant.getTime() < min.getTime()) return min;
  if (instant.getTime() > max.getTime()) return max;
  return instant;
}

/**
 * Guards against a shift that was never ended.
 *
 * A worker who forgets to clock out would otherwise accumulate a 60-hour shift, which corrupts
 * every downstream productivity number. The shift is auto-closed at the cap and flagged, rather
 * than silently truncated — a supervisor must see that the end time is synthetic.
 */
export function shouldAutoClose(input: {
  actualStart: Date;
  now: Date;
  maxShiftDurationMinutes: number;
}): boolean {
  const elapsedMinutes = (input.now.getTime() - input.actualStart.getTime()) / 60_000;
  return elapsedMinutes > input.maxShiftDurationMinutes;
}

export function autoCloseAt(actualStart: Date, maxShiftDurationMinutes: number): Date {
  return new Date(actualStart.getTime() + maxShiftDurationMinutes * 60_000);
}

/** A break may only start on an ACTIVE shift, and only when no break is already open. */
export function assertCanStartBreak(shift: ShiftState, openBreakExists: boolean): void {
  if (shift.status !== 'ACTIVE') {
    throw new PreconditionFailedError(
      'shift.not_active',
      'A break can only start on an active shift.',
    );
  }
  if (openBreakExists) {
    throw new ConflictError('shift.break_already_active', 'This shift already has an open break.');
  }
}

export function assertCanEndBreak(shift: ShiftState): void {
  if (shift.status !== 'ON_BREAK') {
    throw new PreconditionFailedError('shift.not_on_break', 'This shift is not on a break.');
  }
}

/**
 * Validates a timestamp supplied by an offline client replaying a queued action.
 *
 * The device clock is not trusted, but it is the only record of when something actually
 * happened offline. The compromise: accept it inside a bounded window around the server's view,
 * and clamp anything outside. A device whose clock is a day out cannot backdate a shift.
 */
export function reconcileClientTimestamp(input: {
  clientTimestamp: Date;
  serverNow: Date;
  /** How far in the past a queued action may legitimately be. */
  maxBacklogSeconds: number;
  /** Tolerance for a device clock running fast. */
  maxSkewAheadSeconds: number;
}): { timestamp: Date; wasAdjusted: boolean } {
  const earliest = new Date(input.serverNow.getTime() - input.maxBacklogSeconds * 1000);
  const latest = new Date(input.serverNow.getTime() + input.maxSkewAheadSeconds * 1000);

  if (input.clientTimestamp.getTime() < earliest.getTime()) {
    return { timestamp: earliest, wasAdjusted: true };
  }
  if (input.clientTimestamp.getTime() > latest.getTime()) {
    // A future timestamp is never accepted; the action happened by the time we saw it.
    return { timestamp: input.serverNow, wasAdjusted: true };
  }
  return { timestamp: input.clientTimestamp, wasAdjusted: false };
}
