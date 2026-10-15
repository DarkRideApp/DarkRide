/**
 * Settings E2E Tests
 *
 * Tests the settings page layout, tab navigation, and jobs page.
 *
 * Run: npx playwright test tests/e2e/settings.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

// Settings pages as listed in SettingsSidebar. The admin user has all scopes, so every
// link should be visible. Installing and enabling plugins lives in the Plugins
// workspace (/ui/plugins); see plugin-management.spec.ts.
const SETTINGS_TABS = [
  { label: 'Notifications', path: '/ui/settings/notifications' },
  { label: 'Integrations', path: '/ui/settings/integrations' },
  { label: 'AI', path: '/ui/settings/ai' },
  { label: 'APK Analysis', path: '/ui/settings/analysis' },
  { label: 'Cloud Storage', path: '/ui/settings/cloud-storage' },
  { label: 'Traffic', path: '/ui/settings/traffic' },
  { label: 'Proxies', path: '/ui/settings/proxies' },
  { label: 'ADB Proxy', path: '/ui/settings/adb-proxy' },
  { label: 'Credentials', path: '/ui/settings/credentials' },
  { label: 'Jobs', path: '/ui/settings/jobs' },
  { label: 'MCP Server', path: '/ui/settings/mcp' },
  { label: 'Utilities', path: '/ui/settings/utils' },
  { label: 'SDK Catalog', path: '/ui/settings/sdk-catalog' },
  { label: 'Changelog', path: '/ui/settings/changelog' },
];

const activeLink = (page: Page) => page.locator('.settings-sidebar-link.active');

test.describe('Settings', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('settings page loads on Notifications with the sidebar groups', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings');
    await page.waitForLoadState('networkidle');

    // /ui/settings redirects to the first page; the sidebar marks it active.
    await expect(page).toHaveURL(/\/ui\/settings\/notifications$/);
    await expect(activeLink(page)).toHaveText('Notifications', { timeout: 15_000 });
    for (const group of ['General', 'Plugins', 'Advanced', 'About']) {
      await expect(page.locator('.settings-sidebar-group-label', { hasText: group })).toBeVisible();
    }

    // Should not be stuck on a spinner
    const authSpinner = await page.locator('.auth-spinner').isVisible().catch(() => false);
    expect(authSpinner).toBe(false);
  });

  test('all settings pages are linked in the sidebar for admin user', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings');
    await page.waitForLoadState('networkidle');
    await expect(activeLink(page)).toBeVisible({ timeout: 15_000 });

    const sidebar = page.locator('.settings-sidebar');
    for (const tab of SETTINGS_TABS) {
      await expect(sidebar.locator(`a[href="${tab.path}"]`, { hasText: tab.label })).toBeVisible({ timeout: 5_000 });
    }
    await expect(sidebar.locator('a[href="/ui/plugins"]', { hasText: 'Manage plugins' })).toBeVisible();
  });

  test('navigate each settings tab without errors', async ({ page }) => {
    const consoleErrors: Array<{ tab: string; text: string }> = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          text.includes('favicon') ||
          text.includes('ResizeObserver') ||
          text.includes('net::ERR_')
        ) return;
        consoleErrors.push({ tab: 'pending', text });
      }
    });

    await loginAsAdmin(page);

    const toastErrors: Array<{ tab: string; text: string }> = [];

    for (const tab of SETTINGS_TABS) {
      const errorsBefore = consoleErrors.length;

      await page.goto(tab.path);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // Tag new console errors with this tab
      for (let i = errorsBefore; i < consoleErrors.length; i++) {
        consoleErrors[i].tab = tab.label;
      }

      // The sidebar marks the page we navigated to as active
      await expect(activeLink(page)).toContainText(tab.label, { timeout: 10_000 });

      // Check for error toasts
      const toastSelectors = [
        '[class*="toast"][class*="error"]',
        '[class*="toast"][class*="danger"]',
      ];
      for (const selector of toastSelectors) {
        const toasts = await page.locator(selector).all();
        for (const toast of toasts) {
          if (await toast.isVisible()) {
            const text = (await toast.textContent()) ?? '';
            if (
              text.toLowerCase().includes('scope') ||
              text.toLowerCase().includes('403') ||
              text.toLowerCase().includes('insufficient')
            ) {
              toastErrors.push({ tab: tab.label, text: text.trim() });
            }
          }
        }
      }
    }

    // Report
    if (toastErrors.length > 0) {
      const report = toastErrors.map(e => `  ${e.tab}: "${e.text}"`).join('\n');
      expect.soft(toastErrors, `Toast errors on settings tabs:\n${report}`).toHaveLength(0);
    }

    const significantErrors = consoleErrors.filter(
      e =>
        e.text.toLowerCase().includes('scope') ||
        e.text.includes('403') ||
        e.text.toLowerCase().includes('forbidden'),
    );

    if (significantErrors.length > 0) {
      const report = significantErrors.map(e => `  ${e.tab}: "${e.text}"`).join('\n');
      expect.soft(significantErrors, `Console errors on settings tabs:\n${report}`).toHaveLength(0);
    }

    expect(toastErrors).toHaveLength(0);
  });

  test('there is no License page or /v1/license endpoint: DarkRide has no paid tier', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings');
    await page.waitForLoadState('networkidle');

    // Sidebar is up (Changelog sits in the same group the License link used to).
    await expect(page.getByRole('link', { name: 'Changelog' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'License' })).toHaveCount(0);

    // The old deep link must not render a licence form.
    await page.goto('/ui/settings/license');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('DarkRide Pro')).toHaveCount(0);
    await expect(page.getByPlaceholder(/eyJ|license|jws/i)).toHaveCount(0);

    // And the REST surface is gone.
    const res = await page.request.get('/v1/license');
    expect(res.status()).toBe(404);
  });

  test('jobs page renders job list', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/jobs');
    await page.waitForLoadState('networkidle');

    // Jobs is the active sidebar page
    await expect(activeLink(page)).toHaveText('Jobs', { timeout: 15_000 });

    // Wait for the jobs content to load.
    // The Jobs page either shows a table of jobs or an empty/loading state.
    // Give it time for the WebSocket API call to resolve.
    await page.waitForTimeout(3000);

    // The page should not be stuck on auth loading
    const authLoading = await page.locator('.auth-loading').isVisible().catch(() => false);
    expect(authLoading).toBe(false);

    // There should be job content visible — either a table row or at least the page layout.
    // Jobs page uses SettingsNav + PageHeader or similar heading.
    // We just confirm that no hard error state is shown.
    const errorVisible = await page
      .locator('text=/Error|Failed to load/i')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    expect(errorVisible).toBe(false);
  });
});
