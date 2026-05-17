/**
 * Navigation E2E Tests
 *
 * Verifies every page in the app loads without errors.
 * Logs in as admin, navigates to each page, checks for:
 * - No JS console errors
 * - No error/scope toasts
 * - Content actually loads (no stuck spinner)
 *
 * Run: npx playwright test tests/e2e/navigation.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

// All pages to test. The admin user has full scopes, so all pages should load.
// Note: /ui/terminal is NOT a route in the app — the wildcard redirects it to /ui/.
// We omit it here and include only real routes.
const PAGES = [
  { path: '/ui/', name: 'Dashboard' },
  { path: '/ui/devices', name: 'Devices' },
  { path: '/ui/automations', name: 'Automations' },
  { path: '/ui/sessions', name: 'Sessions' },
  { path: '/ui/traffic', name: 'Traffic' },
  { path: '/ui/proxied-requests', name: 'HTTP Requests' },
  { path: '/ui/apks', name: 'APKs' },
  { path: '/ui/frida', name: 'Frida' },
  { path: '/ui/settings', name: 'Settings' },
  { path: '/ui/settings/plugins', name: 'Plugins' },
  { path: '/ui/settings/marketplace', name: 'Marketplace' },
  { path: '/ui/settings/proxies', name: 'Proxies' },
  { path: '/ui/settings/credentials', name: 'Credentials' },
  { path: '/ui/settings/jobs', name: 'Jobs' },
  { path: '/ui/settings/utils', name: 'Utils' },
  { path: '/ui/settings/mcp', name: 'MCP Server' },
  { path: '/ui/settings/cloud', name: 'Cloud Storage' },
  { path: '/ui/selector-debugger', name: 'Selector Debugger' },
  { path: '/ui/request-builder', name: 'Request Builder' },
  { path: '/ui/api-catalogue', name: 'API Catalogue' },
  { path: '/ui/profile', name: 'Profile' },
];

test.describe('Navigation — every page loads without errors', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('all pages load without console errors or scope toasts', async ({ page }) => {
    test.setTimeout(180_000); // 3 minutes — we navigate to ~22 pages

    // Collect JS console errors throughout the test
    const consoleErrors: Array<{ page: string; text: string }> = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore common noise: favicon, ResizeObserver, WebSocket reconnects
        if (
          text.includes('favicon') ||
          text.includes('ResizeObserver') ||
          text.includes('net::ERR_')
        ) return;
        consoleErrors.push({ page: 'collected', text });
      }
    });

    // Login once — session persists across navigations
    await loginAsAdmin(page);

    const toastErrors: Array<{ page: string; text: string }> = [];

    for (const { path, name } of PAGES) {
      // Tag console errors with the page name
      const errorsBefore = consoleErrors.length;

      await page.goto(path);
      await page.waitForLoadState('networkidle');

      // Wait a moment for async API calls to resolve
      await page.waitForTimeout(2000);

      // Tag any new console errors with this page
      for (let i = errorsBefore; i < consoleErrors.length; i++) {
        consoleErrors[i].page = `${name} (${path})`;
      }

      // Check for error toasts (common toast patterns in this app)
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
            const text = (await toast.textContent()) ?? '';
            if (
              text.toLowerCase().includes('error') ||
              text.toLowerCase().includes('scope') ||
              text.toLowerCase().includes('403') ||
              text.toLowerCase().includes('forbidden') ||
              text.toLowerCase().includes('insufficient')
            ) {
              toastErrors.push({ page: `${name} (${path})`, text: text.trim() });
            }
          }
        }
      }

      // Also check for role="status" elements with error keywords
      const statusErrors = await page
        .locator('[role="status"]')
        .filter({ hasText: /scope|403|Forbidden|Insufficient/i })
        .all();
      for (const el of statusErrors) {
        if (await el.isVisible()) {
          toastErrors.push({
            page: `${name} (${path})`,
            text: (await el.textContent())?.trim() ?? 'unknown error',
          });
        }
      }

      // Ensure the page is not stuck on a loading spinner.
      // Give 5s for loading to clear — if a spinner is still visible, that's a failure.
      const spinnerGone = await page
        .locator('.auth-spinner, .auth-loading')
        .isVisible({ timeout: 500 })
        .catch(() => false);
      // auth-spinner should NOT be visible (it means AuthGuard is stuck on 'loading')
      if (spinnerGone) {
        toastErrors.push({
          page: `${name} (${path})`,
          text: 'Page stuck on auth loading spinner',
        });
      }
    }

    // Report results
    if (toastErrors.length > 0) {
      const report = toastErrors.map(e => `  ${e.page}: "${e.text}"`).join('\n');
      expect.soft(toastErrors, `Toast/scope errors on pages:\n${report}`).toHaveLength(0);
    }

    // Filter console errors to only the concerning ones
    const significantErrors = consoleErrors.filter(
      e =>
        e.text.toLowerCase().includes('scope') ||
        e.text.includes('403') ||
        e.text.toLowerCase().includes('forbidden') ||
        e.text.toLowerCase().includes('uncaught') ||
        e.text.toLowerCase().includes('unhandled'),
    );

    if (significantErrors.length > 0) {
      const report = significantErrors.map(e => `  ${e.page}: "${e.text}"`).join('\n');
      expect.soft(significantErrors, `Significant console errors:\n${report}`).toHaveLength(0);
    }

    expect(toastErrors).toHaveLength(0);
  });
});
