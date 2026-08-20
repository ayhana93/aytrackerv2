import { z } from 'zod';

/**
 * Environment parsing.
 *
 * One schema, parsed once at boot. A misconfigured deploy fails immediately with a list of what
 * is wrong, instead of throwing a confusing error three hours later when someone first hits the
 * billing page. Anything with a security consequence has no default.
 */

const nonEmpty = z.string().trim().min(1);

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean),
);

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: nonEmpty.url(),
    REDIS_URL: nonEmpty.url().optional(),

    APP_URL: nonEmpty.url(),
    API_URL: nonEmpty.url(),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    CORS_ALLOWED_ORIGINS: csv.default('http://localhost:3000'),

    // 32 bytes of entropy minimum. Rejected rather than padded — a short secret is a real risk.
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    SESSION_COOKIE_DOMAIN: z.string().optional(),
    SESSION_TTL_ADMIN_MINUTES: z.coerce.number().int().positive().default(720),
    SESSION_TTL_WORKER_MINUTES: z.coerce.number().int().positive().default(960),
    SESSION_TTL_DRIVER_MINUTES: z.coerce.number().int().positive().default(960),

    DEFAULT_MARKET: nonEmpty.default('GLOBAL'),
    DEFAULT_LOCALE: nonEmpty.default('en'),
    MARKET_GEOLOCATION_PROVIDER: z.enum(['none', 'cloudflare', 'maxmind']).default('none'),
    MARKET_GEOLOCATION_KEY: z.string().optional(),

    BILLING_PROVIDER: z.enum(['noop', 'stripe']).default('noop'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    VAT_VALIDATION_PROVIDER: z.enum(['none', 'vies']).default('none'),

    OBJECT_STORAGE_ENDPOINT: z.string().optional(),
    OBJECT_STORAGE_REGION: z.string().optional(),
    OBJECT_STORAGE_BUCKET: z.string().optional(),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().optional(),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    OBJECT_STORAGE_PUBLIC_BASE_URL: z.string().optional(),

    ROUTING_PROVIDER: z.enum(['haversine', 'mapbox', 'google']).default('haversine'),
    ROUTING_PROVIDER_API_KEY: z.string().optional(),
    LOCATION_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
    TRIP_SUMMARY_RETENTION_DAYS: z.coerce.number().int().positive().default(1825),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(2555),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SENTRY_DSN: z.string().optional(),
    RATE_LIMIT_ENABLED: booleanish.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.BILLING_PROVIDER === 'stripe') {
      if (!env.STRIPE_SECRET_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_SECRET_KEY'],
          message: 'Required when BILLING_PROVIDER=stripe',
        });
      }
      if (!env.STRIPE_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_WEBHOOK_SECRET'],
          message: 'Required when BILLING_PROVIDER=stripe',
        });
      }
    }
    if (env.ROUTING_PROVIDER !== 'haversine' && !env.ROUTING_PROVIDER_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ROUTING_PROVIDER_API_KEY'],
        message: `Required when ROUTING_PROVIDER=${env.ROUTING_PROVIDER}`,
      });
    }
    if (env.MARKET_GEOLOCATION_PROVIDER === 'maxmind' && !env.MARKET_GEOLOCATION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MARKET_GEOLOCATION_KEY'],
        message: 'Required when MARKET_GEOLOCATION_PROVIDER=maxmind',
      });
    }
    // In production, cookies must be sent over HTTPS only. Catch the misconfiguration at boot.
    if (env.NODE_ENV === 'production' && !env.APP_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_URL'],
        message: 'APP_URL must use https in production',
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvironmentConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvironmentConfigError';
  }
}

/**
 * An empty variable means "not set".
 *
 * `.env.example` lists every optional setting with an empty value, so a developer can see what
 * exists without hunting through the schema. Copying that file — which is exactly what the setup
 * instructions say to do — then produced `REDIS_URL=` and boot failed with "Invalid url" for a
 * setting documented as optional. Every deployment platform behaves the same way: an env var
 * cleared in a dashboard arrives as `''`, not absent.
 *
 * So an empty or whitespace-only value is dropped before validation and the field's own
 * `.optional()` or `.default()` decides what happens. A *required* field left empty still fails,
 * and now fails with "Required" rather than a misleading format complaint.
 */
function withoutEmptyValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function parseServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(withoutEmptyValues(source));
  if (!result.success) {
    throw new EnvironmentConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/**
 * Derived settings the rest of the app reads instead of poking at env directly.
 */
export interface AppConfig {
  readonly env: ServerEnv;
  readonly isProduction: boolean;
  readonly isTest: boolean;
  /** Secure cookies everywhere except plain-HTTP local development. */
  readonly useSecureCookies: boolean;
  readonly sessionTtlSeconds: { USER: number; WORKER: number; DRIVER: number };
}

export function buildAppConfig(env: ServerEnv): AppConfig {
  return {
    env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    useSecureCookies: env.APP_URL.startsWith('https://'),
    sessionTtlSeconds: {
      USER: env.SESSION_TTL_ADMIN_MINUTES * 60,
      WORKER: env.SESSION_TTL_WORKER_MINUTES * 60,
      DRIVER: env.SESSION_TTL_DRIVER_MINUTES * 60,
    },
  };
}
