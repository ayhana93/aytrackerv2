import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  type Clock,
  type EventBus,
} from '@aytracker/domain';
import type {
  OrganizationId,
  PositionId,
  PositionSessionId,
  ShiftId,
  ShiftTypeId,
  SiteId,
  WorkerId,
} from '@aytracker/types';
import { ELIGIBILITY_ERROR_CODES, type WorkforceQueryService } from '@aytracker/module-workforce';
import {
  assertCanEndBreak,
  assertCanStartBreak,
  assertTransition,
  autoCloseAt,
  computeShiftDuration,
  shouldAutoClose,
  type BreakType,
} from '../domain/shift.js';
import {
  planPositionChange,
  planSessionClose,
  validateCorrection,
  type PositionChangeSource,
} from '../domain/position-session.js';
import type { ShiftUnitOfWork, TransactionRunner } from '../domain/ports.js';
import { DrivingCommandService } from './driving-commands.js';

/**
 * Shift commands.
 *
 * Every command in this file:
 *   * takes the worker identity from the caller's *session*, never from the request body;
 *   * runs its writes inside one transaction, so a position change can never leave a worker
 *     with two open sessions or none;
 *   * emits a domain event after the transaction, for reporting and audit to consume.
 *
 * Idempotency is applied one layer up, in the HTTP handler, so the stored response covers the
 * whole request rather than just the database writes.
 */

export interface ShiftPolicy {
  readonly maxShiftDurationMinutes: number;
  readonly allowWorkerSelfShiftStart: boolean;
}

export interface StartShiftInput {
  readonly organizationId: OrganizationId;
  readonly workerId: WorkerId;
  readonly siteId: SiteId;
  readonly shiftTypeId: ShiftTypeId | null;
  /** Position to open the first session on. Optional: a worker may clock in before being placed. */
  readonly initialPositionId: PositionId | null;
  readonly at: Date;
  /** True when a supervisor starts the shift on the worker's behalf. */
  readonly startedBySupervisor: boolean;
}

export interface ChangePositionInput {
  readonly organizationId: OrganizationId;
  readonly workerId: WorkerId;
  readonly targetPositionId: PositionId;
  readonly at: Date;
  readonly source: PositionChangeSource;
}

