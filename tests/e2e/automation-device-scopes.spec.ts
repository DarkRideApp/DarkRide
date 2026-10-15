/**
 * A script's credential and proxy calls run with the scopes of whoever last saved its code,
 * and "Claim all" gives scripts nobody has claimed an author again.
 *
 * Run: npx playwright test tests/e2e/automation-device-scopes.spec.ts
 */

import { test, expect } from '@playwright/test';
import { API_BASE, waitForBackend, loginAsAdmin } from './helpers/auth';
import { signInAdmin, signInWriter, send, runScript, waitForTool, type Session } from './helpers/script-sessions';

const APP_ID = 'com.e2e.device-scopes';
const SECRET = 'e2e-secret';

const CREDENTIALS_SCRIPT = `export default async function(device: any) {
  const c = await device.getCredentials('${APP_ID}');
  if (c.password !== '${SECRET}') throw new Error('wrong credential');
}`;
const DEVICE_PROXY_SCRIPT = `export default async function(device: any) {
  await device.setProxy('none');
}`;
const HTTP_PROXY_SCRIPT = `declare const http: any;
export default async function() {
  await http.setProxy('none');
}`;
const OUTBOUND_SCRIPT = `declare const http: any;
export default async function(device: any) {
  const a = await http.get('${API_BASE}/v1/auth/me');
  const b = await device.httpGet('${API_BASE}/v1/auth/me');
  if (a.status !== 200 || b.status !== 200) throw new Error('outbound request failed');
}`;

async function createScript(s: Session, name: string, code: string, ids: number[]): Promise<number> {
  const created = await send(s, 'post', '/v1/automation/create', { name, code, requiresDevice: false });
  expect(created.status).toBe(201);
  ids.push(created.body.data.id);
  return created.body.data.id;
}

// The tool saves code without recording an author, which is how a script ends up unclaimed.
async function unclaim(admin: Session, id: number) {
  const res = await send(admin, 'post', '/v1/tools/patch_automation_code', { id, oldText: SECRET, newText: SECRET });
  expect(res.status).toBe(200);
}

