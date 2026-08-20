import { describe, expect, it } from 'vitest';
import {
  eligiblePositions,
  resolveEligibility,
  type EligibilityOverride,
  type PositionRule,
  type WorkerQualificationHolding,
} from '@aytracker/module-workforce';
import type { PositionId, QualificationId, WorkerId } from '@aytracker/types';

/**
 * Position eligibility is the rule a worker has the most incentive to get around, so these
 * tests read as an adversarial checklist rather than a happy path.
 */

const WORKER = 'worker-1' as WorkerId;
const NOW = new Date('2026-03-10T09:00:00Z');

const EXT_QUAL = 'qual-extrusion' as QualificationId;
const PAINT_QUAL = 'qual-paint' as QualificationId;

function position(overrides: Partial<PositionRule> = {}): PositionRule {
  return {
    positionId: 'position-1' as PositionId,
    changeMode: 'QUALIFICATION_REQUIRED',
    // Every position row carries a kind, so the fixture does too. Eligibility does not branch on
    // it — the driving rules live in the shifts module — but leaving it out of the default would
    // let a test pass against a shape the database cannot produce.
    kind: 'STANDARD',
    status: 'ACTIVE',
    requiredQualificationIds: [EXT_QUAL],
    capacity: null,
    currentOccupancy: 0,
    ...overrides,
  };
}

function decide(input: {
  position?: Partial<PositionRule>;
  held?: WorkerQualificationHolding[];
  overrides?: EligibilityOverride[];
  requireQualificationByDefault?: boolean;
}) {
  return resolveEligibility({
    workerId: WORKER,
    position: position(input.position),
    heldQualifications: input.held ?? [],
    overrides: input.overrides ?? [],
    now: NOW,
    requireQualificationByDefault: input.requireQualificationByDefault ?? true,
  });
}

