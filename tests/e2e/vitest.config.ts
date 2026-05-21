import { defineConfig } from 'vitest/config';

// Dedicated config for the live-process E2E suite.
//
// The root vitest.config.ts excludes `tests/e2e/**` so they don't run in
// the default `vitest run` pass — those tests require a live DarkRide
// process + Docker + the emulator image, which only the
// ci-e2e-emulator.yml workflow provides. This config re-enables them.
//
// Invoked via `npx vitest run --config tests/e2e/vitest.config.ts`.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    // No exclude of tests/e2e — that's the whole point of this config.
    // Standard node_modules / dist exclusions still apply via vitest defaults.
    // Per-test default timeout: the spawn-container + boot path can take
    // several minutes; let each `it` provide a finer-grained timeout via
    // the third-arg options where needed.
    testTimeout: 12 * 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // Sequential — these tests own a real Docker daemon + ports.
        maxForks: 1,
      },
    },
  },
});
