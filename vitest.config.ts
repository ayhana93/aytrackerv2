import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'packages/*/src/**/*.{test,spec}.ts',
      'modules/*/src/**/*.{test,spec}.ts',
      'apps/api/src/**/*.{test,spec}.ts',
      'tests/unit/**/*.{test,spec}.ts',
    ],
    // Integration tests need a real database and run serially — see vitest.integration.config.ts.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      'tests/e2e/**',
      'tests/integration/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'modules/*/src/**', 'apps/api/src/**'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/index.ts', '**/types.ts'],
    },
  },
});
