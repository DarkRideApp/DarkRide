/**
 * Log the recorder's browser into DarkRide before a scenario runs — otherwise
 * the fresh Playwright context lands on the login screen and records nothing
 * useful. Mirrors tests/e2e/helpers/auth.ts (the proven login flow).
 *
 * No-op if the context is already authenticated (sidebar visible).
 */
export async function loginToDarkride(page, baseURL, username, password) {
  await page.goto(new URL('/ui/', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  const loginForm = page.locator('#login-username');
  const sidebar = page.locator('[data-testid="sidebar"]');

  // The AuthGuard shows a loading spinner, then either the login form or the app.
  const state = await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'login'),
    sidebar.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'app'),
  ]);
  if (state === 'app') return; // already logged in

  await loginForm.fill(username);
  await page.locator('#login-password').fill(password);
  await page.locator('button[type="submit"]').click();
  await sidebar.waitFor({ state: 'visible', timeout: 30_000 });
}
