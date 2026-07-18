/**
 * Traffic P3 polish — E2E
 *
 * Covers the three P3 items with real runtime surface:
 *   1. Save a captured request from the detail panel, then find it under the
 *      Saved tab (exercises POST /v1/traffic/saved).
 *   2. Block a host, see it in the Blocked panel, unblock it.
 *   3. Hide the Size column via the Columns menu; it stays hidden across reload
 *      (localStorage persistence).
 *
 * Run: npx playwright test tests/e2e/traffic-p3.spec.ts
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

test.describe('Traffic page — P3 polish', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('save a request, then see it under the Saved tab', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    const csrfToken = await getCsrfToken(page);
    const run = `save-${Date.now()}`;
    const path = `/users/${run}`;
    await ingest(page, csrfToken, `https://api.${run}.test${path}`);

    await page.goto('/ui/traffic');
    await page.waitForLoadState('networkidle');
    await page.getByPlaceholder(/filter by host/i).fill(run);
    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });

    await page.locator('.traffic-hostname', { hasText: `api.${run}.test` }).first().click();
    await page.getByRole('button', { name: /^save$/i }).click();

    // Switch to the Saved tab (first "Saved" button in DOM is the tab; the
    // detail panel's Save action briefly relabels to "Saved" after the click).
    await page.getByRole('button', { name: /^saved$/i }).first().click();
    await expect(page.locator('.traffic-hostname', { hasText: `api.${run}.test` })).toBeVisible({ timeout: 15_000 });
  });

  test('block a host, see it in the Blocked panel, then unblock it', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    const csrfToken = await getCsrfToken(page);
    const run = `block-${Date.now()}`;
    const host = `api.${run}.test`;
    await ingest(page, csrfToken, `https://${host}/x`);

    await page.goto('/ui/traffic');
    await page.waitForLoadState('networkidle');
    await page.getByPlaceholder(/filter by host/i).fill(run);
    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });

    await page.locator('.traffic-hostname', { hasText: host }).first().click();
    await page.getByRole('button', { name: new RegExp(`block ${host}`, 'i') }).click();

    await page.getByTestId('traffic-blocked-btn').click();
    const panel = page.getByTestId('blocklist-panel');
    await expect(panel.getByText(host)).toBeVisible({ timeout: 15_000 });

    await panel.getByRole('button', { name: new RegExp(`unblock ${host}`, 'i') }).click();
    await expect(panel.getByText(host)).toBeHidden();
  });

  test('hiding the Size column persists across reload', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    const csrfToken = await getCsrfToken(page);
    const run = `cols-${Date.now()}`;
    await ingest(page, csrfToken, `https://api.${run}.test/x`);

    await page.goto('/ui/traffic');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('columnheader', { name: /size/i })).toBeVisible();

    await page.getByTestId('traffic-columns-btn').click();
    await page.getByTestId('traffic-column-toggle-size').click();
    await expect(page.getByRole('columnheader', { name: /size/i })).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('columnheader', { name: /size/i })).toHaveCount(0);
  });
});
