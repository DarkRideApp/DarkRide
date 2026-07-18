/**
 * Traffic list perf + jump-to-live banner — E2E
 *
 * Two behaviors that only exist in the real browser (layout-driven
 * virtualization) or across the WS + pagination path:
 *
 *   1. Virtualized list — with many rows on page 0 (via live prepends, since
 *      the global page fetches 50 at a time), the DOM row count stays bounded
 *      to the viewport rather than growing with the list.
 *   2. Jump-to-live banner — a live entry captured while the user is paged away
 *      from page 0 is surfaced by a banner (not dropped), and one click returns
 *      to the live head.
 *
 * Seeds rows via POST /v1/traffic/ingest (the endpoint mitmproxy hooks call),
 * which also broadcasts a live `traffic-entry` to any open Traffic page.
 *
 * Run: npx playwright test tests/e2e/traffic-list-perf.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

async function getCsrfToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = document.cookie.match(/darkride_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  });
}

async function ingest(page: Page, csrfToken: string, url: string, status = 200): Promise<void> {
  const res = await page.request.post('/v1/traffic/ingest', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: {
      request: { method: 'GET', url, headers: { accept: '*/*' }, body: null },
      response: { status, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    },
  });
  expect(res.ok()).toBe(true);
}

test.describe('Traffic page — list perf + live banner', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('virtualized list keeps the DOM row count bounded under load', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    const csrfToken = await getCsrfToken(page);

    // Seed a few rows first so the table mounts (an empty DB shows the empty
    // state, not the table).
    const run = `perf-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await ingest(page, csrfToken, `https://api.${run}.test/seed/${i}`);
    }

    await page.goto('/ui/traffic');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });

    // Ingest well past the 50-row page size while the page is open, so they
    // arrive as live prepends and push page 0 over the virtualization threshold.
    const N = 70;
    for (let i = 0; i < N; i++) {
      await ingest(page, csrfToken, `https://api.${run}.test/r/${i}`);
    }

    // The bottom spacer only exists on the virtualized path — its presence
    // proves the list crossed the threshold and is windowing.
    await expect(page.getByTestId('traffic-vspacer-bottom')).toBeAttached({ timeout: 15_000 });

    // Windowed: far fewer <tr> rows are in the DOM than exist in the list.
    const rendered = await page.getByTestId(/^traffic-row-\d+$/).count();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(N);
  });

  test('jump-to-live banner recovers entries captured while paged away', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    const csrfToken = await getCsrfToken(page);

    // Seed enough rows that total > 50 so pagination (Next) is active.
    const run = `banner-${Date.now()}`;
    for (let i = 0; i < 55; i++) {
      await ingest(page, csrfToken, `https://api.${run}.test/s/${i}`);
    }

    await page.goto('/ui/traffic');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });

    // Page away from the live head.
    await page.getByRole('button', { name: /^next$/i }).click();
    await expect(page.getByText(/page 2 of/i)).toBeVisible();

    // A live capture arrives while paged away — must surface in the banner,
    // not silently vanish.
    await ingest(page, csrfToken, `https://api.${run}.test/live-1`);
    const banner = page.getByTestId('traffic-live-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(/new request/i);

    // One click returns to the live head and clears the banner.
    await page.getByTestId('traffic-back-to-live').click();
    await expect(banner).toBeHidden();
    await expect(page.getByText(/page 1 of/i)).toBeVisible();
  });
});
