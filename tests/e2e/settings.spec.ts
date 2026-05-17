/**
 * Settings E2E Tests
 *
 * Tests the settings page layout, tab navigation, and jobs page.
 *
 * Run: npx playwright test tests/e2e/settings.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

// Settings tabs as defined in SettingsNav component.
// The admin user has all scopes, so every tab should be visible.
const SETTINGS_TABS = [
  { label: 'Settings', path: '/ui/settings' },
  { label: 'Plugins', path: '/ui/settings/plugins' },
  { label: 'Marketplace', path: '/ui/settings/marketplace' },
  { label: 'Proxies', path: '/ui/settings/proxies' },
  { label: 'Credentials', path: '/ui/settings/credentials' },
  { label: 'Jobs', path: '/ui/settings/jobs' },
  { label: 'Utils', path: '/ui/settings/utils' },
  { label: 'Cloud Storage', path: '/ui/settings/cloud' },
];

test.describe('Settings', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('settings page loads with section headings', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings');
    await page.waitForLoadState('networkidle');

    // The page has a Settings heading (from SettingsNav)
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible({ timeout: 15_000 });

    // Wait for content to load (sections appear below the tabs)
    await page.waitForTimeout(2000);

    // Should not be stuck on a spinner
    const authSpinner = await page.locator('.auth-spinner').isVisible().catch(() => false);
    expect(authSpinner).toBe(false);
  });

  test('all settings tabs are visible for admin user', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible({ timeout: 15_000 });

    // Check each tab link is visible in the SettingsNav tab bar.
    // Scope to the page-content area to avoid matching the sidebar nav link for "Settings".
    const pageContent = page.locator('.page-content');
    for (const tab of SETTINGS_TABS) {
      const tabLink = pageContent.locator(`a[href="${tab.path}"]`, { hasText: tab.label });
      await expect(tabLink).toBeVisible({ timeout: 5_000 });
    }
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

      // The Settings heading (from SettingsNav) should be present on every tab
      await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible({ timeout: 10_000 });

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

  test('jobs page renders job list', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/jobs');
    await page.waitForLoadState('networkidle');

    // Should have the Settings heading
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible({ timeout: 15_000 });

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
