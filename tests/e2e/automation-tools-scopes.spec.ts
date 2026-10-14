/**
 * A script's `tools` calls run with the scopes of whoever last saved its code,
 * not of whoever starts it.
 *
 * Run: npx playwright test tests/e2e/automation-tools-scopes.spec.ts
 */

import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import {
  API_BASE,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  waitForBackend,
  apiLogin,
  createLimitedUser,
  claimUser,
} from './helpers/auth';

// list_devices needs core.devices:read, which the limited user does not hold.
const SCRIPT = `declare const tools: any;
export default async function() {
  await tools.list_devices({});
}`;
const WRITER_SCOPES = ['core.automations:read', 'core.automations:edit', 'core.automations:execute'];

interface Session { request: APIRequestContext; csrf: string }

async function signInAdmin(browser: Browser): Promise<Session> {
  const request = (await browser.newContext()).request;
  return { request, csrf: await apiLogin(request, ADMIN_USERNAME, ADMIN_PASSWORD) };
}

async function signInWriter(browser: Browser, adminSession: Session): Promise<Session> {
  const username = `script-writer-${Date.now()}`;
  const password = 'script-writer-pw-789';
  const claimToken = await createLimitedUser(adminSession.request, adminSession.csrf, username, WRITER_SCOPES);
  const request = (await browser.newContext()).request;
  return { request, csrf: await claimUser(request, claimToken, password) };
}

async function send(s: Session, method: 'post' | 'put' | 'delete', path: string, data?: unknown) {
  const res = await s.request[method](`${API_BASE}${path}`, { data, headers: { 'X-CSRF-Token': s.csrf } });
  return { status: res.status(), body: await res.json() };
}

async function runScript(s: Session, id: number) {
  const res = await send(s, 'post', `/v1/automation/run/${id}`, {});
  expect(res.status).toBe(200);
  return res.body.data as { success: boolean; error?: string };
}

// The runner gets its tool registry late in startup, right after the tool list route appears.
async function waitForTools(s: Session) {
  await expect.poll(async () => {
    const res = await s.request.get(`${API_BASE}/v1/tools`);
    return res.ok() && JSON.stringify(await res.json()).includes('list_devices');
  }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe(true);
}

test.describe('Script tool access', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    await waitForBackend((await ctx.newPage()).request);
    await ctx.close();
  });

  test('follows the person who last saved the code', async ({ browser }) => {
    test.setTimeout(150_000);
    const admin = await signInAdmin(browser);
    await waitForTools(admin);
    const writer = await signInWriter(browser, admin);
    const ids: number[] = [];

    try {
      await test.step('a script saved by a user without the tool scope is refused', async () => {
        const created = await send(writer, 'post', '/v1/automation/create', { name: 'e2e writer script', code: SCRIPT, requiresDevice: false });
        expect(created.status).toBe(201);
        ids.push(created.body.data.id);

        const run = await runScript(writer, created.body.data.id);
        expect(run.success).toBe(false);
        expect(run.error).toContain('Insufficient scope: core.devices:read required for tool list_devices');
      });

      let adminScriptId = 0;
      await test.step('the same script saved by an admin runs, even when the writer starts it', async () => {
        const created = await send(admin, 'post', '/v1/automation/create', { name: 'e2e admin script', code: SCRIPT, requiresDevice: false });
        expect(created.status).toBe(201);
        adminScriptId = created.body.data.id;
        ids.push(adminScriptId);

        expect((await runScript(admin, adminScriptId)).success).toBe(true);
        expect((await runScript(writer, adminScriptId)).success).toBe(true);
      });

      await test.step('saving the admin\'s script again as the writer takes its tool access away', async () => {
        const saved = await send(writer, 'put', `/v1/automation/update/${adminScriptId}`, { code: SCRIPT });
        expect(saved.status).toBe(200);

        const run = await runScript(admin, adminScriptId);
        expect(run.success).toBe(false);
        expect(run.error).toContain('Insufficient scope');
      });

      await test.step('an admin save gives it back', async () => {
        await send(admin, 'put', `/v1/automation/update/${adminScriptId}`, { code: SCRIPT });
        expect((await runScript(writer, adminScriptId)).success).toBe(true);
      });

      await test.step('a rename leaves the author alone', async () => {
        await send(writer, 'put', `/v1/automation/update/${adminScriptId}`, { name: 'e2e renamed by writer' });
        expect((await runScript(admin, adminScriptId)).success).toBe(true);
      });

      await test.step('no automation response carries the author', async () => {
        const view = await send(admin, 'post', '/v1/automation/create', { name: 'e2e view', code: SCRIPT, requiresDevice: false });
        ids.push(view.body.data.id);
        const res = await admin.request.get(`${API_BASE}/v1/automation/view/${view.body.data.id}`);
        expect(JSON.stringify(await res.json())).not.toMatch(/author/i);
      });
    } finally {
      for (const id of ids) await send(admin, 'delete', `/v1/automation/delete/${id}`);
    }
  });
});
