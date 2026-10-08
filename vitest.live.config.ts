import { defineConfig } from 'vitest/config';

// Opt-in lane for tests that call real, paid provider APIs. The default
// vitest.config.ts excludes `tests/live/**`, so `npx vitest run` and CI never
// collect these files. Run them on purpose with `npm run test:ai-live`; each
// provider's suite is skipped unless its key (or base URL) is in the environment.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/live/**/*.live.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // A flaky paid call is a finding, not something to paper over with a second charge.
    retry: 0,
    // One worker: requests to a provider should not race each other into a rate limit.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 1 } },
  },
});
