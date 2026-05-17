/**
 * Kitchen Sink Plugin — E2E Tests
 *
 * Verifies that the kitchen-sink plugin loads correctly, its nav item appears,
 * health checks complete (some may fail in a no-device environment), and the
 * plugin card appears on the installed-plugins settings page.
 *
 * Run: npx playwright test plugins/kitchen-sink/__tests__/e2e/kitchen-sink.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from '../../../../tests/e2e/helpers/auth';

test.describe('Kitchen Sink plugin', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  // ---------------------------------------------------------------------------
  // 1. Page loads
  // ---------------------------------------------------------------------------
  test('page loads and renders heading', async ({ page }) => {
    await page.goto('/ui/kitchen-sink');
    await page.waitForLoadState('networkidle');

    // The page title heading should be visible
    await expect(page.locator('h1', { hasText: 'Kitchen Sink Test Plugin' })).toBeVisible({
      timeout: 15_000,
    });

    // The descriptive paragraph should also be present
    await expect(
      page.locator('text=navigation, routing, and page registration are working'),
    ).toBeVisible();

    // The "Run Tests" button should be present and enabled
    await expect(page.locator('button', { hasText: 'Run Tests' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Run Tests' })).toBeEnabled();

    // The "Extension Points Exercised" section should be visible
    await expect(page.locator('text=Extension Points Exercised')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // 2. Nav item visible in sidebar
  // ---------------------------------------------------------------------------
  test('Kitchen Sink nav item is visible in the sidebar', async ({ page }) => {
    await page.goto('/ui/');
    await page.waitForLoadState('networkidle');

    // Wait for the sidebar (guaranteed by loginAsAdmin, but be explicit)
    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });

    // The nav link to the kitchen-sink page should be visible
    const navItem = sidebar.locator('a[href="/ui/kitchen-sink"]');
    await expect(navItem).toBeVisible({ timeout: 10_000 });

    // It should be labelled "Kitchen Sink"
    await expect(navItem).toContainText('Kitchen Sink');
  });

  // ---------------------------------------------------------------------------
  // 3. Health checks — click "Run Tests", verify UI responds and shows results
  // ---------------------------------------------------------------------------
  test('clicking Run Tests runs health checks and displays results', async ({ page }) => {
    await page.goto('/ui/kitchen-sink');
    await page.waitForLoadState('networkidle');

    // Ensure the button is ready
    const runBtn = page.locator('button', { hasText: 'Run Tests' });
    await expect(runBtn).toBeVisible({ timeout: 15_000 });
    await expect(runBtn).toBeEnabled();

    // Click and confirm loading state appears briefly
    await runBtn.click();

    // The button should become disabled (or show "Running...") while checks run
    await expect(
      page.locator('button', { hasText: 'Running...' }).or(runBtn.filter({ hasNot: page.locator(':enabled') })),
    ).toBeVisible({ timeout: 5_000 }).catch(() => {
      // Some environments are fast enough that we miss the transient state — that's fine
    });

    // Wait for results — the summary line (e.g. "7 passed" or "N passed … M failed") appears
    const summaryLocator = page.locator('text=/\\d+ passed/');
    await expect(summaryLocator).toBeVisible({ timeout: 30_000 });

    // At least Navigation and Frontend Routes are hardcoded as passing
    const passItems = page.locator('.border-green-800');
    await expect(passItems).not.toHaveCount(0, { timeout: 5_000 });

    // The "Navigation" check is always pass (we loaded the page)
    const navigationCheck = page.locator('div.font-medium', { hasText: 'Navigation' });
    await expect(navigationCheck).toBeVisible();

    // The "Frontend Routes" check is always pass
    const frontendRoutesCheck = page.locator('div.font-medium', { hasText: 'Frontend Routes' });
    await expect(frontendRoutesCheck).toBeVisible();

    // After completion the button should return to "Run Tests" (enabled again)
    await expect(page.locator('button', { hasText: 'Run Tests' })).toBeEnabled({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // 4. No console errors during page load
  // ---------------------------------------------------------------------------
  test('no significant console errors on page load', async ({ page }) => {
    const consoleErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore harmless noise
        if (
          text.includes('favicon') ||
          text.includes('ResizeObserver') ||
          text.includes('net::ERR_')
        ) return;
        consoleErrors.push(text);
      }
    });

    await page.goto('/ui/kitchen-sink');
    await page.waitForLoadState('networkidle');

    // Allow a moment for any deferred async errors to surface
    await page.waitForTimeout(1500);

    // Filter to only errors that indicate real problems
    const significantErrors = consoleErrors.filter(
      text =>
        text.toLowerCase().includes('uncaught') ||
        text.toLowerCase().includes('unhandled') ||
        text.toLowerCase().includes('scope') ||
        text.includes('403') ||
        text.toLowerCase().includes('forbidden'),
    );

    expect(
      significantErrors,
      `Unexpected console errors on /ui/kitchen-sink:\n${significantErrors.join('\n')}`,
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 5. Plugin appears in installed-plugins list on settings page
  // ---------------------------------------------------------------------------
  test('kitchen-sink plugin card appears in installed plugins', async ({ page }) => {
    await page.goto('/ui/settings/plugins');
    await page.waitForLoadState('networkidle');

    // Wait for the plugin list to finish loading
    await expect(
      page.locator('.plugin-card, .plugin-empty').first(),
    ).toBeVisible({ timeout: 15_000 });

    // There should be at least one plugin card
    const cards = page.locator('.plugin-card');
    await expect(cards).not.toHaveCount(0, { timeout: 5_000 });

    // Find the kitchen-sink card specifically
    const kitchenSinkCard = page.locator('.plugin-card').filter({
      has: page.locator('.plugin-card-title h3', { hasText: 'kitchen-sink' }),
    });

    await expect(kitchenSinkCard).toBeVisible({ timeout: 10_000 });

    // The card should show the plugin badge
    await expect(kitchenSinkCard.locator('.plugin-card-badge')).toBeVisible();

    // The card should have an enable/disable toggle
    await expect(
      kitchenSinkCard.locator('button', { hasText: /Enabled|Disabled/ }),
    ).toBeVisible();
  });
});
