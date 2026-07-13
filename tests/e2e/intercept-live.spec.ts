/**
 * Interactive intercept ("breakpoints") — E2E.
 *
 * Drives the real UI end to end: arm interception from the Traffic subheader,
 * play the mitmproxy addon's role by long-polling POST /v1/intercept/hold over
 * loopback (auth-bypassed like the other bridge callbacks), watch the hold panel
 * appear via WebSocket broadcast, edit the request, Forward Modified, and assert
 * the addon receives the edited resolution.
 *
 * The rule-based Intercept feature is untouched — this is a separate capability.
 *
 * Run: npx playwright test tests/e2e/intercept-live.spec.ts
 */

import { test, expect, type APIResponse } from '@playwright/test';
import path from 'path';
import { API_BASE, loginAsAdmin, waitForBackend } from './helpers/auth';

const SHOT_DIR = path.resolve(process.cwd(), 'screenshots');

// Arm interception idempotently from the UI, tolerant of whatever armed state a
// previous test left behind. Uses page.request (which shares the browser's auth
// cookies) to read the server state, and the real toggle button to change it.
async function ensureArmed(page: import('@playwright/test').Page): Promise<void> {
  const armToggle = page.getByTestId('intercept-arm-toggle');
  await expect(armToggle).toBeVisible();
  const current = await (await page.request.get(`${API_BASE}/v1/intercept/armed`)).json();
  if (!current?.data?.enabled) {
    await armToggle.click();
  }
  await expect(armToggle).toContainText('On');
  await expect.poll(async () => {
    const res = await page.request.get(`${API_BASE}/v1/intercept/armed`);
    return (await res.json())?.data?.enabled;
  }).toBe(true);
}

test.describe('Interactive intercept (breakpoints)', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await waitForBackend(page.request);
    await ctx.close();
  });

  test.afterEach(async ({ page }) => {
    // Disarm through the authenticated browser context so the next test starts
    // clean. (The bare `request` fixture is unauthenticated and /armed is not
    // loopback-exempt, so it must go through page.request.)
    await page.request.post(`${API_BASE}/v1/intercept/armed`, { data: { enabled: false } }).catch(() => {});
  });

  test('arm → held request flow → edit → forward modified', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/traffic');
    await expect(page.getByTestId('traffic-page')).toBeVisible();

    // The existing subheader affordances must still be present (additive change).
    // Use exact match: the filter bar also renders a "Clear all" button.
    await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeVisible();

    // Arm interception from the subheader toggle.
    await ensureArmed(page);

    // Play the addon: long-poll a held request flow. Do NOT await yet — it
    // blocks until the UI resolves it.
    const holdPromise: Promise<APIResponse> = page.request.post(`${API_BASE}/v1/intercept/hold`, {
      data: {
        flowId: 'e2e-flow-1',
        phase: 'request',
        deviceId: 'e2e-device',
        sessionId: null,
        method: 'GET',
        url: 'https://api.example.com/v1/thing',
        headers: { 'x-token': 'abc', 'user-agent': 'e2e' },
        body: '{"a":1}',
      },
      timeout: 60_000,
    });

    // The hold panel appears via WebSocket broadcast.
    const panel = page.getByTestId('intercept-hold-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('intercept-hold-phase')).toContainText('Request paused');
    await expect(page.getByTestId('intercept-edit-method')).toHaveValue('GET');
    await expect(page.getByTestId('intercept-edit-url')).toHaveValue('https://api.example.com/v1/thing');

    // Visual verification artefact.
    await page.screenshot({ path: path.join(SHOT_DIR, 'intercept-hold-request.png'), fullPage: true });

    // Edit the method, URL and body, then Forward Modified.
    await page.getByTestId('intercept-edit-method').fill('POST');
    await page.getByTestId('intercept-edit-url').fill('https://api.example.com/v2/thing');
    await page.getByTestId('intercept-edit-body').fill('{"a":2}');
    await page.getByTestId('intercept-forward-modified').click();

    // Panel closes once resolved.
    await expect(panel).toBeHidden({ timeout: 10_000 });

    // The addon (our hold POST) receives the edited resolution.
    const holdRes = await holdPromise;
    expect(holdRes.status()).toBe(200);
    const resolution = await holdRes.json();
    expect(resolution.action).toBe('forward');
    expect(resolution.modified.method).toBe('POST');
    expect(resolution.modified.url).toBe('https://api.example.com/v2/thing');
    expect(resolution.modified.body).toBe('{"a":2}');
    expect(resolution.modified.headers).toMatchObject({ 'x-token': 'abc' });
  });

  test('held flow can be dropped', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/traffic');
    await expect(page.getByTestId('traffic-page')).toBeVisible();

    await ensureArmed(page);

    const holdPromise: Promise<APIResponse> = page.request.post(`${API_BASE}/v1/intercept/hold`, {
      data: {
        flowId: 'e2e-flow-drop',
        phase: 'response',
        deviceId: 'e2e-device',
        method: 'GET',
        url: 'https://api.example.com/v1/secret',
        headers: { 'content-type': 'application/json' },
        body: '{"secret":true}',
        statusCode: 200,
      },
      timeout: 60_000,
    });

    const panel = page.getByTestId('intercept-hold-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('intercept-hold-phase')).toContainText('Response paused');
    await expect(page.getByTestId('intercept-edit-status')).toHaveValue('200');
    await page.screenshot({ path: path.join(SHOT_DIR, 'intercept-hold-response.png'), fullPage: true });

    await page.getByTestId('intercept-drop').click();
    await expect(panel).toBeHidden({ timeout: 10_000 });

    const holdRes = await holdPromise;
    const resolution = await holdRes.json();
    expect(resolution.action).toBe('drop');
  });
});
