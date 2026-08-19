import { NotFoundError } from '@aytracker/domain';
import type { OrganizationId, PositionId, SiteId, WorkerId } from '@aytracker/types';
import {
  eligiblePositions,
  resolveEligibility,
  type EligibilityDecision,
  type PositionRule,
} from '../domain/eligibility.js';
import type {
  EligibilityRepository,
  OrganizationPolicyRepository,
  PositionRepository,
  QualificationRepository,
  WorkerRepository,
} from '../domain/ports.js';

export interface AvailablePosition {
  readonly positionId: PositionId;
  readonly requiresApproval: boolean;
}

/**
 * Read-side service for workforce questions other modules need answered.
 *
 * `shifts` calls this to decide whether a position change is allowed. It does not query
 * workforce tables directly — that is the module boundary, and it is what lets the eligibility
 * rules change without touching the shift code.
 */
export class WorkforceQueryService {
  constructor(
    private readonly workers: WorkerRepository,
    private readonly positions: PositionRepository,
    private readonly qualifications: QualificationRepository,
    private readonly eligibility: EligibilityRepository,
    private readonly policy: OrganizationPolicyRepository,
  ) {}

  /**
   * The authoritative answer to "may this worker move to this position, right now".
   *
   * Loads every input itself under the caller's tenant scope. A caller cannot pass in a
   * pre-computed decision, a qualification list, or a position rule — which is precisely how a
   * client would try to bypass the check.
   */
  async checkEligibility(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    positionId: PositionId;
    now: Date;
  }): Promise<EligibilityDecision> {
    const position = await this.positions.findRule(input.organizationId, input.positionId);
    if (!position) {
      throw new NotFoundError('position.not_found', 'Position not found.');
    }
    return this.decide(input.organizationId, input.workerId, position, input.now);
  }

  /** Same check, but the position is identified by its QR token rather than its id. */
  async checkEligibilityByQr(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    qrToken: string;
    now: Date;
  }): Promise<{ position: PositionRule; decision: EligibilityDecision }> {
    const position = await this.positions.findByQrToken(input.organizationId, input.qrToken);
    if (!position) {
      // A QR code is a convenience, not a credential: an unknown token is simply not found.
      throw new NotFoundError('position.qr_not_recognized', 'Position code not recognized.');
    }
    const decision = await this.decide(input.organizationId, input.workerId, position, input.now);
    return { position, decision };
  }

  /** Positions to offer in the picker. Ineligible positions are never sent to the client. */
  async listAvailablePositions(input: {
    organizationId: OrganizationId;
    workerId: WorkerId;
    siteId: SiteId;
    now: Date;
  }): Promise<readonly AvailablePosition[]> {
    const [rules, holdings, overrides, policy] = await Promise.all([
      this.positions.listRulesForSite(input.organizationId, input.siteId),
      this.qualifications.listWorkerHoldings(input.organizationId, input.workerId),
      this.eligibility.listOverridesForWorker(input.organizationId, input.workerId),
      this.policy.getPositionPolicy(input.organizationId),
    ]);

    return eligiblePositions({
      workerId: input.workerId,
      positions: rules,
      heldQualifications: holdings,
      overrides,
      now: input.now,
      requireQualificationByDefault: policy.requireQualificationByDefault,
    }).map((entry) => ({
      positionId: entry.position.positionId,
      requiresApproval: entry.requiresApproval,
    }));
  }

  async countActiveWorkers(organizationId: OrganizationId): Promise<number> {
    return this.workers.countActive(organizationId);
  }

  private async decide(
    organizationId: OrganizationId,
    workerId: WorkerId,
    position: PositionRule,
    now: Date,
  ): Promise<EligibilityDecision> {
    const [holdings, overrides, policy] = await Promise.all([
      this.qualifications.listWorkerHoldings(organizationId, workerId),
      this.eligibility.listOverridesForWorker(organizationId, workerId),
      this.policy.getPositionPolicy(organizationId),
    ]);

    return resolveEligibility({
      workerId,
      position,
      heldQualifications: holdings,
      overrides,
      now,
      requireQualificationByDefault: policy.requireQualificationByDefault,
    });
  }
}
