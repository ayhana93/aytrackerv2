import type { PositionId, QualificationId, WorkerId } from '@aytracker/types';

/**
 * Worker → position eligibility.
 *
 * This is the rule a worker is most motivated to get around, so it is written as a pure
 * function over explicit inputs: no database access, no clock reads except the one passed in,
 * and no way for a caller to supply a "yes" that skips the check. The API layer calls this with
 * data it loaded itself under the tenant scope; a client-supplied position id is only ever the
 * *subject* of the question, never part of the answer.
 */

export type PositionChangeMode = 'INSTANT' | 'QUALIFICATION_REQUIRED' | 'SUPERVISOR_APPROVAL';

export interface PositionRule {
  readonly positionId: PositionId;
  readonly changeMode: PositionChangeMode;
  readonly status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  /** All qualifications the position requires. The worker must hold every one. */
  readonly requiredQualificationIds: readonly QualificationId[];
  readonly capacity: number | null;
  /** Workers currently occupying the position — used only when capacity is set. */
  readonly currentOccupancy: number;
}

export interface WorkerQualificationHolding {
  readonly qualificationId: QualificationId;
  readonly expiresAt: Date | null;
}

export interface EligibilityOverride {
  readonly positionId: PositionId;
  readonly effect: 'ALLOW' | 'DENY';
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
}

export interface EligibilityInput {
  readonly workerId: WorkerId;
  readonly position: PositionRule;
  readonly heldQualifications: readonly WorkerQualificationHolding[];
  readonly overrides: readonly EligibilityOverride[];
  readonly now: Date;
  /** Organization default when a position does not state its own policy. */
  readonly requireQualificationByDefault: boolean;
}

export type EligibilityDecision =
  | {
      readonly allowed: true;
      readonly requiresApproval: boolean;
      readonly reason: EligibilityReason;
    }
  | { readonly allowed: false; readonly reason: EligibilityReason };

export type EligibilityReason =
  | 'EXPLICIT_DENY'
  | 'EXPLICIT_ALLOW'
  | 'POSITION_INACTIVE'
  | 'POSITION_AT_CAPACITY'
  | 'QUALIFICATION_MISSING'
  | 'QUALIFICATION_EXPIRED'
  | 'QUALIFICATION_SATISFIED'
  | 'INSTANT_POSITION'
  | 'SUPERVISOR_APPROVAL_REQUIRED';

/** Machine-readable error codes; the client turns these into localized text. */
export const ELIGIBILITY_ERROR_CODES: Readonly<Record<EligibilityReason, string>> = {
  EXPLICIT_DENY: 'position.not_eligible',
  EXPLICIT_ALLOW: 'position.not_eligible',
  POSITION_INACTIVE: 'position.inactive',
  POSITION_AT_CAPACITY: 'position.at_capacity',
  QUALIFICATION_MISSING: 'position.qualification_required',
  QUALIFICATION_EXPIRED: 'position.qualification_expired',
  QUALIFICATION_SATISFIED: 'position.not_eligible',
  INSTANT_POSITION: 'position.not_eligible',
  SUPERVISOR_APPROVAL_REQUIRED: 'position.supervisor_approval_required',
};

/**
 * Resolution order, highest precedence first:
 *   1. An in-force explicit DENY. Always wins — this is how a supervisor removes someone from a
 *      machine after an incident, and nothing may override it.
 *   2. Position not usable at all (inactive/archived, or at capacity).
 *   3. An in-force explicit ALLOW. Grants access without a qualification, deliberately: it is
 *      the documented escape hatch for a trainee working under supervision.
 *   4. The position's own change mode.
 */
