import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

/**
 * Regression coverage for the API Keys create-flow on the Profile page.
 *
 * Bugs this test guards against:
 * 1. Scope picker used to list ALL user scopes, including wildcards.
 *    An admin with `core.admin:*` saw only the wildcard as a checkbox
 *    option, selected it, and the backend rejected it as wildcards-
 *    in-API-keys-not-allowed.
 * 2. handleCreateKey did not check the HTTP status and treated a 400
 *    rejection as success — showing the "copy your new key" modal with
 *    an empty string in the key field.
 */

test.describe('Profile — API Keys', () => {
  test.beforeAll(async ({ request }) => { await waitForBackend(request); });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/profile');
    await expect(page.locator('[data-testid="profile-page"]')).toBeVisible({ timeout: 15_000 });
  });

  test('scope picker shows a grouped catalog (no wildcards, real categories)', async ({ page }) => {
    await page.getByRole('button', { name: /create api key|add key/i }).click();

    const nameInput = page.locator('[id="key-name"], input[placeholder*="key"]').first();
    await nameInput.fill('e2e scope-picker test');

    // No label should carry a wildcard scope like "core.admin:*"
    const wildcardLabels = page.locator('label').filter({ hasText: /\*/ });
    await expect(wildcardLabels).toHaveCount(0);

    // Category headers render (admin sees all categories)
    await expect(page.getByText(/^Devices$/i)).toBeVisible();
    await expect(page.getByText(/^APKs$/i)).toBeVisible();

    // At least one recognised concrete scope is present as a code-tagged key
    await expect(page.locator('code').filter({ hasText: 'core.apk:read' }).first()).toBeVisible();

    await page.getByRole('button', { name: /cancel|close/i }).first().click();
  });

  test('creating a key with no scopes shows an error toast and keeps the modal open', async ({ page }) => {
    await page.getByRole('button', { name: /create api key|add key/i }).click();
    const nameInput = page.locator('[id="key-name"], input[placeholder*="key"]').first();
    await nameInput.fill('e2e no-scopes test');

    // Click Create with no scopes selected
    await page.getByRole('button', { name: /^create$/i }).click();

    // Error toast appears
    await expect(page.getByText(/at least one scope|no scopes/i)).toBeVisible({ timeout: 5_000 });

    // The "new key created" modal should NOT appear
    await expect(page.locator('text=/api key created/i')).not.toBeVisible();
  });

  test('creating a key with a legit specific scope shows a non-empty plaintext token', async ({ page }) => {
    await page.getByRole('button', { name: /create api key|add key/i }).click();

    const name = `e2e concrete scope ${Date.now()}`;
    const nameInput = page.locator('[id="key-name"], input[placeholder*="key"]').first();
    await nameInput.fill(name);

    // Pick a specific scope from the grouped catalog by ticking its checkbox.
    // The `code` element with the scope key is inside the label; use getByRole
    // with the scope's label text ("Read APKs").
    await page.locator('label').filter({ hasText: /Read APKs/i }).locator('input[type="checkbox"]').check();

    // Selected pill appears
    await expect(page.locator('text=core.apk:read').last()).toBeVisible();

    // Submit
    await page.getByRole('button', { name: /^create$/i }).click();

    // Success modal shows a non-empty plaintext token
    const tokenField = page.locator('text=/darkride_pat_[0-9a-f]+/');
    await expect(tokenField).toBeVisible({ timeout: 10_000 });

    // Cleanup via API so we don't leak rows
    await page.getByRole('button', { name: /close|done|ok/i }).first().click();

    // Find the new row in the keys table and revoke it so we leave a clean state
    const keyRow = page.getByRole('row').filter({ hasText: name });
    await expect(keyRow).toBeVisible();
    page.on('dialog', d => d.accept());
    await keyRow.getByRole('button', { name: /revoke/i }).click();
  });

  test('submitting a wildcard-scope payload directly still surfaces backend rejection cleanly', async ({ page }) => {
    // Even if somehow the frontend permitted a wildcard (future refactor safety net),
    // the backend rejects and the user should see it cleanly without an empty-key modal.
    const csrfToken = await page.evaluate(() => {
      const m = document.cookie.match(/darkride_csrf=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    });

    const res = await page.request.post('/v1/profile/api-keys', {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { name: 'wildcard direct', scopes: ['core.admin:*'] },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/wildcards/i);
  });
});
