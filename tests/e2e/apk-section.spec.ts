/**
 * APK section redesign — E2E flows
 *
 * Covers the rebuilt App Library + App Detail pages, the activity panel,
 * the upload flow, and the reworked analysis header. The E2E harness starts
 * with a fresh temp DB containing no APK fixtures, so tests that need analyzed
 * APKs self-skip with a documented reason rather than failing.
 *
 * Auth: loginAsAdmin() (UI) / apiLogin() (API) — same pattern as
 * apk-availability.spec.ts. Selectors use data-testid.
 *
 * Run: npx playwright test tests/e2e/apk-section.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('APK section redesign', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
  });

  test('library renders with toolbar and legacy ?tab params redirect', async ({ page }) => {
    await page.goto('/ui/apks');
    await expect(page.locator('[data-testid="app-library"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="activity-chip"]')).toBeVisible();
    // Either the populated toolbar Add button or the empty-state Add button is present.
    await expect(
      page.locator('[data-testid="add-app-btn"], [data-testid="add-app-empty-btn"]').first(),
    ).toBeVisible();

    // Legacy deep link opens the activity panel, then the tab param is stripped.
    await page.goto('/ui/apks?tab=analysis');
    await expect(page.locator('[data-testid="activity-panel"]')).toBeVisible();
    await expect(page).not.toHaveURL(/tab=/);
    await page.locator('[data-testid="activity-panel-overlay"]').click();
    await expect(page.locator('[data-testid="activity-panel"]')).not.toBeVisible();
  });

  test('add app → row appears → detail page → untrack with confirm', async ({ page }) => {
    await page.goto('/ui/apks');
    await expect(page.locator('[data-testid="app-library"]')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="add-app-btn"], [data-testid="add-app-empty-btn"]').first().click();
    await page.locator('[data-testid="add-app-package-input"]').fill('com.e2e.fixture');
    await page.locator('[data-testid="add-app-submit-btn"]').click();

    const row = page.locator('[data-testid^="app-row-"]', { hasText: 'com.e2e.fixture' });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.click();
    await expect(page.locator('[data-testid="app-detail"]')).toBeVisible();
    await expect(page.locator('[data-testid="ps-toggle"]')).toBeVisible();

    // Untrack via the settings kebab — requires a confirmation dialog.
    await page.getByRole('button', { name: 'App settings' }).click();
    await page.locator('[data-testid="menu-item-untrack"]').click();
    await page.locator('[data-testid="confirm-dialog-confirm"]').click();

    await expect(page).toHaveURL(/\/ui\/apks/);
    await expect(page.locator('[data-testid^="app-row-"]', { hasText: 'com.e2e.fixture' })).toHaveCount(0);
  });

  test('upload modal validates file type client-side', async ({ page }) => {
    await page.goto('/ui/apks');
    await expect(page.locator('[data-testid="app-library"]')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="upload-apk-btn"], [data-testid="upload-empty-btn"]').first().click();
    await page.locator('[data-testid="upload-file-input"]').setInputFiles({
      name: 'not-an-apk.zip', mimeType: 'application/zip', buffer: Buffer.from('PK'),
    });
    await expect(page.getByText(/must be an \.apk/i)).toBeVisible();
  });

  test('upload endpoint rejects an unparseable APK end-to-end', async ({ page }) => {
    // Real APK fixtures are too heavy for the repo; assert the real endpoint's
    // parse-failure path (the file ends in .apk so it passes the client check
    // and reaches the androguard extractor, which rejects it).
    await page.goto('/ui/apks');
    await expect(page.locator('[data-testid="app-library"]')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="upload-apk-btn"], [data-testid="upload-empty-btn"]').first().click();
    await page.locator('[data-testid="upload-file-input"]').setInputFiles({
      name: 'garbage.apk', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not a zip'),
    });
    await page.locator('[data-testid="upload-submit-btn"]').click();
    await expect(page.locator('[data-testid="upload-error"]')).toBeVisible({ timeout: 30_000 });
  });

  test('activity chip opens the activity panel', async ({ page }) => {
    await page.goto('/ui/apks');
    await expect(page.locator('[data-testid="activity-chip"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="activity-chip"]').click();
    await expect(page.locator('[data-testid="activity-panel"]')).toBeVisible();
  });

  test('analysis page header has stable labels, a kebab, and no Back button', async ({ page }) => {
    // Only meaningful when an analyzed version exists; self-skip otherwise.
    await page.goto('/ui/apks');
    await expect(page.locator('[data-testid="app-library"]')).toBeVisible({ timeout: 15_000 });

    const readyRow = page.locator('[data-testid^="app-row-"]', { hasText: 'Ready' }).first();
    if ((await readyRow.count()) === 0) {
      test.skip(true, 'No analyzed APK fixture in the E2E DB — cannot reach the analysis page.');
      return;
    }
    await readyRow.click();
    await expect(page.locator('[data-testid="app-detail"]')).toBeVisible();
    await page.locator('[data-testid^="open-analysis-"]').first().click();

    await expect(page.locator('[data-testid="apk-analysis-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="ai-review-btn"]')).toHaveText('AI Review');
    await expect(page.getByRole('button', { name: 'Back to APKs' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More actions' })).toBeVisible();
  });
});
