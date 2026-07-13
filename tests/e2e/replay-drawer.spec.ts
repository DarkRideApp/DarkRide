/**
 * In-place Repeater drawer — E2E
 *
 * Seeds a captured-traffic row via POST /v1/traffic/ingest (the same endpoint
 * the mitmproxy bridge calls), then drives the real Traffic page:
 *   1. Select the seeded row and open the Repeater drawer (in place — no navigation)
 *   2. Assert the editor is pre-filled from the captured request
 *   3. Edit a request header
 *   4. Send via Direct (the seeded row has no live device, so Direct is the default)
 *   5. Assert the response renders BESIDE the captured original with a diff:
 *      status changed (404 -> 200), a body diff, and the routing surfaced
 *
 * The replay egresses for real through the backend. The server enforces an SSRF
 * guard that blocks loopback/private targets, so the replay hits a stable public
 * host (example.com) rather than a local echo server.
 *
 * Run: npx playwright test tests/e2e/replay-drawer.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

async function getCsrfToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = document.cookie.match(/darkride_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  });
}

test.describe('Traffic page — in-place Repeater drawer', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('opens the drawer, edits a header, replays, and renders the original-vs-new diff', async ({ page }) => {
    test.setTimeout(90_000);

    await loginAsAdmin(page);
    const csrfToken = await getCsrfToken(page);

    // Unique-per-run marker so this is robust to a shared/dirty DB.
    const marker = `e2e-${Date.now()}`;
    const url = `https://example.com/?${marker}`;

    // Seed a captured entry whose recorded response is a 404 with a distinctive
    // body — so replaying to the live example.com (200 + real HTML) produces a
    // visible status + body diff.
    const ingest = await page.request.post('/v1/traffic/ingest', {
      headers: { 'X-CSRF-Token': csrfToken },
      data: {
        request: {
          method: 'GET',
          url,
          headers: { 'X-Replay-Probe': 'original' },
          body: null,
        },
        response: {
          status: 404,
          headers: { 'content-type': 'text/html' },
          body: '<p>captured-old-body</p>',
        },
      },
    });
    expect(ingest.ok()).toBe(true);

    await page.goto('/ui/traffic');
    await expect(page.getByTestId('traffic-page')).toBeVisible();

    // Find and select the seeded row (matched by its unique query marker).
    const row = page.locator('tr', { hasText: marker }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    // Open the Repeater via the subheader action (appears once a row is selected).
    await page.getByRole('button', { name: 'Repeat Request' }).click();

    const drawer = page.getByTestId('replay-drawer');
    await expect(drawer).toBeVisible();

    // Editor pre-filled from the captured request.
    await expect(page.getByTestId('replay-url')).toHaveValue(url);
    await expect(page.getByTestId('replay-header-key-0')).toHaveValue('X-Replay-Probe');

    // Edit a header value.
    await page.getByTestId('replay-header-value-0').fill('edited-by-e2e');

    // Device isn't capturing → default egress is Direct.
    await expect(page.getByTestId('replay-send-via')).toHaveValue('direct');

    // Fire the replay.
    await page.getByTestId('replay-send').click();

    // Response renders beside the captured original.
    const newStatus = page.getByTestId('replay-new-status');
    await expect(newStatus).toBeVisible({ timeout: 30_000 });

    // Status diff: captured 404 -> live 200, flagged as changed.
    await expect(page.getByTestId('replay-orig-status')).toHaveText('404');
    await expect(newStatus).toHaveText('200');
    await expect(page.getByTestId('replay-status-diff')).toHaveText('changed');

    // Body diff rendered with at least one add and one remove line.
    const bodyDiff = page.getByTestId('replay-body-diff');
    await expect(bodyDiff.locator('.replay-diff-add').first()).toBeVisible();
    await expect(bodyDiff.locator('.replay-diff-remove').first()).toBeVisible();

    // Routing is surfaced.
    await expect(page.getByTestId('replay-routed-via')).toContainText('direct');

    // Closing the drawer returns to the table without navigating away.
    await page.getByTestId('replay-drawer-close').click();
    await expect(drawer).toBeHidden();
    await expect(page.getByTestId('traffic-page')).toBeVisible();
  });
});
