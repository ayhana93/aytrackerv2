import { z } from 'zod';
import {
  codeSchema,
  countryCodeSchema,
  currencyCodeSchema,
  emailSchema,
  hexColorSchema,
  localeSchema,
  textSchema,
  timezoneSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Organization, branding, market and recommendation schemas.
 */

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  legalName: z.string().trim().max(200).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Use lowercase letters, digits and hyphens'),
  countryCode: countryCodeSchema,
  /**
   * The billing country the customer declares at signup. It is stored, then treated as
   * authoritative for pricing and tax — and changing it later is an audited operation, not a
   * field a request can flip to reach a cheaper market.
   */
  billingCountry: countryCodeSchema,
  defaultLocale: localeSchema,
  defaultTimezone: timezoneSchema,
  defaultCurrency: currencyCodeSchema,
});

/**
 * Branding.
 *
 * Asset URLs are validated against the approved host list by the route (it knows the configured
 * storage host); this schema covers shape and length. SVG uploads are handled by the upload
 * endpoint, which rasterizes or rejects them — an SVG is a script container, and one tenant's
 * logo renders on that tenant's login page.
 */
export const updateBrandingSchema = z.object({
  companyName: z.string().trim().max(160).nullable().optional(),
  primaryColor: hexColorSchema.nullable().optional(),
  secondaryColor: hexColorSchema.nullable().optional(),
  accentColor: hexColorSchema.nullable().optional(),
  loginMessage: textSchema(0, 280).nullable().optional(),
  customSupportEmail: emailSchema.nullable().optional(),
});

/**
 * The settings that change how the product behaves day to day.
 *
 * Deliberately narrow. Retention windows and the tenant's own identity are not here: those are
 * decisions with legal weight or with an audit trail behind them, and this is the screen an
 * operations manager opens to say what a litre costs this month.
 *
 * Every field is optional, and a patch carries only what changed. `fuelPricePerLiter` accepts
 * null explicitly — clearing it is a real intent ("we no longer want costs estimated"), and is
 * different from omitting it.
 */
export const updateOperationalSettingsSchema = z.object({
  /** Price of a litre in the organization's default currency, to four decimals. */
  fuelPricePerLiter: z
    .string()
    .trim()
    .regex(/^\d{1,6}(\.\d{1,4})?$/, 'Expected a price such as 2.45')
    .refine((value) => Number(value) > 0, 'A price must be greater than zero')
    .nullable()
    .optional(),
  /** False when only a supervisor may open a shift. */
  allowWorkerSelfShiftStart: z.boolean().optional(),
  /** After this long, an abandoned shift is auto-closed at the cap rather than left running. */
  maxShiftDurationMinutes: z.number().int().min(60).max(1440).optional(),
  /**
   * The sampling floor handed to driver devices.
   *
   * Sent to the client and enforced on ingestion. Tightening it costs battery on every phone in
   * the fleet, which is why the bounds are narrow rather than free.
   */
  gpsMinIntervalSeconds: z.number().int().min(5).max(300).optional(),
  gpsMinDistanceMeters: z.number().int().min(10).max(2000).optional(),
});

export const marketQuerySchema = z.object({
  /**
   * A visitor's explicit market choice on the public pricing page. Display only: it is ranked
   * below the organization's billing country in MarketResolver, so an authenticated customer
   * cannot use it to move markets.
   */
  market: codeSchema.optional(),
  interval: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
});

export const recommendationSchema = z.object({
  title: textSchema(4, 160),
  description: textSchema(10, 4000),
  category: z
    .enum([
      'NEW_FEATURE',
      'IMPROVEMENT',
      'BUG',
      'INTEGRATION',
      'REPORTING',
      'DRIVER_FLEET',
      'OTHER',
    ])
    .default('OTHER'),
  priority: z.enum(['NICE_TO_HAVE', 'IMPORTANT', 'CRITICAL']).default('NICE_TO_HAVE'),
});

export const updateRecommendationStatusSchema = z.object({
  status: z.enum([
    'SUBMITTED',
    'UNDER_REVIEW',
    'PLANNED',
    'IN_DEVELOPMENT',
    'RELEASED',
    'DECLINED',
    'DUPLICATE',
  ]),
  adminNotes: z.string().trim().max(4000).optional(),
  roadmapItemId: uuidSchema.nullable().optional(),
});

/*
 * `createWorkerSchema` and `createPositionSchema` both used to live here, unused.
 *
 * Neither is platform-level: a worker and a position belong to a tenant's workforce, which is
 * what `workforce.ts` is for, and this file is for the things the platform operator does — create
 * an organization, set its branding, triage a recommendation. `createWorkerSchema` moved there
 * when the admin API grew a route that parses it; `createPositionSchema` was a second, worse copy
 * of one already in `workforce.ts` and was removed rather than kept "just in case".
 */

export type CreateOrganizationRequest = z.infer<typeof createOrganizationSchema>;
export type UpdateBrandingRequest = z.infer<typeof updateBrandingSchema>;
export type RecommendationRequest = z.infer<typeof recommendationSchema>;
