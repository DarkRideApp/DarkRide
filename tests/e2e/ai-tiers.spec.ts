/**
 * AI Tiers E2E Tests
 *
 * Tests the AI tier management UI in the Integrations settings section:
 * - Seeded hardcoded tiers (High, Low) are visible
 * - User-added tiers can be created, renamed, and deleted
 * - Hardcoded tiers do not expose Rename or Delete controls
 *
 * Run: npx playwright test tests/e2e/ai-tiers.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('AI Tiers', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('seeded High and Low tiers are visible in Integrations', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings?section=integrations');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('High', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Low', { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test('add a user-added tier, rename it, then delete it', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings?section=integrations');
    await page.waitForLoadState('networkidle');

    // Wait for the tiers section to load (High tier must be visible first)
    await expect(page.getByText('High', { exact: true })).toBeVisible({ timeout: 15_000 });

    // ── Add ──
    await page.getByTestId('add-tier-btn').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByTestId('tier-name-input').fill('TestTier');
    await dialog.getByTestId('save-tier-btn').click();

    await expect(page.getByText('TestTier', { exact: true })).toBeVisible({ timeout: 10_000 });

    // ── Rename ──
    // Find the Rename button scoped to the TestTier card by using the data-testid
    // pattern `rename-tier-{id}`. Since we don't know the ID, find the button
    // whose closest tier header contains 'TestTier'.
    const testTierRow = page.locator('[data-testid^="rename-tier-"]').filter({
      // The rename button lives in the same flex row as the tier name
      // so locating the row that is near the 'TestTier' text works via ancestor
    });
    // Simpler: there should be only one Rename button (user tiers only).
    // High/Low are built-in and have no Rename button.
    await page.getByRole('button', { name: 'Rename' }).click();

    const renameDialog = page.getByRole('dialog');
    await expect(renameDialog).toBeVisible({ timeout: 5_000 });
    const input = renameDialog.getByTestId('tier-name-input');
    await input.fill('TestRenamed');
    await renameDialog.getByTestId('save-tier-btn').click();

    await expect(page.getByText('TestRenamed', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('TestTier', { exact: true })).not.toBeVisible();

    // ── Delete ──
    // Accept the browser confirm dialog before clicking Delete.
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByText('TestRenamed', { exact: true })).not.toBeVisible({ timeout: 10_000 });
  });

  test('hardcoded tiers do not expose Rename or Delete controls', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings?section=integrations');
    await page.waitForLoadState('networkidle');

    // Wait for tiers to load
    await expect(page.getByText('High', { exact: true })).toBeVisible({ timeout: 15_000 });

    // Both built-in tiers show the "(built-in)" label
    const builtInTags = page.getByText('(built-in)');
    await expect(builtInTags.first()).toBeVisible({ timeout: 5_000 });
    const numBuiltIn = await builtInTags.count();
    expect(numBuiltIn).toBeGreaterThanOrEqual(2);

    // Verify that High and Low specifically are not rename-able or deletable.
    // Scope checks to each built-in tier's header row via data-testid patterns.
    const highHeader = page.getByText('High', { exact: true }).locator('xpath=./ancestor::div[1]');
    const lowHeader = page.getByText('Low', { exact: true }).locator('xpath=./ancestor::div[1]');
    await expect(highHeader.locator('[data-testid^="rename-tier-"]')).toHaveCount(0);
    await expect(highHeader.locator('[data-testid^="delete-tier-"]')).toHaveCount(0);
    await expect(lowHeader.locator('[data-testid^="rename-tier-"]')).toHaveCount(0);
    await expect(lowHeader.locator('[data-testid^="delete-tier-"]')).toHaveCount(0);
  });
});
