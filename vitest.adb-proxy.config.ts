import { defineConfig } from 'vitest/config';

// Opt-in lane that drives the real `adb` binary at the proxy. The default vitest.config.ts excludes
// `tests/conformance/**`; run this on purpose with `npm run test:adb-proxy-conformance`.
// ADB_BINS is a comma-separated list of clients to test, for example:
//   ADB_BINS=adb,/path/to/platform-tools/adb npm run test:adb-proxy-conformance
// The lane starts private adb servers, which also scan USB: run it while your own adb server is running, or with no phone attached.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/conformance/**/*.conformance.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 0,
    pool: 'forks',
    poolOptions: { forks: { maxForks: 1 } },
  },
});
