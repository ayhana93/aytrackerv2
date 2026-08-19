import { defineConfig } from 'vitest/config';

/**
 * Integration tests.
 *
 * Separate from the unit config for one reason: they share a real database. Truncating between
 * tests is what keeps them fast and independent, and that only works if exactly one file runs
 * at a time — otherwise one suite's reset wipes another's fixtures mid-test.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL) pointing at a throwaway database that has had
 * `pnpm db:migrate:deploy` run against it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.{test,spec}.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    // A real database plus Argon2 hashing in fixtures is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
