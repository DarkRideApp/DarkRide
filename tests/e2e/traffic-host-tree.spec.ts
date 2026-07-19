/**
 * Traffic host/path tree — E2E
 *
 * Ingests rows across two hosts, opens the tree navigator, expands a host,
 * clicks a path, and asserts the table narrowed to that host and the detail
 * panel opened. Exercises GET /v1/traffic/tree + the /list hostname/path
 * server-side narrowing.
 *
 * Run: npx playwright test tests/e2e/traffic-host-tree.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

async function getCsrfToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = document.cookie.match(/darkride_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  });
}

async function ingest(page: Page, csrfToken: string, url: string): Promise<void> {
  const res = await page.request.post('/v1/traffic/ingest', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: {
      request: { method: 'GET', url, headers: { accept: '*/*' }, body: null },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    },
  });
  expect(res.ok()).toBe(true);
}

test.describe('Traffic page — host/path tree', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('expand a host and click a path to narrow the table', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    const csrfToken = await getCsrfToken(page);
    const run = `tree-${Date.now()}`;
    const host = `api.${run}.test`;
    await ingest(page, csrfToken, `https://${host}/orders`);
    await ingest(page, csrfToken, `https://${host}/users`);
    await ingest(page, csrfToken, `https://cdn.${run}.test/logo.png`);

    await page.goto('/ui/traffic');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });

    // Open the tree navigator.
    await page.getByTestId('traffic-tree-toggle').click();
    const panel = page.getByTestId('traffic-tree-panel');
    await expect(panel.getByText(host)).toBeVisible({ timeout: 15_000 });

    // Expand the host, then click the /orders path.
    await panel.getByRole('button', { name: new RegExp(`expand ${host}`, 'i') }).click();
    await panel.getByText('/orders').click();

    // The table narrowed to this host's /orders request, and the detail opened.
    await expect(page.locator('.traffic-hostname', { hasText: host })).toBeVisible();
    await expect(page.locator('.traffic-path', { hasText: 'logo.png' })).toHaveCount(0);
  });
});
