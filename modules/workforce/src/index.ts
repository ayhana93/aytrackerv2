/**
 * @aytracker/module-workforce — sites, work areas, positions, workers, qualifications and the
 * eligibility rules that decide which position a worker may occupy.
 *
 * Public surface only. Other modules import from here and never reach into `src/`.
 */

export {
  resolveEligibility,
  eligiblePositions,
  ELIGIBILITY_ERROR_CODES,
  type EligibilityDecision,
  type EligibilityInput,
  type EligibilityOverride,
  type EligibilityReason,
  type PositionChangeMode,
  type PositionKind,
  type PositionRule,
  type WorkerQualificationHolding,
} from './domain/eligibility.js';

export type {
  EligibilityRepository,
  OrganizationPolicyRepository,
  PositionRepository,
  QualificationRepository,
  WorkerCredentials,
  WorkerRepository,
  WorkerSummary,
} from './domain/ports.js';

export { WorkforceQueryService } from './application/workforce-query-service.js';

export {
  PrismaEligibilityRepository,
  PrismaOrganizationPolicyRepository,
  PrismaPositionRepository,
  PrismaQualificationRepository,
  PrismaWorkerRepository,
} from './infrastructure/prisma-repositories.js';
