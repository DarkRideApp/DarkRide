/**
 * Network workspace — E2E
 *
 * The unified /ui/network workspace: scope bar + pane tabs, old routes
 * redirect in, single "Network" nav entry.
 *
 * Run: npx playwright test tests/e2e/network-workspace.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('Network workspace', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('workspace shell, pane switching, and old-route redirects', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);

    await page.goto('/ui/network');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('network-workspace')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('scope-bar')).toBeVisible();

    // Traffic pane is the default.
    await expect(page.getByTestId('traffic-page')).toBeVisible({ timeout: 15_000 });

    // Switch to the Repeater pane.
    await page.getByTestId('network-tab-repeater').click();
    await expect(page).toHaveURL(/pane=repeater/);
    await expect(page.getByTestId('pane-repeater')).toBeVisible();

    // Switch to Intercept.
    await page.getByTestId('network-tab-intercept').click();
    await expect(page.getByTestId('pane-intercept')).toBeVisible();

    // Old Traffic route redirects into the workspace.
    await page.goto('/ui/traffic');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/ui\/network/);
    await expect(page.getByTestId('network-workspace')).toBeVisible();

    // Old API Catalogue route redirects into the catalogue pane.
    await page.goto('/ui/api-catalogue');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/pane=catalogue/);
  });

  test('scope bar can switch to the Device scope', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    await page.goto('/ui/network');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('scope-kind-device').click();
    await expect(page.getByTestId('scope-device-select')).toBeVisible();
    await expect(page).toHaveURL(/scope=device/);
  });
});