test.describe('Script access to credentials and proxies', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    await waitForBackend((await ctx.newPage()).request);
    await ctx.close();
  });

  test('follows the person who last saved the code', async ({ browser }) => {
    test.setTimeout(150_000);
    const admin = await signInAdmin(browser);
    const writer = await signInWriter(browser, admin);
    const ids: number[] = [];
    let credentialId = 0;

    try {
      const credential = await send(admin, 'post', '/v1/credentials/add', { appId: APP_ID, username: 'alice', password: SECRET });
      expect(credential.status).toBe(201);
      credentialId = credential.body.data.id;

      await test.step('a credentials script saved by a user without the scope is refused', async () => {
        const id = await createScript(writer, 'e2e writer credentials', CREDENTIALS_SCRIPT, ids);
        const run = await runScript(writer, id);
        expect(run.success).toBe(false);
        expect(run.error).toContain('Insufficient scope: core.credentials:read required for device.getCredentials');
      });

      await test.step('the same script saved by an admin runs, even when the writer starts it', async () => {
        const id = await createScript(admin, 'e2e admin credentials', CREDENTIALS_SCRIPT, ids);
        expect((await runScript(admin, id)).success).toBe(true);
        expect((await runScript(writer, id)).success).toBe(true);

        await send(writer, 'put', `/v1/automation/update/${id}`, { code: CREDENTIALS_SCRIPT });
        const after = await runScript(admin, id);
        expect(after.success).toBe(false);
        expect(after.error).toContain('Insufficient scope: core.credentials:read');
      });

      await test.step('device.setProxy and http.setProxy need the proxies scope', async () => {
        const writerDevice = await createScript(writer, 'e2e writer device proxy', DEVICE_PROXY_SCRIPT, ids);
        const writerHttp = await createScript(writer, 'e2e writer http proxy', HTTP_PROXY_SCRIPT, ids);
        const adminDevice = await createScript(admin, 'e2e admin device proxy', DEVICE_PROXY_SCRIPT, ids);
        const adminHttp = await createScript(admin, 'e2e admin http proxy', HTTP_PROXY_SCRIPT, ids);

        const refusedDevice = await runScript(writer, writerDevice);
        expect(refusedDevice.success).toBe(false);
        expect(refusedDevice.error).toContain('Insufficient scope: core.proxies:manage required for device.setProxy');

        const refusedHttp = await runScript(writer, writerHttp);
        expect(refusedHttp.success).toBe(false);
        expect(refusedHttp.error).toContain('Insufficient scope: core.proxies:manage required for http.setProxy');

        expect((await runScript(writer, adminDevice)).success).toBe(true);
        expect((await runScript(writer, adminHttp)).success).toBe(true);
      });

      await test.step('outbound HTTP stays open to a script the writer saved', async () => {
        const id = await createScript(writer, 'e2e writer outbound', OUTBOUND_SCRIPT, ids);
        const run = await runScript(writer, id);
        expect(run.error).toBeUndefined();
        expect(run.success).toBe(true);
      });
    } finally {
      for (const id of ids) await send(admin, 'delete', `/v1/automation/delete/${id}`);
      if (credentialId) await send(admin, 'delete', `/v1/credentials/delete/${credentialId}`);
    }
  });

  test('claiming as a limited user does not hand the script the admin\'s access', async ({ browser }) => {
    test.setTimeout(150_000);
    const admin = await signInAdmin(browser);
    await waitForTool(admin, 'patch_automation_code');
    const writer = await signInWriter(browser, admin);
    const ids: number[] = [];
    let credentialId = 0;

    try {
      const credential = await send(admin, 'post', '/v1/credentials/add', { appId: APP_ID, username: 'alice', password: SECRET });
      credentialId = credential.body.data.id;
      const id = await createScript(admin, 'e2e claimed by writer', CREDENTIALS_SCRIPT, ids);
      expect((await runScript(admin, id)).success).toBe(true);

      await unclaim(admin, id);
      const unclaimed = await runScript(admin, id);
      expect(unclaimed.success).toBe(false);
      expect(unclaimed.error).toMatch(/no author on record/i);

      const claimed = await send(writer, 'post', '/v1/automation/claim-all', {});
      expect(claimed.status).toBe(200);
      expect(claimed.body.data.claimed).toBeGreaterThanOrEqual(1);

      const run = await runScript(admin, id);
      expect(run.success).toBe(false);
      expect(run.error).toContain('Insufficient scope: core.credentials:read');
    } finally {
      for (const id of ids) await send(admin, 'delete', `/v1/automation/delete/${id}`);
      if (credentialId) await send(admin, 'delete', `/v1/credentials/delete/${credentialId}`);
    }
  });

  test('Claim all on the Automations page gives an unclaimed script its access back', async ({ browser, page }) => {
    test.setTimeout(180_000);
    const admin = await signInAdmin(browser);
    await waitForTool(admin, 'patch_automation_code');
    const ids: number[] = [];
    let credentialId = 0;

    try {
      const credential = await send(admin, 'post', '/v1/credentials/add', { appId: APP_ID, username: 'alice', password: SECRET });
      credentialId = credential.body.data.id;
      const id = await createScript(admin, 'e2e unclaimed script', CREDENTIALS_SCRIPT, ids);
      await unclaim(admin, id);
      expect((await runScript(admin, id)).error).toMatch(/no author on record/i);

      await loginAsAdmin(page);
      await page.goto('/ui/automations');
      const banner = page.getByTestId('automations-claim-banner');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('no author on record');

      await test.step('cancelling the confirmation claims nothing', async () => {
        await page.getByTestId('claim-all-button').click();
        await expect(page.getByRole('dialog')).toContainText('run with your permissions');
        await page.getByRole('button', { name: 'Cancel' }).click();
        await expect(banner).toBeVisible();
        expect((await runScript(admin, id)).error).toMatch(/no author on record/i);
      });

      await test.step('confirming claims it for the signed-in user', async () => {
        await page.getByTestId('claim-all-button').click();
        await page.getByTestId('confirm-dialog-confirm').click();
        await expect(page.getByText(/^Claimed \d+ automations?$/)).toBeVisible();
        await expect(banner).toBeHidden();

        const run = await runScript(admin, id);
        expect(run.error).toBeUndefined();
        expect(run.success).toBe(true);
      });
    } finally {
      for (const id of ids) await send(admin, 'delete', `/v1/automation/delete/${id}`);
      if (credentialId) await send(admin, 'delete', `/v1/credentials/delete/${credentialId}`);
    }
  });
});