export function resolveEligibility(input: EligibilityInput): EligibilityDecision {
  const activeOverrides = input.overrides.filter(
    (override) =>
      override.positionId === input.position.positionId && isInForce(override, input.now),
  );

  if (activeOverrides.some((override) => override.effect === 'DENY')) {
    return { allowed: false, reason: 'EXPLICIT_DENY' };
  }

  if (input.position.status !== 'ACTIVE') {
    return { allowed: false, reason: 'POSITION_INACTIVE' };
  }

  if (
    input.position.capacity !== null &&
    input.position.currentOccupancy >= input.position.capacity
  ) {
    return { allowed: false, reason: 'POSITION_AT_CAPACITY' };
  }

  if (activeOverrides.some((override) => override.effect === 'ALLOW')) {
    return { allowed: true, requiresApproval: false, reason: 'EXPLICIT_ALLOW' };
  }

  const mode = effectiveChangeMode(input.position.changeMode, input.requireQualificationByDefault);

  if (mode === 'INSTANT') {
    return { allowed: true, requiresApproval: false, reason: 'INSTANT_POSITION' };
  }

  const qualificationCheck = checkQualifications(
    input.position.requiredQualificationIds,
    input.heldQualifications,
    input.now,
  );
  if (!qualificationCheck.satisfied) {
    return { allowed: false, reason: qualificationCheck.reason };
  }

  if (mode === 'SUPERVISOR_APPROVAL') {
    return { allowed: true, requiresApproval: true, reason: 'SUPERVISOR_APPROVAL_REQUIRED' };
  }

  return { allowed: true, requiresApproval: false, reason: 'QUALIFICATION_SATISFIED' };
}

/**
 * A position marked INSTANT stays instant even when the organization defaults to requiring
 * qualifications: the whole point of the two-second position change is that ordinary positions
 * do not interrogate the worker. The default only tightens positions that have not decided.
 */
function effectiveChangeMode(
  mode: PositionChangeMode,
  requireQualificationByDefault: boolean,
): PositionChangeMode {
  if (mode === 'INSTANT' && requireQualificationByDefault) return 'INSTANT';
  return mode;
}

function checkQualifications(
  required: readonly QualificationId[],
  held: readonly WorkerQualificationHolding[],
  now: Date,
):
  | { satisfied: true }
  | { satisfied: false; reason: 'QUALIFICATION_MISSING' | 'QUALIFICATION_EXPIRED' } {
  if (required.length === 0) return { satisfied: true };

  const heldById = new Map(held.map((holding) => [holding.qualificationId, holding]));
  let sawExpired = false;

  for (const requirement of required) {
    const holding = heldById.get(requirement);
    if (!holding) return { satisfied: false, reason: 'QUALIFICATION_MISSING' };
    if (holding.expiresAt !== null && holding.expiresAt.getTime() <= now.getTime()) {
      sawExpired = true;
    }
  }

  if (sawExpired) return { satisfied: false, reason: 'QUALIFICATION_EXPIRED' };
  return { satisfied: true };
}

function isInForce(override: EligibilityOverride, now: Date): boolean {
  if (override.validFrom && override.validFrom.getTime() > now.getTime()) return false;
  if (override.validTo && override.validTo.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * The list a worker sees in the position picker.
 *
 * Filtering happens on the server, not in the client: a position the worker may not use is
 * never sent, so the picker cannot be tampered with to reveal or select one.
 */
export function eligiblePositions(input: {
  workerId: WorkerId;
  positions: readonly PositionRule[];
  heldQualifications: readonly WorkerQualificationHolding[];
  overrides: readonly EligibilityOverride[];
  now: Date;
  requireQualificationByDefault: boolean;
}): readonly { position: PositionRule; requiresApproval: boolean }[] {
  return input.positions
    .map((position) => ({
      position,
      decision: resolveEligibility({
        workerId: input.workerId,
        position,
        heldQualifications: input.heldQualifications,
        overrides: input.overrides,
        now: input.now,
        requireQualificationByDefault: input.requireQualificationByDefault,
      }),
    }))
    .filter((entry) => entry.decision.allowed)
    .map((entry) => ({
      position: entry.position,
      requiresApproval: entry.decision.allowed ? entry.decision.requiresApproval : false,
    }));
}
