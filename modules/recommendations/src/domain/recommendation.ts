import { ForbiddenError, ValidationError } from '@aytracker/domain';

/**
 * Customer recommendations — the feedback loop from "a customer had an idea" to "it shipped".
 */

export type RecommendationCategory =
  | 'NEW_FEATURE'
  | 'IMPROVEMENT'
  | 'BUG'
  | 'INTEGRATION'
  | 'REPORTING'
  | 'DRIVER_FLEET'
  | 'OTHER';

export type RecommendationPriority = 'NICE_TO_HAVE' | 'IMPORTANT' | 'CRITICAL';

export type RecommendationStatus =
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'PLANNED'
  | 'IN_DEVELOPMENT'
  | 'RELEASED'
  | 'DECLINED'
  | 'DUPLICATE';

export const MIN_TITLE_LENGTH = 4;
export const MAX_TITLE_LENGTH = 160;
export const MIN_DESCRIPTION_LENGTH = 10;
export const MAX_DESCRIPTION_LENGTH = 4000;

export function assertValidSubmission(input: { title: string; description: string }): void {
  const title = input.title.trim();
  const description = input.description.trim();

  if (title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      'recommendation.invalid_title',
      `Title must be between ${MIN_TITLE_LENGTH} and ${MAX_TITLE_LENGTH} characters.`,
    );
  }
  if (
    description.length < MIN_DESCRIPTION_LENGTH ||
    description.length > MAX_DESCRIPTION_LENGTH
  ) {
    throw new ValidationError(
      'recommendation.invalid_description',
      `Description must be between ${MIN_DESCRIPTION_LENGTH} and ${MAX_DESCRIPTION_LENGTH} characters.`,
    );
  }
}

/**
 * Status transitions.
 *
 * Only platform staff move a recommendation along; a customer sees the status but cannot set
 * it. RELEASED and DECLINED are terminal — reopening means a new recommendation linked to the
 * same roadmap item, which keeps the history of what a customer was told honest.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<RecommendationStatus, readonly RecommendationStatus[]>> =
  {
    SUBMITTED: ['UNDER_REVIEW', 'PLANNED', 'DECLINED', 'DUPLICATE'],
    UNDER_REVIEW: ['PLANNED', 'DECLINED', 'DUPLICATE', 'IN_DEVELOPMENT'],
    PLANNED: ['IN_DEVELOPMENT', 'DECLINED', 'DUPLICATE'],
    IN_DEVELOPMENT: ['RELEASED', 'PLANNED', 'DECLINED'],
    RELEASED: [],
    DECLINED: [],
    DUPLICATE: [],
  };

export function assertStatusTransition(
  from: RecommendationStatus,
  to: RecommendationStatus,
): void {
  if (!(ALLOWED_TRANSITIONS[from] ?? []).includes(to)) {
    throw new ValidationError(
      'recommendation.invalid_transition',
      `Cannot move a recommendation from ${from} to ${to}.`,
      { details: { from, to } },
    );
  }
}

/**
 * A customer reads their own organization's recommendations, and nothing else.
 *
 * Platform staff see all of them — that is the whole point of a shared roadmap — but the
 * per-organization scoping is what stops one customer learning what another is asking for.
 */
export function assertCanRead(input: {
  actorOrganizationId: string;
  recommendationOrganizationId: string;
  isPlatformAdmin: boolean;
}): void {
  if (input.isPlatformAdmin) return;
  if (input.actorOrganizationId !== input.recommendationOrganizationId) {
    throw new ForbiddenError(
      'recommendation.not_own_organization',
      'Recommendations are visible only to the organization that submitted them.',
    );
  }
}

/** Merging duplicates: the target must not itself be a duplicate, or chains form. */
export function assertCanMerge(input: {
  sourceId: string;
  targetId: string;
  targetDuplicateOfId: string | null;
}): void {
  if (input.sourceId === input.targetId) {
    throw new ValidationError(
      'recommendation.self_merge',
      'A recommendation cannot be a duplicate of itself.',
    );
  }
  if (input.targetDuplicateOfId !== null) {
    throw new ValidationError(
      'recommendation.merge_into_duplicate',
      'Merge into the original recommendation, not another duplicate.',
      { details: { canonicalId: input.targetDuplicateOfId } },
    );
  }
}
