/**
 * Plugins workspace E2E tests (shared e2e server)
 *
 * One page, /ui/plugins, with Installed and Discover tabs. Covers navigation,
 * the redirects from the old Marketplace and Settings > Plugins URLs, the list,
 * search, the detail drawer, enable/disable, and the source manager.
 *
 * The install -> uninstall flow runs against an isolated server in
 * plugins-install-ui.spec.ts, so nothing here writes plugin files to disk.
 *
 * Run: npx playwright test tests/e2e/plugin-management.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

const rows = (page: Page) => page.getByTestId('plugin-row');

/** Open the workspace on a tab and wait until both lists have settled. */
async function openWorkspace(page: Page, query = 'tab=installed') {
  await loginAsAdmin(page);
  await page.goto(`/ui/plugins?${query}`);
  await expect(page.getByTestId('plugins-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
}

test.describe('Plugins workspace', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test.describe('Navigation', () => {
    test('the sidebar has one Plugins entry and no separate Marketplace entry', async ({ page }) => {
      await loginAsAdmin(page);
      const sidebar = page.getByTestId('sidebar');
      await expect(sidebar.getByRole('link', { name: 'Plugins' })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Marketplace' })).toHaveCount(0);

      await sidebar.getByRole('link', { name: 'Plugins' }).click();
      await expect(page).toHaveURL(/\/ui\/plugins/);
      await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible();
    });

    const REDIRECTS: Array<[string, RegExp]> = [
      ['/ui/marketplace', /\/ui\/plugins\?tab=discover$/],
      ['/ui/settings/marketplace', /\/ui\/plugins\?tab=discover$/],
      ['/ui/settings/plugins/marketplace', /\/ui\/plugins\?tab=discover$/],
      ['/ui/settings/plugins', /\/ui\/plugins\?tab=installed$/],
      ['/ui/marketplace?q=zzz', /\/ui\/plugins\?tab=discover&q=zzz$/],
    ];
    for (const [from, to] of REDIRECTS) {
      test(`${from} redirects into the workspace`, async ({ page }) => {
        await loginAsAdmin(page);
        await page.goto(from);
        await expect(page).toHaveURL(to);
        await expect(page.getByTestId('plugins-workspace')).toBeVisible();
      });
    }

    test('Settings links out to the workspace instead of listing plugins itself', async ({ page }) => {
      await loginAsAdmin(page);
      await page.goto('/ui/settings/notifications');
      const link = page.getByRole('complementary').getByRole('link', { name: 'Manage plugins' });
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(/\/ui\/plugins/);
    });
  });

  test.describe('Installed tab', () => {
    test('lists installed plugins with an enable switch on each', async ({ page }) => {
      await openWorkspace(page);
      await expect(rows(page).first()).toBeVisible();
      await expect(page.getByRole('tab', { name: /Installed/ })).toHaveAttribute('aria-selected', 'true');
      const first = rows(page).first();
      await expect(first.getByRole('button').first()).toBeVisible();
      await expect(first.getByRole('switch')).toBeVisible();
    });

    test('search narrows the list and says when nothing matches', async ({ page }) => {
      await openWorkspace(page);
      const total = await rows(page).count();
      const target = (await rows(page).first().getAttribute('data-plugin'))!;

      const search = page.getByRole('searchbox', { name: 'Search plugins' });
      await search.fill(target);
      await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(target)}`));
      expect(await rows(page).count()).toBeLessThanOrEqual(total);
      await expect(page.locator(`[data-plugin="${target}"]`)).toBeVisible();

      await search.fill('zzzz-no-such-plugin');
      await expect(page.getByText('No plugins match "zzzz-no-such-plugin".')).toBeVisible();
      await page.getByRole('button', { name: 'Clear search' }).click();
      await expect(rows(page)).toHaveCount(total);
    });

    test('a row opens the detail drawer, and the back button closes it', async ({ page }) => {
      await openWorkspace(page);
      const name = (await rows(page).first().getAttribute('data-plugin'))!;
      await page.locator(`[data-plugin="${name}"]`).getByRole('button').first().click();

      const drawer = page.getByTestId('plugin-drawer');
      await expect(drawer).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`plugin=${encodeURIComponent(name)}`));
      await expect(drawer.getByRole('button', { name: 'Close details' })).toBeFocused();

      await page.goBack();
      await expect(drawer).toHaveCount(0);
      await expect(page).not.toHaveURL(/plugin=/);
    });

    test('a deep link opens the drawer, and Escape closes it', async ({ page }) => {
      await openWorkspace(page);
      const name = (await rows(page).first().getAttribute('data-plugin'))!;
      await page.goto(`/ui/plugins?tab=installed&plugin=${encodeURIComponent(name)}`);
      await expect(page.getByTestId('plugin-drawer')).toBeVisible({ timeout: 30_000 });

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('plugin-drawer')).toHaveCount(0);
      await expect(page).not.toHaveURL(/plugin=/);
    });

    test('a deep link to an unknown plugin says so', async ({ page }) => {
      await openWorkspace(page, 'tab=installed&plugin=no-such-plugin');
      await expect(page.getByRole('dialog', { name: 'Plugin not found' })).toBeVisible();
    });

    test('disabling and re-enabling a plugin shows the restart banner', async ({ page }) => {
      await openWorkspace(page);
      const enabled = rows(page).filter({ has: page.locator('[role="switch"][aria-checked="true"]') }).first();
      if (!(await enabled.isVisible().catch(() => false))) {
        test.skip(true, 'no enabled plugin to toggle');
        return;
      }
      const name = (await enabled.getAttribute('data-plugin'))!;
      const sw = page.locator(`[data-plugin="${name}"]`).getByRole('switch');

      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 });
      await expect(page.getByText('Server restart required')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(`[data-plugin="${name}"]`).getByTestId('plugin-status')).toContainText('Disabled');

      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
      await expect(page.getByText('Server restart required')).toBeVisible();
    });
  });

  test.describe('Discover tab', () => {
    test('renders, and Refresh answers either way without breaking the page', async ({ page }) => {
      await openWorkspace(page, 'tab=discover');
      await expect(page.getByRole('tab', { name: /Discover/ })).toHaveAttribute('aria-selected', 'true');
      // Rows, an empty marketplace, or an error with a retry: every outcome is a handled state.
      await expect(
        page.locator('[data-testid="plugin-row"], .plugins-state').first(),
      ).toBeVisible({ timeout: 15_000 });

      await page.getByRole('button', { name: 'Refresh' }).click();
      await expect(
        page.getByText(/Marketplace refreshed|Could not refresh the marketplace/),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible();
    });

    test('switching tabs keeps the search and records the tab in the URL', async ({ page }) => {
      await openWorkspace(page, 'tab=installed&q=maps');
      await page.getByRole('tab', { name: /Discover/ }).click();
      await expect(page).toHaveURL(/tab=discover/);
      await expect(page).toHaveURL(/q=maps/);
      await expect(page.getByRole('searchbox', { name: 'Search plugins' })).toHaveValue('maps');
    });
  });

  test.describe('Source manager (dialog)', () => {
    async function openSources(page: Page) {
      await openWorkspace(page, 'tab=discover');
      await page.getByRole('button', { name: 'Sources' }).click();
      await expect(page.getByText('Plugin Sources')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.source-card').first()).toBeVisible({ timeout: 15_000 });
    }

    test('shows the default source as read only', async ({ page }) => {
      await openSources(page);
      const defaultCard = page.locator('.source-card').filter({ has: page.locator('.source-default-note') }).first();
      await expect(defaultCard).toBeVisible();
      await expect(defaultCard.locator('.source-default-note')).toContainText('read only');
      await expect(defaultCard.getByRole('button', { name: 'Remove' })).toHaveCount(0);
    });

    test('adding and removing a source leaves the dialog open', async ({ page }) => {
      await openSources(page);
      await page.getByRole('button', { name: 'Add Source' }).click();
      const form = page.locator('.source-add-form');
      await expect(form).toBeVisible();
      await form.locator('input[type="text"]').first().fill('E2E Test Source');
      await form.locator('select').selectOption('git');
      await form.locator('input[type="text"]').nth(1).fill('https://github.com/test/test.git');
      await form.getByRole('button', { name: 'Save Source' }).click();

      const card = page.locator('.source-card').filter({
        has: page.locator('.source-card-title', { hasText: 'E2E Test Source' }),
      });
      await expect(card).toBeVisible({ timeout: 10_000 });
      // The old page closed the dialog after every change; it must stay open now.
      await expect(page.getByText('Plugin Sources')).toBeVisible();

      page.once('dialog', dialog => dialog.accept());
      await card.getByRole('button', { name: 'Remove' }).click();
      await expect(card).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByText('Plugin Sources')).toBeVisible();
    });
  });
});
