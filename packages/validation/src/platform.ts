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
 * The organization's own name, changed from its settings screen.
 *
 * Only the two fields an admin has business editing. Country, billing country, currency and slug
 * are all absent on purpose: the first three drive pricing and tax and are changed by support
 * with an audit trail, and the slug is what every worker in the building types to log in — a
 * field that silently locks a whole workforce out is not a settings field.
 */
export const updateOrganizationProfileSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  legalName: z.string().trim().max(200).nullable().optional(),
});

/**
 * A logo upload.
 *
 * The bytes arrive base64-encoded in JSON rather than as multipart, which keeps the endpoint on
 * the same body parser, the same CSRF check and the same rate limiter as every other mutation.
 * The trade is a third more bytes on the wire for a file that is capped at half a megabyte.
 *
 * `contentType` is deliberately absent. The route sniffs the type from the bytes, because a
 * declared type is a claim by the caller and this asset is served back with a Content-Type
 * header — which makes trusting that claim a way to have us serve `text/html` from our own origin.
 */
export const uploadLogoSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  /** Base64, with or without a `data:` prefix — a browser's FileReader produces the latter. */
  data: z.string().min(1).max(1_400_000),
  /** Whether to show it straight away. The upload screen sets this; the gallery does not. */
  activate: z.boolean().default(true),
});

/** Which uploaded logo the organization shows. Null clears it back to the monogram. */
export const selectLogoSchema = z.object({
  logoId: uuidSchema.nullable(),
});

/**
 * A member's email address, changed by an organization admin.
 *
 * The address is the login identity, so this is an account change and not a profile edit: the
 * route restricts it to members of the caller's own organization and refuses to touch a platform
 * administrator, whose account is not the tenant's to edit.
 */
export const updateMemberEmailSchema = z.object({
  email: emailSchema,
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
