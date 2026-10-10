/**
 * Plugins workspace: install and uninstall through the UI, end to end.
 *
 * Add a source in the Sources dialog -> it shows up in Discover without a manual
 * refresh -> Install (with the unverified-plugin warning) -> the plugin waits for
 * a restart -> Uninstall from the drawer.
 *
 * Runs against its own backend (own DATA_ROOT and DB) and its own Vite, because
 * an install writes plugin files to disk and must not touch the shared e2e server
 * or the repo's data/ directory. plugin-lifecycle.spec.ts covers the same backend
 * behaviour through the API; this covers what the UI does with it.
 *
 * Needs network access: npm resolves the fixture plugin's peer dependencies.
 *
 * Run: npx playwright test tests/e2e/plugins-install-ui.spec.ts
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { startServer, pickPort, type TestServer } from '../../playwright/fixtures/server';
import { startVite, type TestVite } from '../../playwright/fixtures/vite';
import { buildTestPluginBundle } from '../fixtures/build-test-plugin-bundle';
import { loginAsAdmin } from './helpers/auth';

// The git source lists the fixture as registry name "test" (derived from its npm
// package), but the plugin runs as "test-plugin". The workspace has to join the
// two by npm package or the installed plugin would show up twice.
const REGISTRY_NAME = 'test';
const RUNTIME_NAME = 'test-plugin';
const DISPLAY_NAME = '@darkrideapp/plugin-test';

test.describe('Plugins workspace: install and uninstall through the UI', () => {
  test.describe.configure({ mode: 'serial' });

  let server: TestServer;
  let vite: TestVite;
  let context: BrowserContext;
  let page: Page;
  let bundlePath: string;
  // The server starts with a plugin or two already installed, so compare against this, not against 0.
  let installedBefore = 0;

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(240_000);
    bundlePath = buildTestPluginBundle();
    const vitePort = await pickPort();
    server = await startServer({ env: { WEBSOCKET_ALLOWED_ORIGINS: `http://localhost:${vitePort}` } });
    vite = await startVite({ port: vitePort, backendPort: Number(new URL(server.baseUrl).port) });
    context = await browser.newContext({ baseURL: vite.origin });
    page = await context.newPage();
    await loginAsAdmin(page);
  });

  test.afterAll(async () => {
    await context?.close();
    await vite?.stop();
    await server?.stop();
  });

  const workspaceSettled = () =>
    expect(page.getByTestId('plugins-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });

  /** The number on the Installed tab. */
  const installedCount = async () => {
    const text = (await page.getByRole('tab', { name: /Installed/ }).textContent()) ?? '';
    return Number(/(\d+)/.exec(text)?.[1] ?? NaN);
  };

  test('a source added in the dialog appears in Discover without pressing Refresh', async () => {
    await page.goto('/ui/plugins?tab=discover');
    await workspaceSettled();
    installedBefore = await installedCount();
    expect(installedBefore).not.toBeNaN();

    await page.getByRole('button', { name: 'Sources' }).click();
    await expect(page.getByText('Plugin Sources')).toBeVisible();
    await page.getByRole('button', { name: 'Add Source' }).click();
    const form = page.locator('.source-add-form');
    await form.locator('input[type="text"]').first().fill('Fixture plugin');
    await form.locator('select').selectOption('git');
    await form.locator('input[type="text"]').nth(1).fill(`file://${bundlePath}`);
    await form.getByRole('button', { name: 'Save Source' }).click();
    await expect(page.locator('.source-card-title', { hasText: 'Fixture plugin' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close' }).click();

    const row = page.locator(`[data-plugin="${REGISTRY_NAME}"]`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByRole('button', { name: DISPLAY_NAME })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Install' })).toBeEnabled();
  });

  test('installing asks about the unverified plugin, then waits for a restart', async () => {
    const row = page.locator(`[data-plugin="${REGISTRY_NAME}"]`);
    await row.getByRole('button', { name: 'Install' }).click();

    await expect(page.getByText(`Install unverified "${DISPLAY_NAME}"?`)).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();

    // The progress dialog reaches "done" and offers OK; a failure would offer Close instead.
    await expect(page.getByText(`Installing "${REGISTRY_NAME}"`)).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click({ timeout: 150_000 });
    await expect(page.getByText(/installed\. Restart to activate\./)).toBeVisible();
    await expect(page.getByText('Server restart required')).toBeVisible();
  });

  test('the installed plugin is one row, joined to its marketplace entry', async () => {
    // Registry name "test", runtime name "test-plugin": joined by npm package, not name.
    await expect(page.locator(`[data-plugin="${RUNTIME_NAME}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-plugin="${REGISTRY_NAME}"]`)).toHaveCount(0);
    const row = page.locator(`[data-plugin="${RUNTIME_NAME}"]`);
    await expect(row.getByTestId('plugin-status')).toContainText('Restart to activate');

    await page.getByRole('tab', { name: /Installed/ }).click();
    await expect(page.locator(`[data-plugin="${RUNTIME_NAME}"]`)).toBeVisible();
    await expect.poll(installedCount).toBe(installedBefore + 1);
  });

  test('the drawer says where the plugin came from', async () => {
    await page.locator(`[data-plugin="${RUNTIME_NAME}"]`).getByRole('button', { name: DISPLAY_NAME }).click();
    const drawer = page.getByTestId('plugin-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Marketplace', { exact: true })).toBeVisible();
    await expect(drawer.getByText(DISPLAY_NAME, { exact: true }).last()).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Uninstall' })).toBeVisible();
  });

  test('uninstalling from the drawer closes it and removes the plugin from Installed', async () => {
    const drawer = page.getByTestId('plugin-drawer');
    await drawer.getByRole('button', { name: 'Uninstall' }).click();
    await expect(page.getByText(`Uninstall "${RUNTIME_NAME}"?`)).toBeVisible();
    await page.getByTestId('uninstall-keep-data').click();

    await expect(page.getByText(/uninstalled \(data kept\)/)).toBeVisible({ timeout: 60_000 });
    await expect(drawer).toHaveCount(0);
    await expect(page).not.toHaveURL(/plugin=/);
    // Stays on Installed instead of jumping to Discover, and the plugin is gone from it.
    await expect(page.getByRole('tab', { name: /Installed/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`[data-plugin="${RUNTIME_NAME}"]`)).toHaveCount(0);
    await expect.poll(installedCount).toBe(installedBefore);

    await page.getByRole('tab', { name: /Discover/ }).click();
    const row = page.locator(`[data-plugin="${REGISTRY_NAME}"]`);
    await expect(row.getByRole('button', { name: 'Install' })).toBeVisible();
  });
});
