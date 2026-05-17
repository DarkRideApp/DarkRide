/**
 * OAuth MCP E2E Tests
 *
 * Verifies the full OAuth 2.1 + MCP integration:
 * - Discovery metadata endpoint
 * - MCP 401 + WWW-Authenticate header when unauthenticated
 * - Dynamic client registration → consent → token exchange → MCP call → revoke
 *
 * Run: npx playwright test tests/e2e/oauth-mcp.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend, API_BASE, ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers/auth';

/**
 * Wait for the server to fully complete startup (including Python dep install).
 * The WebSocket emits startup-progress; the UI shows a startup screen until
 * phase === 'ready'. We detect readiness by waiting for the sidebar to appear
 * after a full UI login, with a generous timeout for Python package installation.
 */
async function waitForServerReady(browser: import('@playwright/test').Browser): Promise<void> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await waitForBackend(page.request);
    await page.goto('/ui/');
    // Wait for AuthGuard to resolve (login form or already authenticated)
    const loginForm = page.locator('#login-username');
    const sidebar = page.locator('[data-testid="sidebar"]');
    const state = await Promise.race([
      loginForm.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'login' as const),
      sidebar.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'app' as const),
    ]);
    if (state === 'login') {
      await loginForm.fill(ADMIN_USERNAME);
      await page.locator('#login-password').fill(ADMIN_PASSWORD);
      await page.locator('button[type="submit"]').click();
    }
    // Wait up to 2 minutes for startup screen to clear — Python dep install can take ~60s
    await sidebar.waitFor({ state: 'visible', timeout: 120_000 });
  } finally {
    await ctx.close();
  }
}

