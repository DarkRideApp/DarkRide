/**
 * Scoped interactive intercept — E2E
 *
 * Arm interactive intercept with a host-scoped match rule via the scope editor,
 * confirm the armed control shows the scope chip, then disarm.
 *
 * Run: npx playwright test tests/e2e/scoped-intercept.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('Scoped interactive intercept', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('arm a host-scoped rule, see the chip, then disarm', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    await page.goto('/ui/traffic');
    await page.waitForLoadState('networkidle');

    const arm = page.getByTestId('intercept-arm-toggle');
    await expect(arm).toContainText(/off/i);

    // Open the editor and define a host rule.
    await arm.click();
    await expect(page.getByTestId('intercept-scope-editor')).toBeVisible();
    await page.getByTestId('intercept-rule-host-0').fill('*.stripe.com');
    await expect(page.getByTestId('intercept-scope-summary')).toContainText(/\*\.stripe\.com/);
    await page.getByTestId('intercept-arm-apply').click();

    // The armed control now shows the scope, not just "On".
    await expect(arm).toContainText('*.stripe.com');
    await expect(arm).not.toContainText(/off/i);

    // Reopen and disarm.
    await arm.click();
    await page.getByTestId('intercept-disarm').click();
    await expect(arm).toContainText(/off/i);
  });
});
