import { describe, expect, it } from 'vitest';
import {
  analyzeSwitching,
  planPositionChange,
  planSessionClose,
  summarizeByPosition,
  validateCorrection,
  type PositionSessionState,
} from '@aytracker/module-shifts';
import type { PositionId, PositionSessionId, ShiftId, WorkerId } from '@aytracker/types';

const SHIFT = 'shift-1' as ShiftId;
const WORKER = 'worker-1' as WorkerId;
const at = (iso: string) => new Date(iso);

function session(overrides: Partial<PositionSessionState> = {}): PositionSessionState {
  return {
    id: 'session-1' as PositionSessionId,
    shiftId: SHIFT,
    workerId: WORKER,
    positionId: 'machine-1' as PositionId,
    startedAt: at('2026-03-10T10:00:00Z'),
    endedAt: null,
    ...overrides,
  };
}

describe('planPositionChange', () => {
  it('closes the current session and opens the new one', () => {
    const plan = planPositionChange({
      currentSession: session(),
      targetPositionId: 'machine-2' as PositionId,
      at: at('2026-03-10T10:32:00Z'),
      source: 'MANUAL',
    });

    expect(plan.closing).toEqual({
      sessionId: 'session-1',
      endedAt: at('2026-03-10T10:32:00Z'),
      durationSeconds: 32 * 60,
    });
    expect(plan.opening.positionId).toBe('machine-2');
    expect(plan.opening.startedAt).toEqual(at('2026-03-10T10:32:00Z'));
  });

  it('opens the first session of a shift with nothing to close', () => {
    const plan = planPositionChange({
      currentSession: null,
      targetPositionId: 'machine-1' as PositionId,
      at: at('2026-03-10T06:00:00Z'),
      source: 'QR',
    });

    expect(plan.closing).toBeNull();
    expect(plan.opening.source).toBe('QR');
  });

  /** A double-tap must not create a zero-length session that pollutes the history. */
  it('refuses to move to the position the worker is already on', () => {
    expect(() =>
      planPositionChange({
        currentSession: session({ positionId: 'machine-1' as PositionId }),
        targetPositionId: 'machine-1' as PositionId,
        at: at('2026-03-10T10:32:00Z'),
        source: 'MANUAL',
      }),
    ).toThrowError(/already at that position/i);
  });

  it('refuses to close an already-closed session', () => {
    expect(() =>
      planPositionChange({
        currentSession: session({ endedAt: at('2026-03-10T10:20:00Z') }),
        targetPositionId: 'machine-2' as PositionId,
        at: at('2026-03-10T10:32:00Z'),
        source: 'MANUAL',
      }),
    ).toThrowError(/already closed/i);
  });

  it('refuses a change that predates the session it would close', () => {
    expect(() =>
      planPositionChange({
        currentSession: session({ startedAt: at('2026-03-10T10:00:00Z') }),
        targetPositionId: 'machine-2' as PositionId,
        at: at('2026-03-10T09:00:00Z'),
        source: 'MANUAL',
      }),
    ).toThrowError(/cannot predate/i);
  });
});

describe('planSessionClose', () => {
  it('computes the duration', () => {
    const plan = planSessionClose(session(), at('2026-03-10T13:14:00Z'));
    expect(plan.durationSeconds).toBe(3 * 3600 + 14 * 60);
  });

  it('refuses an end before the start', () => {
    expect(() => planSessionClose(session(), at('2026-03-10T09:00:00Z'))).toThrowError(
      /must not precede/i,
    );
  });
});

describe('summarizeByPosition', () => {
  it('totals time per position across repeated visits', () => {
    const sessions: PositionSessionState[] = [
      session({ id: 's1' as PositionSessionId, positionId: 'm1' as PositionId, startedAt: at('2026-03-10T10:00:00Z'), endedAt: at('2026-03-10T10:30:00Z') }),
      session({ id: 's2' as PositionSessionId, positionId: 'm2' as PositionId, startedAt: at('2026-03-10T10:30:00Z'), endedAt: at('2026-03-10T12:00:00Z') }),
      session({ id: 's3' as PositionSessionId, positionId: 'm1' as PositionId, startedAt: at('2026-03-10T12:00:00Z'), endedAt: at('2026-03-10T12:15:00Z') }),
    ];

    const totals = summarizeByPosition(sessions, at('2026-03-10T14:00:00Z'));
    expect(totals[0]).toEqual({ positionId: 'm2', seconds: 90 * 60, sessionCount: 1 });
    expect(totals[1]).toEqual({ positionId: 'm1', seconds: 45 * 60, sessionCount: 2 });
  });

  it('measures an open session up to now, so a live shift shows a running total', () => {
    const totals = summarizeByPosition(
      [session({ startedAt: at('2026-03-10T10:00:00Z'), endedAt: null })],
      at('2026-03-10T11:00:00Z'),
    );
    expect(totals[0]!.seconds).toBe(3600);
  });
});

