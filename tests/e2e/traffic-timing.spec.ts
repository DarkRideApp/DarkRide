/**
 * Traffic timing UX — E2E smoke test.
 *
 * Covers the per-request Duration column end to end:
 *   1. Seed timed HTTP entries via POST /v1/traffic/ingest (with durationMs +
 *      timings, exactly as the mitmproxy bridge sends them).
 *   2. Open the Traffic page (live tab) and assert the Duration column renders
 *      the formatted latency for each seeded entry.
 *   3. Click the Duration header and assert the rows sort by duration
 *      (server-side sortBy=durationMs).
 *
 * Auth: bearer session via apiLogin() for seeding; loginAsAdmin(page) for the UI.
 * The bootstrapped admin has core.traffic:manage + core.traffic:read.
 *
 * Run: npx playwright test tests/e2e/traffic-timing.spec.ts
 */

import { test, expect } from '@playwright/test';
import {
  loginAsAdmin,
  waitForBackend,
  apiLogin,
  API_BASE,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
} from './helpers/auth';

const HOST = 'timing-e2e.test';

// Distinct, unlikely-to-collide durations so we can identify our rows.
const SEED = [
  { path: 'slow', durationMs: 8000, timings: { dns: null, connect: 60, tls: 120, ttfb: 5000, download: 2820 } },
  { path: 'mid', durationMs: 850, timings: { dns: null, connect: 40, tls: 90, ttfb: 600, download: 120 } },
  { path: 'fast', durationMs: 90, timings: { dns: null, connect: null, tls: null, ttfb: 60, download: 30 } },
];

test.describe('Traffic Duration column', () => {
  let csrfToken: string;
  const idByPath: Record<string, number> = {};

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    csrfToken = await apiLogin(page.request, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Seed timed entries exactly as the mitmproxy bridge posts them.
    for (const s of SEED) {
      const res = await page.request.post(`${API_BASE}/v1/traffic/ingest`, {
        headers: { 'X-CSRF-Token': csrfToken },
        data: {
          request: { method: 'GET', url: `https://${HOST}/${s.path}`, headers: {} },
          response: { status: 200, body: '{"ok":true}' },
          durationMs: s.durationMs,
          timings: s.timings,
        },
      });
      expect(res.ok()).toBeTruthy();
    }

    // Resolve the inserted ids so UI assertions can target specific rows,
    // regardless of any other traffic present.
    const listRes = await page.request.get(`${API_BASE}/v1/traffic/list?limit=200`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    const items = (await listRes.json()).data.items as Array<{ id: number; requestUrl: string; durationMs: number | null }>;
    for (const s of SEED) {
      const match = items.find((i) => i.requestUrl === `https://${HOST}/${s.path}`);
      expect(match, `seeded entry /${s.path} should be listed`).toBeTruthy();
      expect(match!.durationMs).toBe(s.durationMs);
      idByPath[s.path] = match!.id;
    }

    // Warm the Vite dev server + app bundle once so the first real test isn't
    // hit by a cold-compile timeout on loginAsAdmin (the app statically imports
    // monaco via the automation editor, which is slow to optimise on first load).
    await page.goto('/ui/');
    await page.locator('#login-username, [data-testid="sidebar"]').first()
      .waitFor({ state: 'visible', timeout: 90_000 })
      .catch(() => { /* best-effort warmup */ });

    await ctx.close();
  });

  test('renders formatted duration cells for timed entries', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/traffic');

    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId(`traffic-duration-${idByPath.slow}`)).toHaveText('8.0s');
    await expect(page.getByTestId(`traffic-duration-${idByPath.mid}`)).toHaveText('850ms');
    await expect(page.getByTestId(`traffic-duration-${idByPath.fast}`)).toHaveText('90ms');
  });

  test('sorts by duration when the Duration header is clicked', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/traffic');

    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });
    // Ensure our rows are loaded before sorting.
    await expect(page.getByTestId(`traffic-duration-${idByPath.slow}`)).toBeVisible();

    // Click Duration header → server re-sorts by durationMs desc.
    await page.getByTestId('traffic-header-duration').click();

    // Read the rendered row order; our slow entry must precede the fast one.
    await expect
      .poll(async () => {
        const ids = await page
          .locator('[data-testid^="traffic-row-"]')
          .evaluateAll((rows) =>
            rows
              .map((r) => r.getAttribute('data-testid'))
              .filter((t): t is string => !!t && /^traffic-row-\d+$/.test(t))
              .map((t) => Number(t.replace('traffic-row-', ''))),
          );
        const slowIdx = ids.indexOf(idByPath.slow);
        const midIdx = ids.indexOf(idByPath.mid);
        const fastIdx = ids.indexOf(idByPath.fast);
        return slowIdx !== -1 && midIdx !== -1 && fastIdx !== -1 && slowIdx < midIdx && midIdx < fastIdx;
      }, { timeout: 10_000 })
      .toBe(true);
  });

  test('shows a timing waterfall in the detail panel', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/traffic');

    await expect(page.getByTestId('traffic-table')).toBeVisible({ timeout: 15_000 });
    // Open the "slow" entry (has a full breakdown).
    await page.getByTestId(`traffic-row-${idByPath.slow}`).click();

    await expect(page.getByTestId('timing-waterfall')).toBeVisible();
    await expect(page.getByTestId('timing-waterfall-total')).toHaveText('8.0s');
    await expect(page.getByTestId('timing-waterfall-bar')).toBeVisible();
    await expect(page.getByTestId('timing-seg-ttfb')).toBeVisible();
  });
});
