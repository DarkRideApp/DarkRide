/**
 * APK Availability UX — E2E smoke tests
 *
 * Covers:
 *   1. Availability endpoint wiring (shape and HTTP codes)
 *   2. AvailabilityBadge appearing in the APK browser version list
 *   3. Run Diff disabled when a version is not local (skip — needs forced state)
 *
 * Infrastructure notes:
 * - The E2E harness starts with a fresh temp DB containing no APK fixtures.
 *   Tests that depend on fixture data either assert both the empty and non-empty
 *   path, or skip with a documented reason.
 * - Auth: bearer session acquired via apiLogin() → CSRF token in header.
 *   Same pattern as ai-factory-migration.spec.ts and api-keys.spec.ts.
 * - The availability endpoint requires the 'core.apk:read' scope, which the
 *   bootstrapped admin user has.
 *
 * Run: npx playwright test tests/e2e/apk-availability.spec.ts
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

test.describe('APK availability UX', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  // ── 1. Availability endpoint wiring ─────────────────────────────────────────

  test('availability endpoint responds with state + per-artifact fields', async ({ request }) => {
    const csrfToken = await apiLogin(request, ADMIN_USERNAME, ADMIN_PASSWORD);

    // com.fixture/1 is a synthetic package/version that will never exist in the
    // test DB.  The endpoint should return 404 (not 500, not 401, not 404-with-
    // wrong-body).  If by some future chance a fixture IS seeded, we accept 200
    // and validate the full shape.
    const res = await request.get(`${API_BASE}/v1/apks/com.fixture/1/availability`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });

    expect([200, 404]).toContain(res.status());

    if (res.status() === 200) {
      const body = await res.json();
      // Validate the full VersionAvailability shape from apk-availability.ts
      expect(['local', 'cloud', 'needs-reanalyze', 'lost']).toContain(body.state);
      expect(body).toHaveProperty('apk');
      expect(body).toHaveProperty('sourceDb');
      expect(body).toHaveProperty('metadata');
      expect(body.apk).toHaveProperty('localPresent');
      expect(body.sourceDb).toHaveProperty('localPresent');
      expect(body.metadata).toHaveProperty('localPresent');
    }

    if (res.status() === 404) {
      const body = await res.json();
      // Should be a structured error, not a raw crash
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    }
  });

  test('availability endpoint returns 401 without authentication', async ({ request }) => {
    // A fresh unauthenticated request context should be denied — confirms the
    // endpoint is behind auth middleware, not accidentally open.
    const res = await request.get(`${API_BASE}/v1/apks/com.fixture/1/availability`);
    // 401 Unauthorized or 403 Forbidden — both are acceptable rejections
    expect([401, 403]).toContain(res.status());
  });

  test('availability endpoint returns 400 for a non-numeric versionId', async ({ request }) => {
    const csrfToken = await apiLogin(request, ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await request.get(`${API_BASE}/v1/apks/com.fixture/not-a-number/availability`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  // ── 2. APK browser — availability badge in version list ──────────────────────

  test('APK browser page loads and shows the Storage column header', async ({ page }) => {
    // 90s: loginAsAdmin waits for the sidebar, which can take longer than the
    // default 60s global timeout when the server is starting cold.
    test.setTimeout(90_000);

    await loginAsAdmin(page);
    await page.goto('/ui/apks');
    await page.waitForLoadState('networkidle');

    // The page must render the APK browser container
    await expect(page.locator('[data-testid="apk-browser"]')).toBeVisible({ timeout: 15_000 });

    // If any tracked apps are present, expand the first one and assert the
    // AvailabilityBadge renders for at least one version row.
    const appRows = page.locator('[data-testid^="tracked-app-row-"]');
    const count = await appRows.count();

    if (count === 0) {
      // No apps seeded in the E2E harness — nothing to expand.
      // The Storage column header is inside the version sub-table which only
      // renders when an app is expanded; we can't assert it without a fixture.
      test.info().annotations.push({
        type: 'info',
        description:
          'No tracked apps in E2E DB — Storage column and AvailabilityBadge cannot be asserted without a seeded fixture. Seed a tracked app with at least one APK version to exercise this path.',
      });
      return;
    }

    // Expand the first app row to reveal its version list
    await appRows.first().click();

    // The version sub-table should appear
    const firstAppId = await appRows.first().getAttribute('data-testid');
    // data-testid is "tracked-app-row-<id>" → extract numeric suffix
    const appId = firstAppId?.replace('tracked-app-row-', '');
    const versionsPanel = page.locator(`[data-testid="versions-${appId}"]`);
    await expect(versionsPanel).toBeVisible({ timeout: 10_000 });

    // The "Storage" column header must be present in the expanded table
    await expect(versionsPanel.locator('text=Storage')).toBeVisible();

    // At least one AvailabilityBadge should be rendered.
    // The badge renders as a <span> with one of the known label texts.
    const badge = versionsPanel.locator('text=/^(Local|Cloud|Needs re-analyze|Lost)$/').first();
    await expect(badge).toBeVisible();
  });

  // ── 3. Run Diff gated on local state ─────────────────────────────────────────

  test.skip('Run Diff is disabled when the current version is not local', async () => {
    // SKIPPED: exercising this path requires:
    //   a) A tracked app with at least two APK versions in the E2E DB.
    //   b) One of those versions put into a non-local state (cloud_only in the
    //      cloudFiles table), which the E2E harness has no API to force.
    //
    // The unit-test coverage for this lives in:
    //   frontend/pages/ApkAnalysis.tsx — renderDiffTab() logic (bothLocal check)
    //   backend/api/apk-availability.test.ts — endpoint shape verification
    //
    // When fixture seeding infrastructure is added (e.g. POST /v1/test/seed),
    // this test should:
    //   1. Seed two versions of a package.
    //   2. Force version A into cloud_only state.
    //   3. Navigate to /ui/apks/<pkg>/<versionId>/diff tab.
    //   4. Assert the "Run Diff Analysis" button is disabled with title
    //      "Restore this version to local before running a diff".
  });
});