test.describe('OAuth MCP flow', () => {
  test.beforeAll(async ({ browser }) => {
    // Wait for the backend and full startup (startup screen cleared, WebSocket ready).
    // Running this spec in isolation starts a fresh server that may need to install
    // Python dependencies — this can take over 60s, hence the extended timeout.
    // Set hook timeout to 3 minutes to cover the full Python install phase.
    test.setTimeout(180_000);
    await waitForServerReady(browser);
  });

  test('discovery metadata is served', async ({ page }) => {
    const res = await page.request.get(`${API_BASE}/.well-known/oauth-authorization-server`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
  });

  test('mcp returns 401 with WWW-Authenticate when unauthenticated', async ({ page }) => {
    const res = await page.request.post(`${API_BASE}/mcp`, {
      data: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.status()).toBe(401);
    const wwwAuth = res.headers()['www-authenticate'] ?? '';
    expect(wwwAuth).toMatch(/^Bearer /);
    expect(wwwAuth).toMatch(/resource_metadata=/);
  });

  test('dynamic client registration + consent + token exchange + mcp call + revoke', async ({ page, request }) => {
    await loginAsAdmin(page);

    // Use a unique client name so parallel/repeat runs don't collide
    const uniqueName = `E2E Client ${Date.now()}`;

    // 1. Register a client via the open /oauth/register endpoint (no auth required).
    //    Use `request` (not `page.request`) to avoid sending the browser session
    //    cookie — if the cookie is present, the CSRF middleware fires on POST requests
    //    even for allowlisted OAuth endpoints.
    const reg = await request.post(`${API_BASE}/oauth/register`, {
      data: {
        client_name: uniqueName,
        redirect_uris: ['http://127.0.0.1:4000/cb'],
      },
    });
    expect(reg.status()).toBe(201);
    const { client_id } = await reg.json();
    expect(typeof client_id).toBe('string');
    expect(client_id.length).toBeGreaterThan(0);

    // Known PKCE test pair (RFC 7636 Appendix B)
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // 2. Navigate to the authorize endpoint via Vite (which proxies /oauth/* to the backend).
    //    The backend redirects authenticated users to /ui/oauth/consent — a relative redirect
    //    that Vite follows back to the React SPA.
    const authzPath = `/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:4000/cb')}&code_challenge=${challenge}&code_challenge_method=S256&scope=mcp&state=xyz`;
    await page.goto(authzPath); // relative to baseURL (Vite, port 5199)

    // The consent page renders the client name as an <h1> heading
    await expect(page.getByRole('heading', { name: uniqueName })).toBeVisible({ timeout: 10_000 });

    // 3. Submit the consent form. The ConsentPage POSTs to /oauth/authorize/consent
    //    and receives JSON { location }, then navigates via window.location.href.
    //    We capture the code by intercepting that navigation to the loopback callback.
    let capturedCode: string | null = null;
    await page.route('http://127.0.0.1:4000/cb*', (route, req) => {
      const url = new URL(req.url());
      capturedCode = url.searchParams.get('code');
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>ok</body></html>' });
    });

    // Fallback: read the JSON body of the consent POST response.
    const consentResponsePromise = page.waitForResponse(
      resp => resp.url().includes('/oauth/authorize/consent') && resp.request().method() === 'POST',
      { timeout: 10_000 },
    );

    await page.getByRole('button', { name: /^Allow$/i }).click();

    const consentResp = await consentResponsePromise;

    if (!capturedCode) {
      try {
        const body = await consentResp.json();
        if (body?.location) capturedCode = new URL(body.location).searchParams.get('code');
      } catch { /* ignore */ }
    }

    if (!capturedCode) {
      await expect.poll(() => capturedCode, { timeout: 5_000 }).not.toBeNull();
    }

    expect(capturedCode).not.toBeNull();
    expect(typeof capturedCode).toBe('string');
    expect(capturedCode!.length).toBeGreaterThan(0);

    // 3. Exchange code for tokens (form-encoded as per OAuth spec).
    //    Also use `request` here — /oauth/token is an OAuth public endpoint that should
    //    not require a session cookie, and must not be blocked by CSRF middleware.
    const tok = await request.post(`${API_BASE}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code: capturedCode!,
        redirect_uri: 'http://127.0.0.1:4000/cb',
        client_id,
        code_verifier: verifier,
      },
    });
    expect(tok.status()).toBe(200);
    const tokenBody = await tok.json();
    const { access_token } = tokenBody;
    expect(access_token).toMatch(/^oauth_at_/);
    expect(tokenBody.token_type).toBe('Bearer');

    // 4. Use the access token to call the MCP endpoint.
    //    MCP Streamable HTTP transport requires Accept: application/json, text/event-stream.
    //    Use `request` with Bearer token — this is an OAuth client scenario, no session cookie.
    const mcpRes = await request.post(`${API_BASE}/mcp`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json, text/event-stream',
      },
      data: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(mcpRes.status()).toBe(200);

    // 5. Grant appears on profile page
    await page.goto('/ui/profile');
    // Wait for profile page to load and the OAuth grants to appear.
    // Grants are fetched via WebSocket (sendRestApi) which networkidle doesn't track.
    // Wait for the data-testid="profile-page" to confirm the page itself is rendered,
    // then wait for the "Authorized Apps" heading and the grant row to appear.
    await expect(page.locator('[data-testid="profile-page"]')).toBeVisible({ timeout: 15_000 });
    // The grants section shows "Loading..." while fetching, then renders the table.
    // Wait for the section heading to confirm grants data has loaded.
    await expect(page.getByRole('heading', { name: 'Authorized Apps' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 15_000 });

    // 6. Revoke via profile UI
    //    The "Revoke" button opens a ConfirmDialog (React modal, not a browser dialog).
    //    Find the row for our client and click its Revoke button, then confirm in the modal.
    const row = page.getByRole('row').filter({ hasText: uniqueName });
    await row.getByRole('button', { name: /^Revoke$/i }).click();

    // ConfirmDialog appears — click the confirm button (data-testid="confirm-dialog-confirm")
    await page.locator('[data-testid="confirm-dialog-confirm"]').click();

    // The grant row should disappear after revocation + list refresh
    await expect(page.getByText(uniqueName)).not.toBeVisible({ timeout: 10_000 });
  });
});
