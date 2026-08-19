import { EntitlementRequiredError } from '@aytracker/domain';
import type { OrganizationId } from '@aytracker/types';

/**
 * Feature codes. One vocabulary, shared by the database `features` table, the plan definitions
 * and every `entitlements.can(...)` call.
 */
export const FEATURES = {
  WORKFORCE: 'workforce',
  SHIFT_MANAGEMENT: 'shifts.management',
  PRODUCTION: 'production',
  ADVANCED_REPORTS: 'reports.advanced',
  OFFLINE_MODE: 'offline.mode',
  PRODUCTIVITY_ANALYTICS: 'analytics.productivity',
  DRIVER_PORTAL: 'driver.portal',
  FLEET_MANAGEMENT: 'fleet.management',
  GPS_TRACKING: 'fleet.gps_tracking',
  FUEL_COSTS: 'fleet.fuel_costs',
  API_ACCESS: 'api.access',
  INTEGRATIONS: 'integrations',
  AI_ASSISTANT: 'ai.assistant',
  WHITE_LABEL: 'branding.white_label',
} as const;

export type FeatureCode = (typeof FEATURES)[keyof typeof FEATURES];

export interface EntitlementRecord {
  readonly featureCode: string;
  readonly isEnabled: boolean;
  /** Numeric cap for metered features; null means unlimited. */
  readonly limit: number | null;
  readonly expiresAt: Date | null;
}

export interface EntitlementSnapshot {
  readonly organizationId: OrganizationId;
  readonly entitlements: readonly EntitlementRecord[];
  /** Feature codes blocked in this organization's market regardless of plan. */
  readonly marketBlockedFeatures: readonly string[];
  readonly resolvedAt: Date;
}

/**
 * Reads a resolved entitlement snapshot.
 *
 * Every plan check in the codebase goes through `can()` / `require()`. There are deliberately
 * no plan-tier comparisons anywhere else: a new plan is a row, not a code change.
 */
export class Entitlements {
  private readonly byCode: ReadonlyMap<string, EntitlementRecord>;
  private readonly blocked: ReadonlySet<string>;

  constructor(
    private readonly snapshot: EntitlementSnapshot,
    private readonly now: Date = new Date(),
  ) {
    this.byCode = new Map(snapshot.entitlements.map((e) => [e.featureCode, e]));
    this.blocked = new Set(snapshot.marketBlockedFeatures);
  }

  can(featureCode: FeatureCode | string): boolean {
    // A market-level block beats any plan grant: it exists for regulatory carve-outs.
    if (this.blocked.has(featureCode)) return false;
    const entitlement = this.byCode.get(featureCode);
    if (!entitlement || !entitlement.isEnabled) return false;
    if (entitlement.expiresAt && entitlement.expiresAt.getTime() <= this.now.getTime()) {
      return false;
    }
    return true;
  }

  require(featureCode: FeatureCode | string): void {
    if (!this.can(featureCode)) {
      throw new EntitlementRequiredError(featureCode);
    }
  }

  /** Cap for a metered feature, or null when unlimited/ungranted. */
  limitFor(featureCode: FeatureCode | string): number | null {
    if (!this.can(featureCode)) return null;
    return this.byCode.get(featureCode)?.limit ?? null;
  }

  /**
   * Checks a metered feature against current usage.
   * `currentUsage` is the count *before* the item being added.
   */
  canAdd(featureCode: FeatureCode | string, currentUsage: number, adding = 1): boolean {
    if (!this.can(featureCode)) return false;
    const limit = this.limitFor(featureCode);
    if (limit === null) return true;
    return currentUsage + adding <= limit;
  }

  requireCapacity(featureCode: FeatureCode | string, currentUsage: number, adding = 1): void {
    this.require(featureCode);
    if (!this.canAdd(featureCode, currentUsage, adding)) {
      throw new EntitlementRequiredError(featureCode, {
        details: { reason: 'limit_reached', limit: this.limitFor(featureCode), currentUsage },
      });
    }
  }

  get organizationId(): OrganizationId {
    return this.snapshot.organizationId;
  }

  /** Feature codes currently usable — handed to the client so the UI can hide dead controls. */
  enabledFeatureCodes(): readonly string[] {
    return this.snapshot.entitlements
      .map((e) => e.featureCode)
      .filter((code) => this.can(code))
      .sort();
  }
}

/**
 * Deterministic percentage rollout for feature flags.
 *
 * Same organization always lands in the same bucket, so a rollout does not flicker between
 * requests — and two flags at 10 % do not necessarily hit the same organizations, because the
 * flag key is part of the hash.
 */
export function isInRollout(flagKey: string, organizationId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  let hash = 2166136261;
  const input = `${flagKey}:${organizationId}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < percent;
}
