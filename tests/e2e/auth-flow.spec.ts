/**
 * Authentication Flow E2E Tests
 *
 * Tests login, logout, session persistence, API key creation,
 * and scoped-user behaviour against the real running server.
 *
 * Run: npx playwright test tests/e2e/auth-flow.spec.ts
 */

import { test, expect } from '@playwright/test';
import {
  API_BASE,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  loginAsAdmin,
  logout,
  waitForBackend,
  waitForAuthGuard,
  apiLogin,
  apiLogout,
  createLimitedUser,
  claimUser,
} from './helpers/auth';

test.describe('Authentication flows', () => {
  test.beforeAll(async ({ browser }) => {
    // Make sure the backend is ready before running any tests
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test('login page renders when not authenticated', async ({ page }) => {
    await page.goto('/ui/');

    // Wait for AuthGuard to resolve past the "Loading..." state
    const state = await waitForAuthGuard(page);
    expect(state).toBe('login');

    // Should see the login form
    await expect(page.locator('#login-username')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();

    // The page should show the DarkRide title
    await expect(page.locator('.auth-title')).toHaveText('DarkRide');
    await expect(page.locator('.auth-subtitle')).toHaveText('Sign in to continue');
  });

  test('login succeeds with correct credentials and redirects to dashboard', async ({ page }) => {
    await page.goto('/ui/');
    await waitForAuthGuard(page);

    // Fill the login form
    await page.locator('#login-username').fill(ADMIN_USERNAME);
    await page.locator('#login-password').fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();

    // Should load the authenticated app — the sidebar appears
    await page.locator('[data-testid="sidebar"]').waitFor({ state: 'visible', timeout: 30_000 });

    // The sidebar should show the username
    await expect(page.locator('.sidebar-identity-name')).toHaveText(ADMIN_USERNAME);
  });

  test('login fails with wrong password and shows error', async ({ page }) => {
    await page.goto('/ui/');
    await waitForAuthGuard(page);

    await page.locator('#login-username').fill(ADMIN_USERNAME);
    await page.locator('#login-password').fill('wrong-password-definitely');
    await page.locator('button[type="submit"]').click();

    // Should show an error message
    await expect(page.locator('.auth-error')).toBeVisible({ timeout: 10_000 });
    const errorText = await page.locator('.auth-error').textContent();
    expect(errorText).toBeTruthy();

    // Should still be on the login page
    await expect(page.locator('#login-username')).toBeVisible();
  });

  test('session persists after page refresh', async ({ page }) => {
    await loginAsAdmin(page);

    // Verify we are on the dashboard
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    // Refresh the page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should still be authenticated — sidebar visible, no login form
    await page.locator('[data-testid="sidebar"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('#login-username')).not.toBeVisible();
    await expect(page.locator('.sidebar-identity-name')).toHaveText(ADMIN_USERNAME);
  });

  test('logout redirects to login page', async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    // Click the logout button
    await logout(page);

    // Should be back on the login page
    await expect(page.locator('#login-username')).toBeVisible();
    await expect(page.locator('.auth-title')).toHaveText('DarkRide');

    // Navigating to a protected route should still show login
    await page.goto('/ui/devices');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#login-username')).toBeVisible({ timeout: 10_000 });
  });

  test('API key creation on profile page', async ({ page }) => {
    await loginAsAdmin(page);

    // Navigate to profile page
    await page.goto('/ui/profile');
    await page.waitForLoadState('networkidle');

    // Verify profile page loaded
    await expect(page.locator('[data-testid="profile-page"]')).toBeVisible({ timeout: 15_000 });

    // Wait for the API keys section to finish loading
    // It starts with "Loading..." then shows the table or "No API keys yet"
    await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();

    // Click "Create Key" button
    const createKeyBtn = page.locator('button', { hasText: 'Create Key' });
    await createKeyBtn.click();

    // The modal should appear
    await expect(page.locator('[data-testid="modal"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#modal-title')).toHaveText('Create API Key');

    // Fill the key name
    await page.locator('#key-name').fill('E2E Test Key');

    // Click Create in the modal footer
    const modalCreateBtn = page.locator('[data-testid="modal"] button.btn-primary', { hasText: 'Create' });
    await modalCreateBtn.click();

    // The "key created" modal should appear showing the key value
    await expect(page.locator('#modal-title')).toHaveText('API Key Created', { timeout: 10_000 });
    await expect(page.locator('text=Copy this key now')).toBeVisible();

    // Close the modal
    const doneBtn = page.locator('[data-testid="modal"] button', { hasText: 'Done' });
    await doneBtn.click();

    // The key should now appear in the API keys table
    await expect(page.locator('text=E2E Test Key')).toBeVisible({ timeout: 5_000 });
  });

  test('scoped user sees restricted navigation', async ({ browser }) => {
    // Use a fresh context so we don't interfere with other tests
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await waitForBackend(page.request);

      // 1. Login as admin via API and create a limited user
      const adminCsrf = await apiLogin(page.request, ADMIN_USERNAME, ADMIN_PASSWORD);

      const limitedUsername = `limited-${Date.now()}`;
      const limitedPassword = 'limited-secure-pw-789';
      const limitedScopes = ['core.devices:read', 'core.automations:read'];

      const claimToken = await createLimitedUser(
        page.request,
        adminCsrf,
        limitedUsername,
        limitedScopes,
      );

      // Logout admin
      await apiLogout(page.request, adminCsrf);

      // 2. Claim the user account (set password)
      const claimCsrf = await claimUser(page.request, claimToken, limitedPassword);
      await apiLogout(page.request, claimCsrf);

      // 3. Login as the limited user via UI
      await page.goto('/ui/');
      await waitForAuthGuard(page);
      await page.locator('#login-username').fill(limitedUsername);
      await page.locator('#login-password').fill(limitedPassword);
      await page.locator('button[type="submit"]').click();

      // Wait for the app
      await page.locator('[data-testid="sidebar"]').waitFor({ state: 'visible', timeout: 30_000 });

      // 4. Verify the limited user's username is shown
      await expect(page.locator('.sidebar-identity-name')).toHaveText(limitedUsername);

      // 5. The limited user should NOT see the "Users" admin nav item
      //    (it requires core.users:admin scope)
      const usersLink = page.locator('nav a[href="/ui/admin/users"]');
      await expect(usersLink).not.toBeVisible();

      // 6. The limited user SHOULD see Devices and Automations
      const devicesLink = page.locator('nav a[href="/ui/devices"]');
      await expect(devicesLink).toBeVisible();
      const automationsLink = page.locator('nav a[href="/ui/automations"]');
      await expect(automationsLink).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});
