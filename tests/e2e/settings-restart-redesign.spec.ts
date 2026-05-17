/**
 * Settings redesign + restart UX E2E Tests
 *
 * Covers the post-redesign settings routes: legacy redirect handling,
 * sidebar rendering, and the Restart Server confirmation modal.
 *
 * Run: npx playwright test tests/e2e/settings-restart-redesign.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('Settings redesign + restart UX', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('legacy ?section= URLs redirect to nested paths', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings?section=notifications');
    await expect(page).toHaveURL(/\/ui\/settings\/notifications$/);
  });

  test('legacy /ui/settings/marketplace redirects to nested path', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/marketplace');
    await expect(page).toHaveURL(/\/ui\/settings\/plugins\/marketplace$/);
  });

  test('legacy /ui/settings/cloud redirects to cloud-storage', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/cloud');
    await expect(page).toHaveURL(/\/ui\/settings\/cloud-storage$/);
  });

  test('bare /ui/settings redirects to notifications', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings');
    await expect(page).toHaveURL(/\/ui\/settings\/notifications$/);
  });

  test('sidebar groups and items render', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/notifications');
    await expect(page.getByRole('link', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Installed' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Marketplace' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Changelog' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart Server' })).toBeVisible();
  });

  test('Restart Server button opens confirmation modal', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/notifications');
    await page.getByRole('button', { name: 'Restart Server' }).click();
    await expect(page.getByText('Restart Server?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('Cancel closes the modal without restarting', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/notifications');
    await page.getByRole('button', { name: 'Restart Server' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Restart Server?')).not.toBeVisible();
    await expect(page).toHaveURL(/\/ui\/settings\/notifications$/);
  });

  test.skip('install → banner → restart end-to-end', async () => {});
});