export class ShiftCommandService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly workforce: WorkforceQueryService,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  /**
   * Starts a shift.
   *
   * The "one open shift per worker" rule is checked here for a good error message and enforced
   * by the `shifts_one_open_per_worker` partial unique index for correctness — two devices
   * tapping Start at the same moment both pass this check, and exactly one wins at the index.
   */
  async startShift(input: StartShiftInput, policy: ShiftPolicy): Promise<{ shiftId: ShiftId }> {
    if (!policy.allowWorkerSelfShiftStart && !input.startedBySupervisor) {
      throw new ForbiddenError(
        'shift.self_start_disabled',
        'This organization requires a supervisor to start shifts.',
      );
    }

    // Eligibility is checked before the transaction so a rejected change does not hold locks.
    if (input.initialPositionId) {
      await this.assertEligible(
        input.organizationId,
        input.workerId,
        input.initialPositionId,
        input.at,
      );
    }

    const result = await this.transactions.run(input.organizationId, async (uow) => {
      const existing = await uow.shifts.findOpenForWorker(input.organizationId, input.workerId);
      if (existing) {
        throw new ConflictError('shift.already_active', 'Worker already has a shift in progress.');
      }

      const shift = await uow.shifts.create({
        organizationId: input.organizationId,
        siteId: input.siteId,
        workerId: input.workerId,
        shiftTypeId: input.shiftTypeId,
        status: 'ACTIVE',
        actualStart: input.at,
        scheduledStart: null,
        scheduledEnd: null,
      });

      if (input.initialPositionId) {
        await uow.positionSessions.open({
          organizationId: input.organizationId,
          shiftId: shift.id,
          workerId: input.workerId,
          positionId: input.initialPositionId,
          startedAt: input.at,
          source: 'MANUAL',
        });
      }

      return { shiftId: shift.id };
    });

    await this.events.publish({
      name: 'shift.started',
      organizationId: input.organizationId,
      occurredAt: input.at,
      payload: { shiftId: result.shiftId, workerId: input.workerId, siteId: input.siteId },
    });

    return result;
  }

  /**
   * Ends a shift: closes any open break, closes the open position session, computes the
   * durations server-side, and moves the shift to COMPLETED. One transaction.
   */
  async endShift(input: { organizationId: OrganizationId; workerId: WorkerId; at: Date }): Promise<{
    shiftId: ShiftId;
    workedSeconds: number;
    breakSeconds: number;
    /** Set when the worker was driving; the caller must strip the driving session permissions. */
    endedDriving: Awaited<ReturnType<typeof DrivingCommandService.endDrivingForSession>>;
  }> {
    const result = await this.transactions.run(input.organizationId, async (uow) => {
      const shift = await this.requireOpenShift(uow, input.organizationId, input.workerId);
      assertTransition(shift.status, 'COMPLETED');

      if (!shift.actualStart) {
        throw new PreconditionFailedError('shift.not_started', 'This shift has no start time.');
      }
      if (input.at.getTime() < shift.actualStart.getTime()) {
        throw new PreconditionFailedError(
          'shift.end_before_start',
          'Shift end must not precede its start.',
        );
      }

      const openBreak = await uow.breaks.findOpen(input.organizationId, shift.id);
      if (openBreak) {
        await uow.breaks.close({
          organizationId: input.organizationId,
          breakId: openBreak.id,
          endedAt: input.at,
          durationSeconds: Math.round((input.at.getTime() - openBreak.startedAt.getTime()) / 1000),
        });
      }

      const openSession = await uow.positionSessions.findOpenForShift(
        input.organizationId,
        shift.id,
      );
      let driving: Awaited<ReturnType<typeof DrivingCommandService.endDrivingForSession>> = null;
      if (openSession) {
        // A worker who ends their shift while driving must not leave a trip running.
        driving = await DrivingCommandService.endDrivingForSession(uow, {
          organizationId: input.organizationId,
          positionSessionId: openSession.id,
          at: input.at,
        });
        const plan = planSessionClose(openSession, input.at);
        await uow.positionSessions.close({ organizationId: input.organizationId, ...plan });
      }

      const breaks = await uow.breaks.listForShift(input.organizationId, shift.id);
      const duration = computeShiftDuration({
        actualStart: shift.actualStart,
        actualEnd: input.at,
        breaks,
      });

      await uow.shifts.close({
        organizationId: input.organizationId,
        shiftId: shift.id,
        actualEnd: input.at,
        workedSeconds: duration.workedSeconds,
        breakSeconds: duration.breakSeconds,
        autoClosed: false,
      });

      return {
        shiftId: shift.id,
        workedSeconds: duration.workedSeconds,
        breakSeconds: duration.breakSeconds,
        endedDriving: driving,
      };
    });

    await this.events.publish({
      name: 'shift.completed',
      organizationId: input.organizationId,
      occurredAt: input.at,
      payload: { ...result, workerId: input.workerId },
    });

    return {
      shiftId: result.shiftId,
      workedSeconds: result.workedSeconds,
      breakSeconds: result.breakSeconds,
      endedDriving: result.endedDriving,
    };
  }

  async startBreak(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    type: BreakType;
    at: Date;
  }): Promise<{ breakId: string }> {
    return this.transactions.run(input.organizationId, async (uow) => {
      const shift = await this.requireOpenShift(uow, input.organizationId, input.workerId);
      const openBreak = await uow.breaks.findOpen(input.organizationId, shift.id);
      assertCanStartBreak({ ...shift }, openBreak !== null);

      const created = await uow.breaks.open({
        organizationId: input.organizationId,
        shiftId: shift.id,
        type: input.type,
        startedAt: input.at,
      });
      await uow.shifts.updateStatus(input.organizationId, shift.id, 'ON_BREAK');
      return { breakId: created.id };
    });
  }

  async endBreak(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    at: Date;
  }): Promise<{ durationSeconds: number }> {
    return this.transactions.run(input.organizationId, async (uow) => {
      const shift = await this.requireOpenShift(uow, input.organizationId, input.workerId);
      assertCanEndBreak({ ...shift });

      const openBreak = await uow.breaks.findOpen(input.organizationId, shift.id);
      if (!openBreak) {
        throw new PreconditionFailedError('shift.no_open_break', 'No break is currently open.');
      }
      if (input.at.getTime() < openBreak.startedAt.getTime()) {
        throw new PreconditionFailedError(
          'shift.break_end_before_start',
          'Break end must not precede its start.',
        );
      }

      const durationSeconds = Math.round(
        (input.at.getTime() - openBreak.startedAt.getTime()) / 1000,
      );
      await uow.breaks.close({
        organizationId: input.organizationId,
        breakId: openBreak.id,
        endedAt: input.at,
        durationSeconds,
      });
      await uow.shifts.updateStatus(input.organizationId, shift.id, 'ACTIVE');
      return { durationSeconds };
    });
  }

  /**
   * The critical path: move a worker from one position to another.
   *
   * Two things have to be true at once — it must feel instant to the worker, and it must be
   * impossible to abuse. The resolution: all the expensive checking (eligibility, qualification,
   * position status) happens before the transaction opens, and the transaction itself is two
   * writes against indexed rows. The worker sees a single confirm; the server sees a close and
   * an open that commit together or not at all.
   */
  async changePosition(input: ChangePositionInput): Promise<{
    shiftId: ShiftId;
    closedSessionId: PositionSessionId | null;
    openedSessionId: PositionSessionId;
    /** Set when the worker was driving and has now stopped. */
    endedDriving: Awaited<ReturnType<typeof DrivingCommandService.endDrivingForSession>>;
  }> {
    await this.assertEligible(
      input.organizationId,
      input.workerId,
      input.targetPositionId,
      input.at,
    );

    const result = await this.transactions.run(input.organizationId, async (uow) => {
      let endedDriving: Awaited<ReturnType<typeof DrivingCommandService.endDrivingForSession>> =
        null;
      const shift = await this.requireOpenShift(uow, input.organizationId, input.workerId);
      if (shift.status === 'ON_BREAK') {
        throw new PreconditionFailedError(
          'position.change_while_on_break',
          'End the break before changing position.',
        );
      }

      const current = await uow.positionSessions.findOpenForShift(input.organizationId, shift.id);
      const plan = planPositionChange({
        currentSession: current,
        targetPositionId: input.targetPositionId,
        at: input.at,
        source: input.source,
      });

      if (plan.closing) {
        // Moving off a driving position ends the trip in the same transaction. Without this a
        // worker could be recorded at Machine 2 with a trip of theirs still running.
        endedDriving = await DrivingCommandService.endDrivingForSession(uow, {
          organizationId: input.organizationId,
          positionSessionId: plan.closing.sessionId,
          at: input.at,
        });
        await uow.positionSessions.close({
          organizationId: input.organizationId,
          ...plan.closing,
        });
      }
      const opened = await uow.positionSessions.open({
        organizationId: input.organizationId,
        shiftId: shift.id,
        workerId: input.workerId,
        positionId: plan.opening.positionId,
        startedAt: plan.opening.startedAt,
        source: plan.opening.source,
      });

      return {
        shiftId: shift.id,
        closedSessionId: plan.closing?.sessionId ?? null,
        openedSessionId: opened.id,
        fromPositionId: current?.positionId ?? null,
        endedDriving,
      };
    });

    await this.events.publish({
      name: 'position.changed',
      organizationId: input.organizationId,
      occurredAt: input.at,
      payload: {
        shiftId: result.shiftId,
        workerId: input.workerId,
        fromPositionId: result.fromPositionId,
        toPositionId: input.targetPositionId,
        source: input.source,
      },
    });

    return {
      shiftId: result.shiftId,
      closedSessionId: result.closedSessionId,
      openedSessionId: result.openedSessionId,
      endedDriving: result.endedDriving,
    };
  }

  /**
   * Supervisor correction of a historical position session.
   *
   * Requires `shifts.correct`, checked at the route. Writes the before/after snapshot to
   * `corrections` in the same transaction as the edit, so a correction can never exist without
   * its audit record.
   */
  async correctPositionSession(input: {
    organizationId: OrganizationId;
    sessionId: PositionSessionId;
    newStartedAt: Date;
    newEndedAt: Date | null;
    reason: string;
    correctedByUserId: string;
  }): Promise<void> {
    const now = this.clock.now();

    const snapshot = await this.transactions.run(input.organizationId, async (uow) => {
      const session = await uow.positionSessions.findById(input.organizationId, input.sessionId);
      if (!session) {
        throw new NotFoundError('position.session_not_found', 'Position session not found.');
      }

      const shift = await uow.shifts.findById(input.organizationId, session.shiftId);
      if (!shift || !shift.actualStart) {
        throw new NotFoundError('shift.not_found', 'Shift not found.');
      }

      const siblings = (
        await uow.positionSessions.listForShift(input.organizationId, session.shiftId)
      ).filter((candidate) => candidate.id !== session.id);

      validateCorrection({
        session,
        newStartedAt: input.newStartedAt,
        newEndedAt: input.newEndedAt,
        siblingSessions: siblings,
        shiftStart: shift.actualStart,
        shiftEnd: shift.actualEnd,
        reason: input.reason,
      });

      await uow.positionSessions.correct({
        organizationId: input.organizationId,
        sessionId: session.id,
        startedAt: input.newStartedAt,
        endedAt: input.newEndedAt,
        durationSeconds: input.newEndedAt
          ? Math.round((input.newEndedAt.getTime() - input.newStartedAt.getTime()) / 1000)
          : null,
        correctedAt: now,
      });

      return {
        original: { startedAt: session.startedAt, endedAt: session.endedAt },
        updated: { startedAt: input.newStartedAt, endedAt: input.newEndedAt },
        shiftId: session.shiftId,
      };
    });

    await this.events.publish({
      name: 'position.session_corrected',
      organizationId: input.organizationId,
      occurredAt: now,
      payload: {
        sessionId: input.sessionId,
        shiftId: snapshot.shiftId,
        originalValues: snapshot.original,
        newValues: snapshot.updated,
        reason: input.reason,
        changedByUserId: input.correctedByUserId,
      },
    });
  }

  /**
   * Closes shifts that ran past the organization's maximum duration.
   *
   * The end time is the cap, not "now": a worker who forgot to clock out at 16:00 should not be
   * recorded as having worked until the job happened to run at 03:00. The row is flagged
   * `autoClosed` so a supervisor can correct it with the real time.
   */
  async autoCloseOverrunningShifts(input: {
    organizationId: OrganizationId;
    policy: ShiftPolicy;
  }): Promise<{ closed: number }> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - input.policy.maxShiftDurationMinutes * 60_000);

    const overrunning = await this.transactions.run(input.organizationId, (uow) =>
      uow.shifts.listOverrunning({ organizationId: input.organizationId, olderThan: cutoff }),
    );

    let closed = 0;
    for (const shift of overrunning) {
      if (!shift.actualStart) continue;
      if (
        !shouldAutoClose({
          actualStart: shift.actualStart,
          now,
          maxShiftDurationMinutes: input.policy.maxShiftDurationMinutes,
        })
      ) {
        continue;
      }

      const endAt = autoCloseAt(shift.actualStart, input.policy.maxShiftDurationMinutes);
      await this.transactions.run(input.organizationId, async (uow) => {
        const openBreak = await uow.breaks.findOpen(input.organizationId, shift.id);
        if (openBreak) {
          await uow.breaks.close({
            organizationId: input.organizationId,
            breakId: openBreak.id,
            endedAt: endAt,
            durationSeconds: Math.max(
              0,
              Math.round((endAt.getTime() - openBreak.startedAt.getTime()) / 1000),
            ),
          });
        }
        const openSession = await uow.positionSessions.findOpenForShift(
          input.organizationId,
          shift.id,
        );
        if (openSession) {
          await uow.positionSessions.close({
            organizationId: input.organizationId,
            ...planSessionClose(openSession, endAt),
          });
        }
        const breaks = await uow.breaks.listForShift(input.organizationId, shift.id);
        const duration = computeShiftDuration({
          actualStart: shift.actualStart!,
          actualEnd: endAt,
          breaks,
        });
        await uow.shifts.close({
          organizationId: input.organizationId,
          shiftId: shift.id,
          actualEnd: endAt,
          workedSeconds: duration.workedSeconds,
          breakSeconds: duration.breakSeconds,
          autoClosed: true,
        });
      });

      await this.events.publish({
        name: 'shift.auto_closed',
        organizationId: input.organizationId,
        occurredAt: endAt,
        payload: { shiftId: shift.id, workerId: shift.workerId },
      });
      closed += 1;
    }

    return { closed };
  }

  private async assertEligible(
    organizationId: OrganizationId,
    workerId: WorkerId,
    positionId: PositionId,
    at: Date,
  ): Promise<void> {
    const decision = await this.workforce.checkEligibility({
      organizationId,
      workerId,
      positionId,
      now: at,
    });
    if (!decision.allowed) {
      throw new ForbiddenError(
        ELIGIBILITY_ERROR_CODES[decision.reason],
        `Worker is not eligible for this position (${decision.reason}).`,
        { details: { reason: decision.reason } },
      );
    }
    if (decision.requiresApproval) {
      // Supervisor-approval positions are not blocked here — they are routed through the
      // approval flow, which is a separate command. Reaching this point without approval means
      // the client skipped it.
      throw new ForbiddenError(
        'position.supervisor_approval_required',
        'This position requires supervisor approval.',
        { details: { reason: decision.reason } },
      );
    }
  }

  private async requireOpenShift(
    uow: ShiftUnitOfWork,
    organizationId: OrganizationId,
    workerId: WorkerId,
  ) {
    const shift = await uow.shifts.findOpenForWorker(organizationId, workerId);
    if (!shift) {
      throw new PreconditionFailedError(
        'shift.not_active',
        'The worker does not have a shift in progress.',
      );
    }
    return shift;
  }
}
