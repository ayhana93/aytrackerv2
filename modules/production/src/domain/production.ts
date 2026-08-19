import { PreconditionFailedError, ValidationError } from '@aytracker/domain';
import type { PositionId, ProductionEntryId, WorkerId } from '@aytracker/types';

/**
 * Production recording and productivity arithmetic.
 *
 * All of it server-side. The worker portal sends quantities; every derived number — rate,
 * defect ratio, target attainment — is computed here, so two clients on different versions can
 * never disagree about what a shift produced.
 */

export interface ProductionQuantities {
  readonly goodQuantity: number;
  readonly defectQuantity: number;
}

export function assertValidQuantities(input: ProductionQuantities): void {
  if (!Number.isFinite(input.goodQuantity) || !Number.isFinite(input.defectQuantity)) {
    throw new ValidationError('production.invalid_quantity', 'Quantities must be numbers.');
  }
  if (input.goodQuantity < 0 || input.defectQuantity < 0) {
    throw new ValidationError('production.negative_quantity', 'Quantities must not be negative.');
  }
  if (input.goodQuantity === 0 && input.defectQuantity === 0) {
    throw new ValidationError('production.empty_entry', 'An entry must record some quantity.');
  }
}

/**
 * A production entry must be attributable to where the work happened.
 *
 * Recording production against a position the worker was not occupying at that moment would
 * make position utilization meaningless, so the entry is tied to the open position session.
 */
export function assertEntryMatchesSession(input: {
  positionId: PositionId;
  sessionPositionId: PositionId | null;
  recordedAt: Date;
  sessionStartedAt: Date | null;
  sessionEndedAt: Date | null;
}): void {
  if (input.sessionPositionId === null) {
    throw new PreconditionFailedError(
      'production.no_active_position',
      'Production can only be recorded while occupying a position.',
    );
  }
  if (input.sessionPositionId !== input.positionId) {
    throw new PreconditionFailedError(
      'production.position_mismatch',
      'Production must be recorded against the current position.',
    );
  }
  if (input.sessionStartedAt && input.recordedAt.getTime() < input.sessionStartedAt.getTime()) {
    throw new ValidationError(
      'production.before_session_start',
      'An entry cannot predate the position session it belongs to.',
    );
  }
  if (input.sessionEndedAt && input.recordedAt.getTime() > input.sessionEndedAt.getTime()) {
    throw new ValidationError(
      'production.after_session_end',
      'An entry cannot postdate the position session it belongs to.',
    );
  }
}

export interface ProductionEntrySummary {
  readonly id: ProductionEntryId;
  readonly workerId: WorkerId;
  readonly positionId: PositionId;
  readonly goodQuantity: number;
  readonly defectQuantity: number;
  readonly recordedAt: Date;
}

export interface ProductivityMetrics {
  readonly totalGood: number;
  readonly totalDefects: number;
  readonly totalUnits: number;
  /** defects ÷ total, as a fraction. Null when nothing was produced. */
  readonly defectRate: number | null;
  /** Good units per productive hour. Null when no productive time elapsed. */
  readonly unitsPerHour: number | null;
  /** Attainment against target, as a fraction (1.0 = on target). Null when no target is set. */
  readonly targetAttainment: number | null;
}

/**
 * Productivity for a set of entries over a span of productive time.
 *
 * `productiveSeconds` is worked time minus unpaid breaks — the same number the shift module
 * computes — so productivity and attendance can never disagree about how long someone worked.
 * Rates are null rather than zero when the denominator is zero: "no data" and "zero per hour"
 * are different statements, and only one of them is true.
 */
export function computeProductivity(input: {
  entries: readonly ProductionEntrySummary[];
  productiveSeconds: number;
  targetPerHour: number | null;
}): ProductivityMetrics {
  const totalGood = input.entries.reduce((sum, entry) => sum + entry.goodQuantity, 0);
  const totalDefects = input.entries.reduce((sum, entry) => sum + entry.defectQuantity, 0);
  const totalUnits = totalGood + totalDefects;

  const hours = input.productiveSeconds / 3600;
  const unitsPerHour = hours > 0 ? totalGood / hours : null;

  return {
    totalGood,
    totalDefects,
    totalUnits,
    defectRate: totalUnits > 0 ? totalDefects / totalUnits : null,
    unitsPerHour: unitsPerHour === null ? null : round(unitsPerHour, 3),
    targetAttainment:
      unitsPerHour !== null && input.targetPerHour && input.targetPerHour > 0
        ? round(unitsPerHour / input.targetPerHour, 4)
        : null,
  };
}

export interface PositionUtilization {
  readonly positionId: PositionId;
  readonly occupiedSeconds: number;
  /** Fraction of the reporting window the position was occupied. */
  readonly utilizationRate: number | null;
  readonly unitsProduced: number;
}

export function computePositionUtilization(input: {
  windowSeconds: number;
  occupancy: readonly { positionId: PositionId; seconds: number }[];
  entries: readonly ProductionEntrySummary[];
}): readonly PositionUtilization[] {
  const unitsByPosition = new Map<PositionId, number>();
  for (const entry of input.entries) {
    unitsByPosition.set(
      entry.positionId,
      (unitsByPosition.get(entry.positionId) ?? 0) + entry.goodQuantity,
    );
  }

  return input.occupancy
    .map((entry) => ({
      positionId: entry.positionId,
      occupiedSeconds: entry.seconds,
      utilizationRate:
        input.windowSeconds > 0 ? round(entry.seconds / input.windowSeconds, 4) : null,
      unitsProduced: unitsByPosition.get(entry.positionId) ?? 0,
    }))
    .sort((a, b) => b.occupiedSeconds - a.occupiedSeconds);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
