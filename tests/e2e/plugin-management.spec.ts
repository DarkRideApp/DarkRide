/**
 * Plugin Management E2E Tests
 *
 * Tests the plugin system: installed plugins, marketplace,
 * source management, and trusted signing keys.
 *
 * Run: npx playwright test tests/e2e/plugin-management.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('Plugin management', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test.describe('Installed plugins', () => {
    test('plugins page lists installed plugins', async ({ page }) => {
      await loginAsAdmin(page);
      await page.goto('/ui/settings/plugins');
      await page.waitForLoadState('networkidle');

      // Wait for the plugin list to load (loading state clears)
      // Either we see a plugin-card or the "No plugins installed" message
      await expect(
        page.locator('.plugin-card, .plugin-empty').first(),
      ).toBeVisible({ timeout: 15_000 });

      // The page should have the "Installed Plugins" heading
      await expect(page.locator('text=Installed Plugins')).toBeVisible();

      // The "Browse Marketplace" button should be present
      await expect(page.locator('button', { hasText: 'Browse Marketplace' })).toBeVisible();
    });

    test('plugin card shows name, version, and install-source badge', async ({ page }) => {
      await loginAsAdmin(page);
      await page.goto('/ui/settings/plugins');
      await page.waitForLoadState('networkidle');

      // Wait for loading to finish
      await expect(
        page.locator('.plugin-card, .plugin-empty').first(),
      ).toBeVisible({ timeout: 15_000 });

      // If there are plugins, verify card structure
      const cards = page.locator('.plugin-card');
      const count = await cards.count();

      if (count > 0) {
        const firstCard = cards.first();

        // Should have a name (h3 inside the title area)
        await expect(firstCard.locator('.plugin-card-title h3')).toBeVisible();

        // Should have a badge (workspace, npm, etc.)
        await expect(firstCard.locator('.plugin-card-badge')).toBeVisible();

        // Should have enable/disable toggle button
        await expect(
          firstCard.locator('button', { hasText: /Enabled|Disabled/ }),
        ).toBeVisible();
      }
    });

    test('disable and re-enable a plugin shows restart banner', async ({ page }) => {
      await loginAsAdmin(page);
      await page.goto('/ui/settings/plugins');
      await page.waitForLoadState('networkidle');

      // Wait for loading to finish
      await expect(
        page.locator('.plugin-card, .plugin-empty').first(),
      ).toBeVisible({ timeout: 15_000 });

      const cards = page.locator('.plugin-card');
      const count = await cards.count();
      if (count === 0) {
        test.skip();
        return;
      }

      // Find an enabled plugin and capture its name for stable identification
      const enabledCard = page.locator('.plugin-card').filter({
        has: page.locator('button', { hasText: 'Enabled' }),
      }).first();

      const hasEnabled = await enabledCard.isVisible({ timeout: 3000 }).catch(() => false);
      if (!hasEnabled) {
        test.skip();
        return;
      }

      // Capture the plugin name so we can re-find the card after React re-renders
      const pluginName = await enabledCard.locator('.plugin-card-title h3').textContent();
      expect(pluginName).toBeTruthy();

      // Click disable
      const disableBtn = enabledCard.locator('button', { hasText: 'Enabled' });
      await disableBtn.click();

      // Wait for the API response — the "Restart to Apply Changes" button should appear
      await expect(
        page.locator('button', { hasText: 'Restart to Apply Changes' }),
      ).toBeVisible({ timeout: 10_000 });

      // Re-find the card by plugin name (the list re-rendered after the API call)
      const targetCard = page.locator('.plugin-card').filter({
        has: page.locator(`.plugin-card-title h3`, { hasText: pluginName! }),
      }).first();

      // The card should now show "Disabled"
      await expect(targetCard.locator('button', { hasText: 'Disabled' })).toBeVisible({
        timeout: 5_000,
      });

      // Re-enable the plugin
      await targetCard.locator('button', { hasText: 'Disabled' }).click();

      // Should still show restart banner (changes are pending)
      await expect(
        page.locator('button', { hasText: 'Restart to Apply Changes' }),
      ).toBeVisible({ timeout: 10_000 });
    });
  });

  test.describe('Marketplace', () => {
    test('marketplace page renders with grid layout', async ({ page }) => {
      await loginAsAdmin(page);
      await page.goto('/ui/settings/marketplace');
      await page.waitForLoadState('networkidle');

      // Should have the Plugin Marketplace heading
      await expect(page.locator('text=Plugin Marketplace')).toBeVisible({ timeout: 15_000 });

      // Should have the search input
      await expect(page.locator('.marketplace-search-input')).toBeVisible();

      // Should have Manage Sources button
      await expect(page.locator('button', { hasText: 'Manage Sources' })).toBeVisible();

      // Wait for loading to clear — either grid, empty, or error state
      await expect(
        page.locator('.marketplace-grid, .marketplace-empty, .marketplace-error').first(),
      ).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe('Source management (modal)', () => {
    test('sources modal shows default source', async ({ page }) => {
      await loginAsAdmin(page);
      await page.goto('/ui/settings/marketplace');
      await page.waitForLoadState('networkidle');

      // Open the source manager modal
      await page.locator('button', { hasText: 'Manage Sources' }).click();

      // Should have the Plugin Sources heading in the modal
      await expect(page.locator('text=Plugin Sources')).toBeVisible({ timeout: 15_000 });

      // Wait for loading to finish
      await expect(
        page.locator('.source-card, .plugin-empty').first(),
      ).toBeVisible({ timeout: 15_000 });

      // The default source should be visible
      const defaultNote = page.locator('.source-default-note');
      await expect(defaultNote).toBeVisible({ timeout: 5_000 });
      await expect(defaultNote).toContainText('cannot be removed');
    });

    test('default source has no delete button', async ({ page }) => {
      await loginAsAdmin(page);
      await page.goto('/ui/settings/marketplace');
      await page.waitForLoadState('networkidle');

      // Open the source manager modal
      await page.locator('button', { hasText: 'Manage Sources' }).click();

      // Wait for source cards
      await expect(
        page.locator('.source-card').first(),
      ).toBeVisible({ timeout: 15_000 });

      // Find the default source card (has the "cannot be removed" note)
      const defaultCard = page.locator('.source-card').filter({
        has: page.locator('.source-default-note'),
      }).first();

      await expect(defaultCard).toBeVisible();

      // Default source should NOT have a "Remove" button
      const removeBtn = defaultCard.locator('button', { hasText: 'Remove' });
      await expect(removeBtn).not.toBeVisible();
    });

    test('add and remove a custom source', async ({ page }) => {
      await loginAsAdmin(page);
      await page.goto('/ui/settings/marketplace');
      await page.waitForLoadState('networkidle');

      // Open the source manager modal
      await page.locator('button', { hasText: 'Manage Sources' }).click();

      // Wait for modal to load
      await expect(page.locator('text=Plugin Sources')).toBeVisible({ timeout: 15_000 });

      // Click "Add Source"
      const addBtn = page.locator('button', { hasText: 'Add Source' });
      await addBtn.click();

      // The add form should appear
      await expect(page.locator('.source-add-form')).toBeVisible({ timeout: 5_000 });

      // Fill the form
      const nameInput = page.locator('.source-add-form input[type="text"]').first();
      await nameInput.fill('E2E Test Source');

      // Select type = git
      const typeSelect = page.locator('.source-add-form select');
      await typeSelect.selectOption('git');

      // Fill URL
      const urlInput = page.locator('.source-add-form input[type="text"]').nth(1);
      await urlInput.fill('https://github.com/test/test.git');

      // Save
      const saveBtn = page.locator('.source-add-form button', { hasText: 'Save Source' });
      await saveBtn.click();

      // Wait for the source to appear in the list
      await expect(page.locator('.source-card-title', { hasText: 'E2E Test Source' })).toBeVisible({
        timeout: 10_000,
      });

      // Now remove it — find the card with our test source
      const testCard = page.locator('.source-card').filter({
        has: page.locator('.source-card-title', { hasText: 'E2E Test Source' }),
      });

      // Set up dialog handler BEFORE clicking Remove
      page.once('dialog', dialog => dialog.accept());

      const removeBtn = testCard.locator('button', { hasText: 'Remove' });
      await removeBtn.click();

      // The source should disappear
      await expect(
        page.locator('.source-card-title', { hasText: 'E2E Test Source' }),
      ).not.toBeVisible({ timeout: 10_000 });
    });
  });

});
