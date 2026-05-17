import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('Extensible UI primitives', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('Settings tab strip uses NavItemList and shows built-in tabs', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.nav-item-list')).toBeVisible();
    await expect(page.locator('.nav-item-list .nav-item', { hasText: 'Plugins' })).toBeVisible();
  });

  test('kitchen-sink button contribution appears in DeviceViewer overflow', async ({ page }) => {
    // Depends on kitchen-sink being loaded + a device being present.
    // Skip gracefully if no device is in the e2e DB.
    await loginAsAdmin(page);
    await page.goto('/ui/devices');
    await page.waitForLoadState('networkidle');
    const firstDeviceLink = page.locator('a[href*="/ui/devices/"]').first();
    const visible = await firstDeviceLink.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }
    await firstDeviceLink.click();
    await page.waitForLoadState('networkidle');
    await page.locator('[data-testid="dv-overflow"]').click();
    await expect(page.locator('button', { hasText: 'Kitchen Sink: Say Hello' })).toBeVisible({ timeout: 5_000 });
  });
});
