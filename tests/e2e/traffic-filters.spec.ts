/**
 * Traffic deep filter + search — E2E
 *
 * Seeds a handful of captured-traffic rows via POST /v1/traffic/ingest (the
 * same endpoint mitmproxy hooks call), then drives the real Traffic page UI:
 *   1. Open the filter panel
 *   2. Apply a content-type filter (JSON) + a status filter (4xx)
 *   3. Assert only the matching row is visible
 *   4. Save the current filter set as a named preset
 *   5. Reload the page (fresh mount — preset must come from localStorage)
 *   6. Re-apply the saved preset from the panel
 *   7. Assert the same row set reappears
 *
 * Run: npx playwright test tests/e2e/traffic-filters.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

async function getCsrfToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = document.cookie.match(/darkride_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  });
}

async function ingest(page: Page, csrfToken: string, entry: {
  method: string;
  url: string;
  status: number;
  contentType: string;
}): Promise<void> {
  const res = await page.request.post('/v1/traffic/ingest', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: {
      request: { method: entry.method, url: entry.url, headers: { accept: '*/*' }, body: null },
      response: {
        status: entry.status,
        headers: { 'content-type': entry.contentType },
        body: entry.contentType.includes('json') ? '{"ok":true}' : '<html></html>',
      },
    },
  });
  expect(res.ok()).toBe(true);
}

test.describe('Traffic page — deep filter + search', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('content-type + status filter narrows rows, and a saved preset round-trips across reload', async ({ page }) => {
    test.setTimeout(90_000);

    await loginAsAdmin(page);
    const csrfToken = await getCsrfToken(page);

    // Unique-per-run hostname so this test is robust to a shared/dirty DB
    // (other e2e specs and prior runs may have seeded unrelated traffic).
    const run = `e2e-${Date.now()}`;

    await ingest(page, csrfToken, { method: 'GET', url: `https://api.${run}.test/users`, status: 200, contentType: 'application/json' });
    await ingest(page, csrfToken, { method: 'GET', url: `https://www.${run}.test/page`, status: 200, contentType: 'text/html' });
    await ingest(page, csrfToken, { method: 'GET', url: `https://api.${run}.test/missing`, status: 404, contentType: 'application/json' });
    await ingest(page, csrfToken, { method: 'GET', url: `https://cdn.${run}.test/logo.png`, status: 200, contentType: 'image/png' });

    await page.goto('/ui/traffic');
    await page.waitForLoadState('networkidle');

    // Narrow to just this run's rows via the fast Host/URL filter so the
    // content-type/status assertions below aren't polluted by other traffic.
    await page.getByPlaceholder(/filter by host/i).fill(run);

    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('td.traffic-cell-path', { hasText: `api.${run}.test` })).toHaveCount(2);

    // Open the filter panel and apply JSON + 4xx.
    await page.getByRole('button', { name: /^filters/i }).click();
    await page.getByTestId('filter-contenttype-json').click();
    await page.getByRole('button', { name: '4xx', exact: true }).click();

    // Only the JSON + 404 row (api.<run>.test/missing) should remain.
    await expect(page.locator('.traffic-hostname', { hasText: `api.${run}.test` })).toHaveCount(1);
    await expect(page.locator('.traffic-path', { hasText: '/missing' })).toBeVisible();
    await expect(page.locator('.traffic-path', { hasText: '/users' })).not.toBeVisible();
    await expect(page.locator('.traffic-path', { hasText: '/page' })).not.toBeVisible();
    await expect(page.locator('.traffic-path', { hasText: 'logo.png' })).not.toBeVisible();

    // Active-filter chips reflect both filters.
    await expect(page.getByTestId('active-filter-chip-status-4xx')).toBeVisible();
    await expect(page.getByTestId('active-filter-chip-contenttype-json')).toBeVisible();

    // Save the current filter set as a preset.
    const presetName = `E2E JSON errors ${run}`;
    await page.getByTestId('preset-save-btn').click();
    await page.getByTestId('preset-name-input').fill(presetName);
    await page.getByTestId('preset-save-confirm').click();

    // Reload — a fresh mount must re-load presets from localStorage, and
    // filters must reset to defaults until the preset is re-applied.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder(/filter by host/i).fill(run);
    await page.getByRole('button', { name: /^filters/i }).click();

    const presetSlug = presetName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    await expect(page.getByTestId(`preset-${presetSlug}`)).toBeVisible();
    await page.getByTestId(`preset-${presetSlug}`).click();

    // Re-applying the preset reproduces the exact same filtered row set.
    await expect(page.locator('.traffic-hostname', { hasText: `api.${run}.test` })).toHaveCount(1);
    await expect(page.locator('.traffic-path', { hasText: '/missing' })).toBeVisible();
    await expect(page.locator('.traffic-path', { hasText: '/users' })).not.toBeVisible();
  });
});