describe('analyzeSwitching', () => {
  it('describes switching without judging it', () => {
    const sessions: PositionSessionState[] = [
      session({ id: 'a' as PositionSessionId, startedAt: at('2026-03-10T10:00:00Z'), endedAt: at('2026-03-10T10:02:00Z') }),
      session({ id: 'b' as PositionSessionId, startedAt: at('2026-03-10T10:02:00Z'), endedAt: at('2026-03-10T10:04:00Z') }),
      session({ id: 'c' as PositionSessionId, startedAt: at('2026-03-10T10:04:00Z'), endedAt: at('2026-03-10T12:00:00Z') }),
    ];

    const pattern = analyzeSwitching(sessions, at('2026-03-10T12:00:00Z'));
    expect(pattern.changeCount).toBe(2);
    expect(pattern.briefStayCount).toBe(2);
    expect(pattern.shortestStaySeconds).toBe(120);
    // The result is descriptive statistics. There is deliberately no `isSuspicious` field.
    expect(Object.keys(pattern).sort()).toEqual([
      'averageSecondsPerPosition',
      'briefStayCount',
      'changeCount',
      'shortestStaySeconds',
    ]);
  });

  it('handles an empty shift', () => {
    expect(analyzeSwitching([], at('2026-03-10T12:00:00Z')).changeCount).toBe(0);
  });
});

describe('validateCorrection', () => {
  const shiftStart = at('2026-03-10T06:00:00Z');
  const shiftEnd = at('2026-03-10T14:00:00Z');

  const base = {
    session: session({ startedAt: at('2026-03-10T10:00:00Z'), endedAt: at('2026-03-10T11:00:00Z') }),
    siblingSessions: [] as PositionSessionState[],
    shiftStart,
    shiftEnd,
    reason: 'Worker was on machine 2, recorded on machine 1 by mistake.',
  };

  it('accepts a plausible correction', () => {
    expect(() =>
      validateCorrection({
        ...base,
        newStartedAt: at('2026-03-10T10:15:00Z'),
        newEndedAt: at('2026-03-10T11:15:00Z'),
      }),
    ).not.toThrow();
  });

  it('requires a reason', () => {
    expect(() =>
      validateCorrection({
        ...base,
        reason: '  ',
        newStartedAt: at('2026-03-10T10:15:00Z'),
        newEndedAt: at('2026-03-10T11:15:00Z'),
      }),
    ).toThrowError(/requires a reason/i);
  });

  it('refuses a session that would start before its shift', () => {
    expect(() =>
      validateCorrection({
        ...base,
        newStartedAt: at('2026-03-10T05:00:00Z'),
        newEndedAt: at('2026-03-10T07:00:00Z'),
      }),
    ).toThrowError(/before its shift/i);
  });

  it('refuses a session that would end after its shift', () => {
    expect(() =>
      validateCorrection({
        ...base,
        newStartedAt: at('2026-03-10T13:00:00Z'),
        newEndedAt: at('2026-03-10T16:00:00Z'),
      }),
    ).toThrowError(/after its shift/i);
  });

  it('refuses an inverted interval', () => {
    expect(() =>
      validateCorrection({
        ...base,
        newStartedAt: at('2026-03-10T11:00:00Z'),
        newEndedAt: at('2026-03-10T10:00:00Z'),
      }),
    ).toThrowError(/must not precede/i);
  });

  it('refuses a correction that would overlap another session on the shift', () => {
    expect(() =>
      validateCorrection({
        ...base,
        siblingSessions: [
          session({
            id: 'other' as PositionSessionId,
            startedAt: at('2026-03-10T11:00:00Z'),
            endedAt: at('2026-03-10T12:00:00Z'),
          }),
        ],
        newStartedAt: at('2026-03-10T10:00:00Z'),
        newEndedAt: at('2026-03-10T11:30:00Z'),
      }),
    ).toThrowError(/overlap/i);
  });

  it('allows a correction that ends exactly where the next session begins', () => {
    expect(() =>
      validateCorrection({
        ...base,
        siblingSessions: [
          session({
            id: 'other' as PositionSessionId,
            startedAt: at('2026-03-10T11:00:00Z'),
            endedAt: at('2026-03-10T12:00:00Z'),
          }),
        ],
        newStartedAt: at('2026-03-10T10:00:00Z'),
        newEndedAt: at('2026-03-10T11:00:00Z'),
      }),
    ).not.toThrow();
  });
});
