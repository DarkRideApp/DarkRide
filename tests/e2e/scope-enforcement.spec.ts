/**
 * Scope Enforcement E2E Test
 *
 * Fully self-contained: the Playwright config starts its own server with a
 * temp database and auto-bootstrapped admin user. No manual setup needed.
 *
 * Creates a limited-scope user, logs in, visits every page they SHOULD have
 * access to, and asserts no "Insufficient scope" error toasts appear.
 *
 * Run: npx playwright test tests/e2e/scope-enforcement.spec.ts
 */

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// ---- Config (must match playwright.config.ts webServer settings) ----

const API_BASE = 'http://localhost:3199';
const ADMIN_USERNAME = 'e2e-admin';
const ADMIN_PASSWORD = 'e2e-test-password-123';

// Limited scopes — enough to browse most pages but NOT everything
const LIMITED_SCOPES = [
  'core.devices:read',
  'core.automations:read',
  'core.traffic:read',
  'core.apk:read',
  'core.frida:read',
  'core.settings:read',
  'core.credentials:read',
  'core.proxies:manage',
  'core.jobs:manage',
];

// Pages this limited user SHOULD be able to visit without scope errors
const ACCESSIBLE_PAGES = [
  { path: '/ui/', name: 'Dashboard' },
  { path: '/ui/devices', name: 'Devices' },
  { path: '/ui/automations', name: 'Automations' },
  { path: '/ui/sessions', name: 'Session History' },
  { path: '/ui/traffic', name: 'Traffic' },
  { path: '/ui/proxied-requests', name: 'HTTP Requests' },
  { path: '/ui/apks', name: 'APKs' },
  { path: '/ui/frida', name: 'Frida' },
  { path: '/ui/settings', name: 'Settings' },
  { path: '/ui/settings/proxies', name: 'Proxies' },
  { path: '/ui/settings/credentials', name: 'Credentials' },
  { path: '/ui/settings/jobs', name: 'Jobs' },
  { path: '/ui/selector-debugger', name: 'Selector Debugger' },
  { path: '/ui/request-builder', name: 'Request Builder' },
  { path: '/ui/api-catalogue', name: 'API Catalogue' },
  { path: '/ui/profile', name: 'Profile' },
];

// ---- Helpers ----

async function apiLogin(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/v1/auth/login`, {
    data: {
      providerId: 'core.local',
      credentials: { username, password },
    },
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Login failed for ${username}: ${data.error}`);
  return data.csrfToken;
}

// ---- Tests ----

test.describe('Scope enforcement — limited user browsing', () => {
  const limitedPassword = 'limited-user-pw-secure-456';
  let limitedUsername: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      // Wait for the backend to be fully ready (migrations run, bootstrap complete)
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await page.request.get(`${API_BASE}/v1/auth/me`);
          const data = await res.json();
          if (data.authenticated !== undefined) { ready = true; break; }
        } catch { /* server not ready yet */ }
        await page.waitForTimeout(1000);
      }
      if (!ready) throw new Error('Backend did not become ready within 30s');

      // Login as admin (auto-bootstrapped via env vars)
      const csrfToken = await apiLogin(page.request, ADMIN_USERNAME, ADMIN_PASSWORD);

      // Create limited-scope user
      limitedUsername = `scope-test-${Date.now()}`;
      const createRes = await page.request.post(`${API_BASE}/v1/admin/users`, {
        data: { username: limitedUsername, scopes: LIMITED_SCOPES },
        headers: { 'X-CSRF-Token': csrfToken },
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(`Create user failed: ${createData.error}`);

      // Logout admin
      await page.request.post(`${API_BASE}/v1/auth/logout`, {
        headers: { 'X-CSRF-Token': csrfToken },
      });

      // Claim the limited user's account (set their password)
      const claimRes = await page.request.post(`${API_BASE}/v1/auth/claim`, {
        data: { token: createData.data.token, password: limitedPassword },
      });
      const claimData = await claimRes.json();
      if (!claimData.success) throw new Error(`Claim failed: ${claimData.error}`);

      // Logout the claimed session
      await page.request.post(`${API_BASE}/v1/auth/logout`, {
        headers: { 'X-CSRF-Token': claimData.csrfToken },
      });
    } finally {
      await ctx.close();
    }
  });

  test('no error toasts when browsing accessible pages as limited user', async ({ page }) => {
    // Collect any console errors mentioning scopes or 403
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (text.includes('403') || text.includes('scope') || text.includes('Forbidden')) {
          consoleErrors.push(text);
        }
      }
    });

    // Login as limited user via the UI
    await page.goto('/ui/');
    await page.waitForSelector('input[id="login-username"], [data-testid="login-username"], input[autocomplete="username"]', { timeout: 15_000 });

    const usernameInput = page.locator('input[autocomplete="username"]').first();
    const passwordInput = page.locator('input[type="password"]').first();
    const submitBtn = page.locator('button[type="submit"]').first();

    await usernameInput.fill(limitedUsername);
    await passwordInput.fill(limitedPassword);
    await submitBtn.click();

    // Wait for auth to complete — we should see the app (dashboard)
    await page.waitForTimeout(3000);

    // Now browse each accessible page
    const toastErrors: Array<{ page: string; text: string }> = [];

    for (const { path, name } of ACCESSIBLE_PAGES) {
      await page.goto(path);
      // Wait for API calls to settle
      await page.waitForTimeout(2500);

      // Look for any visible error toasts — check all common toast patterns
      const toastSelectors = [
        '.toast-error',
        '.toast.error',
        '[class*="toast"][class*="error"]',
        '[class*="toast"][class*="danger"]',
      ];

      for (const selector of toastSelectors) {
        const toasts = await page.locator(selector).all();
        for (const toast of toasts) {
          if (await toast.isVisible()) {
            const text = (await toast.textContent()) || '';
            if (text.toLowerCase().includes('scope') ||
                text.toLowerCase().includes('403') ||
                text.toLowerCase().includes('forbidden') ||
                text.toLowerCase().includes('insufficient')) {
              toastErrors.push({ page: `${name} (${path})`, text: text.trim() });
            }
          }
        }
      }

      // Also check for the generic error message pattern from the WS toast bridge
      const genericErrors = await page.locator('[role="status"] >> text=/scope|403|Forbidden|Insufficient/i').all();
      for (const el of genericErrors) {
        if (await el.isVisible()) {
          toastErrors.push({
            page: `${name} (${path})`,
            text: (await el.textContent())?.trim() || 'unknown error',
          });
        }
      }
    }

    // Report
    if (toastErrors.length > 0) {
      const report = toastErrors
        .map(e => `  ${e.page}:\n    "${e.text}"`)
        .join('\n');
      expect.soft(toastErrors, `Scope errors found on accessible pages:\n${report}`).toHaveLength(0);
    }
    if (consoleErrors.length > 0) {
      const report = consoleErrors.map(e => `  ${e}`).join('\n');
      expect.soft(consoleErrors, `Console 403/scope errors:\n${report}`).toHaveLength(0);
    }

    expect(toastErrors).toHaveLength(0);
  });
});
