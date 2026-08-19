import { FEATURES, type FeatureCode } from './entitlements.js';

/**
 * Seed definitions for the default plans.
 *
 * These are the *initial* rows, not a hardcoded ruleset: everything the application reads at
 * runtime comes from the database. Changing a plan in production is a migration or an admin
 * action, never an edit to this file plus a deploy.
 */

export type PlanTier = 'FREE' | 'STARTER' | 'PROFESSIONAL' | 'BUSINESS' | 'ENTERPRISE';

export interface PlanDefinition {
  readonly code: string;
  readonly name: string;
  readonly tier: PlanTier;
  readonly description: string;
  readonly sortOrder: number;
  readonly isPublic: boolean;
  readonly features: readonly FeatureCode[];
  /** Hard caps enforced by Entitlements.requireCapacity. */
  readonly limits: Readonly<Record<string, number>>;
}

const STARTER_FEATURES: FeatureCode[] = [
  FEATURES.WORKFORCE,
  FEATURES.SHIFT_MANAGEMENT,
  FEATURES.PRODUCTION,
];

const PROFESSIONAL_FEATURES: FeatureCode[] = [
  ...STARTER_FEATURES,
  FEATURES.PRODUCTIVITY_ANALYTICS,
  FEATURES.OFFLINE_MODE,
  FEATURES.DRIVER_PORTAL,
  FEATURES.WHITE_LABEL,
];

const BUSINESS_FEATURES: FeatureCode[] = [
  ...PROFESSIONAL_FEATURES,
  FEATURES.FLEET_MANAGEMENT,
  FEATURES.GPS_TRACKING,
  FEATURES.FUEL_COSTS,
  FEATURES.ADVANCED_REPORTS,
  FEATURES.API_ACCESS,
  FEATURES.INTEGRATIONS,
];

const ENTERPRISE_FEATURES: FeatureCode[] = [...BUSINESS_FEATURES, FEATURES.AI_ASSISTANT];

export const PLAN_DEFINITIONS: readonly PlanDefinition[] = [
  {
    code: 'starter',
    name: 'Starter',
    tier: 'STARTER',
    description: 'Workforce, shifts and basic production tracking.',
    sortOrder: 10,
    isPublic: true,
    features: STARTER_FEATURES,
    limits: { workers: 25, sites: 1, vehicles: 0, drivers: 0 },
  },
  {
    code: 'professional',
    name: 'Professional',
    tier: 'PROFESSIONAL',
    description: 'Adds productivity analytics, offline mode and the driver portal.',
    sortOrder: 20,
    isPublic: true,
    features: PROFESSIONAL_FEATURES,
    limits: { workers: 100, sites: 3, vehicles: 0, drivers: 15 },
  },
  {
    code: 'business',
    name: 'Business',
    tier: 'BUSINESS',
    description: 'Adds fleet management, GPS tracking, advanced reporting and API access.',
    sortOrder: 30,
    isPublic: true,
    features: BUSINESS_FEATURES,
    limits: { workers: 500, sites: 10, vehicles: 50, drivers: 50 },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    tier: 'ENTERPRISE',
    description: 'Custom modules, workflows and integrations.',
    sortOrder: 40,
    isPublic: false,
    features: ENTERPRISE_FEATURES,
    limits: {},
  },
];

export interface FeatureDefinition {
  readonly code: FeatureCode;
  readonly name: string;
  readonly moduleCode: string;
}

export const FEATURE_DEFINITIONS: readonly FeatureDefinition[] = [
  { code: FEATURES.WORKFORCE, name: 'Workforce', moduleCode: 'workforce' },
  { code: FEATURES.SHIFT_MANAGEMENT, name: 'Shift management', moduleCode: 'shifts' },
  { code: FEATURES.PRODUCTION, name: 'Production tracking', moduleCode: 'production' },
  { code: FEATURES.ADVANCED_REPORTS, name: 'Advanced reports', moduleCode: 'reporting' },
  { code: FEATURES.OFFLINE_MODE, name: 'Offline mode', moduleCode: 'shifts' },
  { code: FEATURES.PRODUCTIVITY_ANALYTICS, name: 'Productivity analytics', moduleCode: 'reporting' },
  { code: FEATURES.DRIVER_PORTAL, name: 'Driver portal', moduleCode: 'drivers' },
  { code: FEATURES.FLEET_MANAGEMENT, name: 'Fleet management', moduleCode: 'fleet' },
  { code: FEATURES.GPS_TRACKING, name: 'GPS tracking', moduleCode: 'drivers' },
  { code: FEATURES.FUEL_COSTS, name: 'Fuel costs', moduleCode: 'fleet' },
  { code: FEATURES.API_ACCESS, name: 'API access', moduleCode: 'platform' },
  { code: FEATURES.INTEGRATIONS, name: 'Integrations', moduleCode: 'platform' },
  { code: FEATURES.AI_ASSISTANT, name: 'AI assistant', moduleCode: 'ai' },
  { code: FEATURES.WHITE_LABEL, name: 'White-label branding', moduleCode: 'platform' },
];
