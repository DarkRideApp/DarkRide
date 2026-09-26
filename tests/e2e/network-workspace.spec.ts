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

    // Old routes keep their query string (Traffic's Replay button links to
    // /ui/request-builder?replay=1; bookmarks use /ui/traffic?tab=saved).
    await page.goto('/ui/request-builder?replay=1');
    await expect(page).toHaveURL(/\/ui\/network\?pane=repeater&replay=1/);
    await page.goto('/ui/traffic?tab=saved');
    await expect(page).toHaveURL(/\/ui\/network\?pane=traffic&tab=saved/);
  });

  test('catalogue view switches stay in the catalogue pane', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    await page.goto('/ui/network?pane=catalogue');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('manage-groups-btn').click();
    await expect(page).toHaveURL(/pane=catalogue/);
    await expect(page).toHaveURL(/view=manage/);
    await expect(page.getByTestId('pane-catalogue')).toBeVisible();
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

  test('traffic filters survive a reload via ?filters=', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    await page.goto('/ui/network?pane=traffic');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('traffic-page')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /filters/i }).click();
    await page.locator('.traffic-status-pill.status-4xx').click();
    await expect(page).toHaveURL(/filters=/);
    await expect(page).toHaveURL(/pane=traffic/);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /filters/i }).click();
    await expect(page.locator('.traffic-status-pill.status-4xx')).toHaveClass(/active/);
  });
});

