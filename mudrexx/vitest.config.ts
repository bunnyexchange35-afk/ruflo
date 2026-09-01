import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Tests run inside the real Workers runtime (workerd) with a real D1 binding,
 * so routing, middleware, SQL and the session/device engine are all exercised
 * exactly as they behave in production.
 */
export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    poolOptions: {
      workers: {
        // Storage is reset explicitly per test (see `freshDatabase`) because
        // with isolatedStorage enabled, `beforeEach` writes can be discarded
        // before the test body runs.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'test',
            RECOVERY_SECRET: 'test-recovery-secret-not-a-backdoor',
            RECOVERY_ROTATION_ID: 'rot-1',
          },
        },
      },
    },
  },
});
