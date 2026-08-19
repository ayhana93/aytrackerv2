import { ConflictError, PreconditionFailedError, ValidationError } from '@aytracker/domain';
import type { PositionId, PositionSessionId, ShiftId, WorkerId } from '@aytracker/types';

/**
 * Position sessions — the source of truth for where a worker stood and for how long.
 *
 * The spec's rule, restated because everything here follows from it: never a mutable JSON
 * summary. Time at a position is derived by summing closed sessions, so a correction is a
 * visible, audited edit of one row rather than an invisible recomputation of a blob.
 */

export interface PositionSessionState {
  readonly id: PositionSessionId;
  readonly shiftId: ShiftId;
  readonly workerId: WorkerId;
  readonly positionId: PositionId;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export type PositionChangeSource = 'MANUAL' | 'QR' | 'SUPERVISOR' | 'SYSTEM';

export interface PositionChangePlan {
  /** The session to close, or null when the worker had none (first position of the shift). */
  readonly closing: {
    readonly sessionId: PositionSessionId;
    readonly endedAt: Date;
    readonly durationSeconds: number;
  } | null;
  readonly opening: {
    readonly positionId: PositionId;
    readonly startedAt: Date;
    readonly source: PositionChangeSource;
  };
}

/**
 * Plans a position change as one atomic pair: close the current session, open the new one.
 *
 * Returns a plan rather than performing it, so the application service can execute both writes
 * inside a single transaction. The database's partial unique index
 * (`position_sessions_one_open_per_shift`) is the backstop if two requests race here.
 */
export function planPositionChange(input: {
  currentSession: PositionSessionState | null;
  targetPositionId: PositionId;
  at: Date;
  source: PositionChangeSource;
}): PositionChangePlan {
  const { currentSession, targetPositionId, at, source } = input;

  if (currentSession) {
    if (currentSession.endedAt !== null) {
      throw new ConflictError(
        'position.session_already_closed',
        'The current position session is already closed.',
      );
    }
    if (currentSession.positionId === targetPositionId) {
      // Not an error the worker needs to see as a failure, but it must not create a
      // zero-length session that pollutes the history.
      throw new ConflictError(
        'position.already_at_position',
        'The worker is already at that position.',
      );
    }
    if (at.getTime() < currentSession.startedAt.getTime()) {
      throw new ValidationError(
        'position.change_before_session_start',
        'A position change cannot predate the session it closes.',
      );
    }
  }

  return {
    closing: currentSession
      ? {
          sessionId: currentSession.id,
          endedAt: at,
          durationSeconds: Math.round(
            (at.getTime() - currentSession.startedAt.getTime()) / 1000,
          ),
        }
      : null,
    opening: { positionId: targetPositionId, startedAt: at, source },
  };
}

/** Closes the final session when the shift ends. */
export function planSessionClose(
  session: PositionSessionState,
  endedAt: Date,
): { sessionId: PositionSessionId; endedAt: Date; durationSeconds: number } {
  if (endedAt.getTime() < session.startedAt.getTime()) {
    throw new ValidationError(
      'position.end_before_start',
      'Session end must not precede its start.',
    );
  }
  return {
    sessionId: session.id,
    endedAt,
    durationSeconds: Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000),
  };
}

export interface PositionTotal {
  readonly positionId: PositionId;
  readonly seconds: number;
  readonly sessionCount: number;
}

/**
 * Time per position across a set of sessions.
 *
 * Open sessions are measured up to `now` so a live shift shows a running total; they are marked
 * so a report can distinguish "3 h so far" from "3 h final".
 */
export function summarizeByPosition(
  sessions: readonly PositionSessionState[],
  now: Date,
): readonly PositionTotal[] {
  const totals = new Map<PositionId, { seconds: number; sessionCount: number }>();

  for (const session of sessions) {
    const end = session.endedAt ?? now;
    const seconds = Math.max(0, Math.round((end.getTime() - session.startedAt.getTime()) / 1000));
    const existing = totals.get(session.positionId) ?? { seconds: 0, sessionCount: 0 };
    totals.set(session.positionId, {
      seconds: existing.seconds + seconds,
      sessionCount: existing.sessionCount + 1,
    });
  }

  return [...totals.entries()]
    .map(([positionId, value]) => ({ positionId, ...value }))
    .sort((a, b) => b.seconds - a.seconds);
}

export interface SwitchingPattern {
  readonly changeCount: number;
  readonly averageSecondsPerPosition: number;
  readonly shortestStaySeconds: number;
  /** Sessions shorter than the threshold — the signal, not a verdict. */
  readonly briefStayCount: number;
}

/**
 * Descriptive statistics about position switching.
 *
 * Deliberately named and shaped as *observation*, not accusation. A high switch count can mean
 * a worker is gaming a productivity metric, or that a line is short-staffed and someone is
 * covering three machines. The system reports the number; a human decides what it means.
 * Nothing in this codebase produces a "suspicious worker" flag.
 */
export function analyzeSwitching(
  sessions: readonly PositionSessionState[],
  now: Date,
  briefStayThresholdSeconds = 300,
): SwitchingPattern {
  if (sessions.length === 0) {
    return {
      changeCount: 0,
      averageSecondsPerPosition: 0,
      shortestStaySeconds: 0,
      briefStayCount: 0,
    };
  }

  const durations = sessions.map((session) => {
    const end = session.endedAt ?? now;
    return Math.max(0, Math.round((end.getTime() - session.startedAt.getTime()) / 1000));
  });

  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    changeCount: Math.max(0, sessions.length - 1),
    averageSecondsPerPosition: Math.round(total / sessions.length),
    shortestStaySeconds: Math.min(...durations),
    briefStayCount: durations.filter((value) => value < briefStayThresholdSeconds).length,
  };
}

/**
 * Validates a supervisor's correction of a historical session.
 *
 * Workers can never reach this path — it requires `shifts.correct`. The checks here stop a
 * supervisor from creating impossible history, whether by mistake or otherwise.
 */
export function validateCorrection(input: {
  session: PositionSessionState;
  newStartedAt: Date;
  newEndedAt: Date | null;
  /** Sessions on the same shift, excluding the one being corrected. */
  siblingSessions: readonly PositionSessionState[];
  shiftStart: Date;
  shiftEnd: Date | null;
  reason: string;
}): void {
  if (input.reason.trim().length < 3) {
    throw new ValidationError('correction.reason_required', 'A correction requires a reason.');
  }
  if (input.newEndedAt && input.newEndedAt.getTime() < input.newStartedAt.getTime()) {
    throw new ValidationError('correction.end_before_start', 'End must not precede start.');
  }
  if (input.newStartedAt.getTime() < input.shiftStart.getTime()) {
    throw new PreconditionFailedError(
      'correction.before_shift_start',
      'A session cannot begin before its shift.',
    );
  }
  if (
    input.shiftEnd &&
    input.newEndedAt &&
    input.newEndedAt.getTime() > input.shiftEnd.getTime()
  ) {
    throw new PreconditionFailedError(
      'correction.after_shift_end',
      'A session cannot end after its shift.',
    );
  }

  const newEnd = input.newEndedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const overlapping = input.siblingSessions.find((sibling) => {
    const siblingEnd = sibling.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return sibling.startedAt.getTime() < newEnd && siblingEnd > input.newStartedAt.getTime();
  });
  if (overlapping) {
    throw new ConflictError(
      'correction.overlaps_session',
      'The corrected session would overlap another session on this shift.',
      { details: { conflictingSessionId: overlapping.id } },
    );
  }
}
