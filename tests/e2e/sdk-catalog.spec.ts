/**
 * SDK Catalog E2E Smoke Test
 *
 * Verifies that /ui/settings/sdk-catalog loads without console errors and
 * that every primitive section's data-testid is visible.
 *
 * Catches regressions where a primitive renders fine on its own dashboard
 * but throws when shown in the catalog (missing prop / missing context).
 *
 * Run: npx playwright test tests/e2e/sdk-catalog.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

const CATALOG_TESTIDS = [
  'catalog-button',
  'catalog-input',
  'catalog-select',
  'catalog-textarea',
  'catalog-page-header',
  'catalog-breadcrumbs',
  'catalog-card',
  'catalog-status-badge',
  'catalog-loading-spinner',
  'catalog-skeleton',
  'catalog-empty-state',
  'catalog-elapsed-timer',
  'catalog-filter-bar',
  'catalog-data-table',
  'catalog-sortable-header',
  'catalog-button-list',
  'catalog-nav-item-list',
  'catalog-key-value-editor',
  'catalog-tier-picker',
  'catalog-inspector-wrapper',
  'catalog-settings-nav',
  'catalog-modal',
  'catalog-confirm-dialog',
  'catalog-keyboard-shortcuts-help',
  'catalog-extension-slot',
];

test.describe('SDK catalog page', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('SDK catalog renders without console errors', async ({ page }) => {
    test.setTimeout(120_000); // Login + page navigation can take up to 2 minutes on first run

    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Filter known-harmless noise (same set as navigation.spec.ts):
        // - favicon 404s are not our problem
        // - ResizeObserver loop notifications are a browser internal
        // - net::ERR_ covers WebSocket reconnect noise during test teardown
        if (
          text.includes('favicon') ||
          text.includes('ResizeObserver') ||
          text.includes('net::ERR_')
        ) return;
        errors.push(text);
      }
    });

    page.on('pageerror', (err) => {
      errors.push(`PAGEERROR: ${err.message}`);
    });

    await loginAsAdmin(page);

    await page.goto('/ui/settings/sdk-catalog');
    await page.waitForLoadState('networkidle');

    for (const testid of CATALOG_TESTIDS) {
      await expect(
        page.locator(`[data-testid="${testid}"]`),
        `Missing section: ${testid}`,
      ).toBeVisible();
    }

    expect(errors, `Console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
