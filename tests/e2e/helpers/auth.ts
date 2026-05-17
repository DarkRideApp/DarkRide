/**
 * Shared authentication helpers for E2E tests.
 *
 * The Playwright config starts a real server with a temp DB and
 * auto-bootstraps an admin user via env vars.
 */

import { type Page, type APIRequestContext, expect } from '@playwright/test';

export const API_BASE = 'http://localhost:3199';
export const ADMIN_USERNAME = 'e2e-admin';
export const ADMIN_PASSWORD = 'e2e-test-password-123';

/**
 * Wait for the backend to be ready (migrations run, bootstrap complete).
 * Call once in beforeAll if tests need API access before UI login.
 */
export async function waitForBackend(request: APIRequestContext): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await request.get(`${API_BASE}/v1/auth/me`);
      const data = await res.json();
      if (data.authenticated !== undefined) return;
    } catch {
      /* server not ready yet */
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Backend did not become ready within 30s');
}

/**
 * Log in via the API and return the CSRF token.
 */
export async function apiLogin(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/v1/auth/login`, {
    data: {
      providerId: 'core.local',
      credentials: { username, password },
    },
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Login failed for ${username}: ${data.error}`);
  return data.csrfToken;
}

/**
 * Wait for the AuthGuard to resolve past the "Loading..." state.
 * Returns 'login' if the login form appears, 'app' if the authenticated app loaded.
 *
 * The AuthGuard checks /v1/auth/me on mount. While that request is in flight
 * (or retrying on network error), the page shows a "Loading..." spinner.
 * We must wait for that to resolve before interacting with the page.
 */
export async function waitForAuthGuard(page: Page): Promise<'login' | 'app'> {
  // Race: either the login form appears OR the sidebar (authenticated app) appears.
  // Both indicate that the AuthGuard has resolved.
  const loginForm = page.locator('#login-username');
  const sidebar = page.locator('[data-testid="sidebar"]');

  const winner = await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'login' as const),
    sidebar.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'app' as const),
  ]);

  return winner;
}

/**
 * Log in as the bootstrapped admin user via the browser UI.
 *
 * Navigates to /ui/, waits for the AuthGuard to resolve (login form
 * or already-authenticated app), fills credentials if needed, and
 * waits for the full app to load.
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/ui/');

  const state = await waitForAuthGuard(page);

  // If already logged in, we're done.
  if (state === 'app') return;

  // Fill and submit the login form
  await page.locator('#login-username').fill(ADMIN_USERNAME);
  await page.locator('#login-password').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();

  // Wait for the authenticated app to load (WebSocket connects, startup screen clears).
  // The sidebar is the reliable indicator that the full app is loaded.
  await page.locator('[data-testid="sidebar"]').waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Log out via the UI logout button.
 */
export async function logout(page: Page): Promise<void> {
  const logoutBtn = page.locator('button.nav-logout');
  await logoutBtn.click();
  // Wait for the login page to appear (AuthGuard transitions through loading -> login)
  await page.locator('#login-username').waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Create a limited-scope user via the admin API.
 * Returns the claim token that the new user can use to set their password.
 *
 * Requires that `request` has an active admin session (call apiLogin first).
 */
export async function createLimitedUser(
  request: APIRequestContext,
  csrfToken: string,
  username: string,
  scopes: string[],
): Promise<string> {
  const res = await request.post(`${API_BASE}/v1/admin/users`, {
    data: { username, scopes },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Create user failed: ${data.error}`);
  return data.data.token;
}

/**
 * Claim a user account (set initial password) via the API.
 * Returns the CSRF token for the now-authenticated session.
 */
export async function claimUser(
  request: APIRequestContext,
  token: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/v1/auth/claim`, {
    data: { token, password },
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Claim failed: ${data.error}`);
  return data.csrfToken;
}

/**
 * Log out via the API.
 */
export async function apiLogout(
  request: APIRequestContext,
  csrfToken: string,
): Promise<void> {
  await request.post(`${API_BASE}/v1/auth/logout`, {
    headers: { 'X-CSRF-Token': csrfToken },
  });
}
