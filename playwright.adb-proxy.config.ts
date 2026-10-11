import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// End-to-end config for the ADB proxy. It reuses the default e2e ports and helpers, so never run it
// at the same time as playwright.config.ts. A fake ADB server stands in for the host's ADB server:
// the backend finds its device through the real `adb` CLI because ANDROID_ADB_SERVER_PORT points at it.
const TEST_DB = path.join('/tmp', `darkride-e2e-adb-proxy-${process.pid}.db`);
const FAKE_ADB_PORT = '15299';

export default defineConfig({
  testDir: '.',
  testMatch: ['tests/e2e-adb-proxy/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx tests/e2e-adb-proxy/fake-adb-main.ts',
      port: Number(FAKE_ADB_PORT),
      timeout: 60_000,
      reuseExistingServer: false,
      env: { FAKE_ADB_PORT },
    },
    {
      command: 'npx concurrently "tsx watch backend/index.ts" "npx vite --port 5199"',
      url: 'http://localhost:5199/ui/',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        DATABASE_PATH: TEST_DB,
        DARKRIDE_BOOTSTRAP_ADMIN_USERNAME: 'e2e-admin',
        DARKRIDE_BOOTSTRAP_ADMIN_PASSWORD: 'e2e-test-password-123',
        PORT: '3199',
        WEBSOCKET_ALLOWED_ORIGINS: 'http://localhost:5199',
        // Pin every adb setting (adb prefers ADB_SERVER_SOCKET, the backend reads the address) so the developer's shell cannot redirect it.
        ANDROID_ADB_SERVER_ADDRESS: '127.0.0.1',
        ANDROID_ADB_SERVER_PORT: FAKE_ADB_PORT,
        ADB_SERVER_SOCKET: `tcp:127.0.0.1:${FAKE_ADB_PORT}`,
      },
    },
  ],
});
