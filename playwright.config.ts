import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// Temp DB location for e2e tests — isolated from real data
const TEST_DB = path.join('/tmp', `darkride-e2e-${process.pid}.db`);

export default defineConfig({
  testDir: '.',
  testMatch: [
    'tests/e2e/**/*.spec.ts',
    'plugins/*/__tests__/e2e/**/*.spec.ts',
  ],
  fullyParallel: false,
  workers: 1, // Sequential — tests share server state (plugin enable/disable, auth)
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.PLAYWRIGHT_NO_GLOBAL_SERVER ? undefined : {
    command: `DATABASE_PATH=${TEST_DB} DARKRIDE_BOOTSTRAP_ADMIN_USERNAME=e2e-admin DARKRIDE_BOOTSTRAP_ADMIN_PASSWORD=e2e-test-password-123 PORT=3199 npx concurrently "tsx watch backend/index.ts" "npx vite --port 5199"`,
    url: 'http://localhost:5199/ui/',
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      DATABASE_PATH: TEST_DB,
      DARKRIDE_BOOTSTRAP_ADMIN_USERNAME: 'e2e-admin',
      DARKRIDE_BOOTSTRAP_ADMIN_PASSWORD: 'e2e-test-password-123',
      PORT: '3199',
      // The E2E Vite server runs on 5199, but the WS origin allowlist only
      // auto-includes the backend port + the standard Vite port 5173
      // (backend/websocket/origin-check.ts). Without this, every WS-dependent
      // spec hangs on "Connecting to server..." and times out (403 on the WS
      // upgrade). Allow the E2E dev origin explicitly.
      WEBSOCKET_ALLOWED_ORIGINS: 'http://localhost:5199',
    },
  },
});
