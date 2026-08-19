import type {
  OrganizationId,
  PositionId,
  QualificationId,
  SiteId,
  WorkerId,
} from '@aytracker/types';
import type {
  EligibilityOverride,
  PositionRule,
  WorkerQualificationHolding,
} from './eligibility.js';

/**
 * Repository ports.
 *
 * The domain and application layers depend on these interfaces; the Prisma implementations live
 * in `infrastructure/` and are the only files in this module that know a database exists. The
 * ESLint config enforces the direction — see eslint.config.js.
 *
 * Every method takes an explicit `organizationId`. There is deliberately no "current tenant"
 * ambient state a repository could read: a caller that forgets the tenant does not compile.
 */

export interface WorkerSummary {
  readonly id: WorkerId;
  readonly organizationId: OrganizationId;
  readonly siteId: SiteId | null;
  readonly employeeNumber: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly status: 'ACTIVE' | 'INACTIVE' | 'ON_LEAVE' | 'TERMINATED';
  readonly preferredLocale: string | null;
}

export interface WorkerCredentials {
  readonly id: WorkerId;
  readonly organizationId: OrganizationId;
  readonly pinHash: string | null;
  readonly failedPinAttempts: number;
  readonly lockedUntil: Date | null;
  readonly status: WorkerSummary['status'];
}

export interface WorkerRepository {
  findById(organizationId: OrganizationId, workerId: WorkerId): Promise<WorkerSummary | null>;
  /** Login lookup. Employee numbers are compared case-insensitively within one organization. */
  findByEmployeeNumber(
    organizationId: OrganizationId,
    employeeNumber: string,
  ): Promise<WorkerSummary | null>;
  /** Explicit, separate read so credential material is never loaded by accident. */
  findCredentials(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<WorkerCredentials | null>;
  updateLockout(
    organizationId: OrganizationId,
    workerId: WorkerId,
    state: { failedPinAttempts: number; lockedUntil: Date | null },
  ): Promise<void>;
  countActive(organizationId: OrganizationId): Promise<number>;
}

export interface PositionRepository {
  findRule(organizationId: OrganizationId, positionId: PositionId): Promise<PositionRule | null>;
  /** Every active position at a site, with its rules — the input to the picker. */
  listRulesForSite(
    organizationId: OrganizationId,
    siteId: SiteId,
  ): Promise<readonly PositionRule[]>;
  findByQrToken(organizationId: OrganizationId, qrToken: string): Promise<PositionRule | null>;
}

export interface QualificationRepository {
  listWorkerHoldings(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<readonly WorkerQualificationHolding[]>;
  listExpiringSoon(
    organizationId: OrganizationId,
    withinDays: number,
  ): Promise<readonly { workerId: WorkerId; qualificationId: QualificationId; expiresAt: Date }[]>;
}

export interface EligibilityRepository {
  listOverridesForWorker(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<readonly EligibilityOverride[]>;
}

export interface OrganizationPolicyRepository {
  /** Position-change defaults for the organization. */
  getPositionPolicy(organizationId: OrganizationId): Promise<{
    requireQualificationByDefault: boolean;
    maxShiftDurationMinutes: number;
    allowWorkerSelfShiftStart: boolean;
  }>;
}