describe('resolveEligibility', () => {
  it('allows a worker holding the required qualification', () => {
    const result = decide({ held: [{ qualificationId: EXT_QUAL, expiresAt: null }] });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('QUALIFICATION_SATISFIED');
  });

  it('refuses a worker without the qualification', () => {
    const result = decide({ held: [{ qualificationId: PAINT_QUAL, expiresAt: null }] });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('QUALIFICATION_MISSING');
  });

  it('refuses a worker whose qualification has expired', () => {
    const result = decide({
      held: [{ qualificationId: EXT_QUAL, expiresAt: new Date('2026-01-01T00:00:00Z') }],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('QUALIFICATION_EXPIRED');
  });

  it('requires every qualification when a position needs several', () => {
    const result = decide({
      position: { requiredQualificationIds: [EXT_QUAL, PAINT_QUAL] },
      held: [{ qualificationId: EXT_QUAL, expiresAt: null }],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('QUALIFICATION_MISSING');
  });

  it('lets anyone onto an INSTANT position — the two-second path', () => {
    const result = decide({
      position: { changeMode: 'INSTANT', requiredQualificationIds: [] },
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('INSTANT_POSITION');
  });

  it('keeps INSTANT instant even when the organization defaults to strict', () => {
    const result = decide({
      position: { changeMode: 'INSTANT', requiredQualificationIds: [] },
      requireQualificationByDefault: true,
    });
    expect(result.allowed).toBe(true);
  });

  it('flags a supervisor-approval position as requiring approval', () => {
    const result = decide({
      position: { changeMode: 'SUPERVISOR_APPROVAL' },
      held: [{ qualificationId: EXT_QUAL, expiresAt: null }],
    });
    expect(result.allowed).toBe(true);
    expect(result.allowed && result.requiresApproval).toBe(true);
  });

  describe('overrides', () => {
    it('an explicit ALLOW grants access without the qualification', () => {
      const result = decide({
        overrides: [
          {
            positionId: 'position-1' as PositionId,
            effect: 'ALLOW',
            validFrom: null,
            validTo: null,
          },
        ],
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('EXPLICIT_ALLOW');
    });

    it('an explicit DENY beats a held qualification', () => {
      const result = decide({
        held: [{ qualificationId: EXT_QUAL, expiresAt: null }],
        overrides: [
          {
            positionId: 'position-1' as PositionId,
            effect: 'DENY',
            validFrom: null,
            validTo: null,
          },
        ],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('EXPLICIT_DENY');
    });

    it('an explicit DENY beats an explicit ALLOW', () => {
      const result = decide({
        overrides: [
          {
            positionId: 'position-1' as PositionId,
            effect: 'ALLOW',
            validFrom: null,
            validTo: null,
          },
          {
            positionId: 'position-1' as PositionId,
            effect: 'DENY',
            validFrom: null,
            validTo: null,
          },
        ],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('EXPLICIT_DENY');
    });

    it('ignores an override that is not yet in force', () => {
      const result = decide({
        held: [{ qualificationId: EXT_QUAL, expiresAt: null }],
        overrides: [
          {
            positionId: 'position-1' as PositionId,
            effect: 'DENY',
            validFrom: new Date('2026-04-01T00:00:00Z'),
            validTo: null,
          },
        ],
      });
      expect(result.allowed).toBe(true);
    });

    it('ignores an override that has lapsed', () => {
      const result = decide({
        held: [{ qualificationId: EXT_QUAL, expiresAt: null }],
        overrides: [
          {
            positionId: 'position-1' as PositionId,
            effect: 'DENY',
            validFrom: null,
            validTo: new Date('2026-02-01T00:00:00Z'),
          },
        ],
      });
      expect(result.allowed).toBe(true);
    });

    it('ignores an override belonging to a different position', () => {
      const result = decide({
        held: [{ qualificationId: EXT_QUAL, expiresAt: null }],
        overrides: [
          {
            positionId: 'other-position' as PositionId,
            effect: 'DENY',
            validFrom: null,
            validTo: null,
          },
        ],
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('position availability', () => {
    it('refuses an inactive position', () => {
      const result = decide({
        position: { status: 'INACTIVE' },
        held: [{ qualificationId: EXT_QUAL, expiresAt: null }],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('POSITION_INACTIVE');
    });

    it('refuses a position at capacity', () => {
      const result = decide({
        position: { capacity: 1, currentOccupancy: 1 },
        held: [{ qualificationId: EXT_QUAL, expiresAt: null }],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('POSITION_AT_CAPACITY');
    });

    it('allows a position with spare capacity', () => {
      const result = decide({
        position: { capacity: 3, currentOccupancy: 2 },
        held: [{ qualificationId: EXT_QUAL, expiresAt: null }],
      });
      expect(result.allowed).toBe(true);
    });

    /** An inactive position is refused even for someone with an explicit ALLOW. */
    it('an explicit ALLOW does not resurrect an inactive position', () => {
      const result = decide({
        position: { status: 'ARCHIVED' },
        overrides: [
          {
            positionId: 'position-1' as PositionId,
            effect: 'ALLOW',
            validFrom: null,
            validTo: null,
          },
        ],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('POSITION_INACTIVE');
    });
  });
});

describe('eligiblePositions', () => {
  it('returns only positions the worker may occupy', () => {
    const positions: PositionRule[] = [
      position({ positionId: 'm1' as PositionId, requiredQualificationIds: [EXT_QUAL] }),
      position({ positionId: 'm2' as PositionId, requiredQualificationIds: [EXT_QUAL] }),
      position({ positionId: 'paint' as PositionId, requiredQualificationIds: [PAINT_QUAL] }),
      position({
        positionId: 'pack' as PositionId,
        changeMode: 'INSTANT',
        requiredQualificationIds: [],
      }),
      position({
        positionId: 'closed' as PositionId,
        status: 'INACTIVE',
        requiredQualificationIds: [],
      }),
    ];

    const available = eligiblePositions({
      workerId: WORKER,
      positions,
      heldQualifications: [{ qualificationId: EXT_QUAL, expiresAt: null }],
      overrides: [],
      now: NOW,
      requireQualificationByDefault: true,
    });

    expect(available.map((entry) => entry.position.positionId).sort()).toEqual([
      'm1',
      'm2',
      'pack',
    ]);
  });

  it('marks supervisor-approval positions so the client can label them', () => {
    const available = eligiblePositions({
      workerId: WORKER,
      positions: [position({ positionId: 'pb' as PositionId, changeMode: 'SUPERVISOR_APPROVAL' })],
      heldQualifications: [{ qualificationId: EXT_QUAL, expiresAt: null }],
      overrides: [],
      now: NOW,
      requireQualificationByDefault: true,
    });

    expect(available).toHaveLength(1);
    expect(available[0]!.requiresApproval).toBe(true);
  });
});
