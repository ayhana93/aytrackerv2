import { describe, expect, it } from 'vitest';
import { EnvironmentConfigError, buildAppConfig, parseServerEnv } from './env';

/**
 * Boot-time configuration.
 *
 * The case that motivated these: copying `.env.example` to `.env.local` — the first instruction in
 * the README — produced `REDIS_URL=` and the API refused to start with "Invalid url" for a
 * setting its own comment calls optional. Nothing was wrong with the developer's machine and
 * nothing was wrong with the schema in isolation; the two disagreed about what an empty variable
 * means, and there was no test where they had to agree.
 */

/** The minimum a real deployment must supply. Everything else has a default or is optional. */
const REQUIRED = {
  DATABASE_URL: 'postgresql://aytracker:aytracker@localhost:5432/aytracker?schema=public',
  SESSION_SECRET: 'a'.repeat(64),
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:3001',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
} as const;

describe('an empty variable means unset', () => {
  it.each([
    'REDIS_URL',
    'SESSION_COOKIE_DOMAIN',
    'MARKET_GEOLOCATION_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_BUCKET',
    'ROUTING_PROVIDER_API_KEY',
    'SENTRY_DSN',
  ])('%s can be left blank', (key) => {
    expect(() => parseServerEnv({ ...REQUIRED, [key]: '' })).not.toThrow();
  });

  it('whitespace counts as blank', () => {
    // A trailing space after `=` in a hand-edited file is invisible and would otherwise fail.
    expect(() => parseServerEnv({ ...REQUIRED, REDIS_URL: '   ' })).not.toThrow();
  });

  it('a blank optional field comes back undefined, not as an empty string', () => {
    // Downstream code branches on presence. An empty string is truthy in some checks and falsy in
    // others, which is how a "configured" Redis client ends up connecting to nowhere.
    const env = parseServerEnv({ ...REQUIRED, REDIS_URL: '' });
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('a real value still parses', () => {
    const env = parseServerEnv({ ...REQUIRED, REDIS_URL: 'redis://localhost:6379' });
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('an invalid value is still rejected', () => {
    // Leniency about empty must not become leniency about wrong.
    expect(() => parseServerEnv({ ...REQUIRED, REDIS_URL: 'not-a-url' })).toThrow(
      EnvironmentConfigError,
    );
  });
});

describe('the whole example file boots', () => {
  /**
   * `.env.example` with a generated secret is what `scripts/setup.sh` writes, so it has to parse.
   * Anything less makes the documented quick start a lie.
   */
  const FROM_EXAMPLE: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    DATABASE_URL: REQUIRED.DATABASE_URL,
    REDIS_URL: '',
    APP_URL: 'http://localhost:3000',
    API_URL: 'http://localhost:3001',
    API_PORT: '3001',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    SESSION_SECRET: 'b'.repeat(64),
    SESSION_COOKIE_DOMAIN: '',
    SESSION_TTL_ADMIN_MINUTES: '720',
    SESSION_TTL_WORKER_MINUTES: '960',
    SESSION_TTL_DRIVER_MINUTES: '960',
    DEFAULT_MARKET: 'GLOBAL',
    DEFAULT_LOCALE: 'en',
    MARKET_GEOLOCATION_KEY: '',
    MARKET_GEOLOCATION_PROVIDER: 'none',
    BILLING_PROVIDER: 'noop',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PUBLISHABLE_KEY: '',
    VAT_VALIDATION_PROVIDER: 'none',
    OBJECT_STORAGE_ENDPOINT: '',
    OBJECT_STORAGE_REGION: '',
    OBJECT_STORAGE_BUCKET: '',
    OBJECT_STORAGE_ACCESS_KEY_ID: '',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
    OBJECT_STORAGE_PUBLIC_BASE_URL: '',
    ROUTING_PROVIDER: 'haversine',
    ROUTING_PROVIDER_API_KEY: '',
    LOCATION_RETENTION_DAYS: '180',
    TRIP_SUMMARY_RETENTION_DAYS: '1825',
    AUDIT_RETENTION_DAYS: '2555',
    LOG_LEVEL: 'info',
    SENTRY_DSN: '',
    RATE_LIMIT_ENABLED: 'true',
    NEXT_PUBLIC_API_URL: 'http://localhost:3001',
    NEXT_PUBLIC_APP_NAME: 'AYtracker',
  };

  it('parses without throwing', () => {
    expect(() => parseServerEnv(FROM_EXAMPLE)).not.toThrow();
  });

  it('produces a usable config', () => {
    const config = buildAppConfig(parseServerEnv(FROM_EXAMPLE));
    expect(config.isProduction).toBe(false);
    // Plain HTTP locally, so a secure-only cookie would never be sent back and login would appear
    // to succeed and then not work.
    expect(config.useSecureCookies).toBe(false);
    expect(config.sessionTtlSeconds.WORKER).toBe(960 * 60);
  });
});

describe('required settings have no defaults', () => {
  it.each(['DATABASE_URL', 'SESSION_SECRET'])('%s must be supplied', (key) => {
    const { [key]: _removed, ...rest } = REQUIRED as Record<string, string>;
    expect(() => parseServerEnv(rest)).toThrow(EnvironmentConfigError);
  });

  it('an empty required value fails too', () => {
    // The blank-means-unset rule must not turn a required setting into an optional one.
    expect(() => parseServerEnv({ ...REQUIRED, DATABASE_URL: '' })).toThrow(EnvironmentConfigError);
  });

  it('reports every problem at once', () => {
    // A deploy with three missing variables should take one round trip to fix, not three.
    let message = '';
    try {
      parseServerEnv({ APP_URL: 'http://localhost:3000' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('SESSION_SECRET');
  });
});
