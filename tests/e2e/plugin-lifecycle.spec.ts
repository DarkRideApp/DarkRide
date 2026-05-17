import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { startServer, type TestServer } from '../../playwright/fixtures/server';
import { buildTestPluginBundle } from '../fixtures/build-test-plugin-bundle';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const ADMIN_USERNAME = 'e2e-admin';
const ADMIN_PASSWORD = 'e2e-test-password-123';

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function dbAt(path: string) {
  return new Database(path, { readonly: false });
}

async function login(request: any, baseUrl: string, existingCsrf?: string): Promise<string> {
  // If we have an existing CSRF token, include it — the Playwright request context
  // persists session cookies across tests, so a re-login POST while a valid session
  // exists needs X-CSRF-Token to pass csrfProtection middleware.
  const res = await request.post(`${baseUrl}/v1/auth/login`, {
    headers: existingCsrf ? { 'X-CSRF-Token': existingCsrf } : {},
    data: { providerId: 'core.local', credentials: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } },
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Login failed: ${data.error ?? JSON.stringify(data)}`);
  return data.csrfToken;
}

test.describe('Plugin lifecycle (Add Source → Install → Enable → Use → Disable → Uninstall → Cleanup)', () => {
  test.describe.configure({ mode: 'serial' });

  let server: TestServer;
  let bundlePath: string;
  let preInstallHostPkgSha: string;
  let preInstallHostLockSha: string;
  let csrf: string;

  test.beforeAll(async () => {
    bundlePath = buildTestPluginBundle();
    preInstallHostPkgSha = sha256File(join(PROJECT_ROOT, 'package.json'));
    preInstallHostLockSha = sha256File(join(PROJECT_ROOT, 'package-lock.json'));
    server = await startServer();
  });

  test.afterAll(async () => {
    if (server) await server.stop();
  });

  test('Phase 1 — Add Plugin Source', async ({ request }) => {
    csrf = await login(request, server.baseUrl);
    const res = await request.post(`${server.baseUrl}/v1/plugins/sources`, {
      headers: { 'X-CSRF-Token': csrf },
      data: { name: 'test-source', type: 'git', url: `git+file://${bundlePath}` },
    });
    expect(res.status()).toBe(200);
    const list = await (await request.get(`${server.baseUrl}/v1/plugins/sources`, { headers: { 'X-CSRF-Token': csrf } })).json();
    expect(list.data?.find((s: any) => s.name === 'test-source')).toBeTruthy();
  });

  test('Phase 2 — Install lands in data/installed-plugins/, host unchanged', async ({ request }) => {
    csrf = await login(request, server.baseUrl);
    const res = await request.post(`${server.baseUrl}/v1/plugins/install`, {
      headers: { 'X-CSRF-Token': csrf },
      data: {
        installUrl: `git+file://${bundlePath}`,
        pluginData: { source: 'test-source' },
        confirmed: true,  // bypass unsigned-plugin prompt
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.name).toBe('test-plugin');                 // runtime name returned

    expect(existsSync(join(server.dataDir, 'installed-plugins', 'node_modules', '@darkrideapp', 'plugin-test'))).toBe(true);

    const db = dbAt(server.dbPath);
    const installRow = db.prepare("SELECT * FROM plugin_installs WHERE name='test-plugin'").get() as any;
    expect(installRow).toBeTruthy();
    expect(installRow.npm_package).toBe('@darkrideapp/plugin-test');

    const stateRow = db.prepare("SELECT * FROM plugin_state WHERE name='test-plugin'").get() as any;
    expect(stateRow).toBeTruthy();
    expect(stateRow.enabled).toBe(0);
    expect(stateRow.installed_via).toBe('managed');
    expect(stateRow.npm_package).toBe('@darkrideapp/plugin-test');
    db.close();

    expect(sha256File(join(PROJECT_ROOT, 'package.json'))).toBe(preInstallHostPkgSha);
    expect(sha256File(join(PROJECT_ROOT, 'package-lock.json'))).toBe(preInstallHostLockSha);
  });

  test('Phase 3 — Plugin Not Available (pre-restart)', async ({ request }) => {
    // Re-login so we have auth — otherwise auth middleware rejects with 401
    // before routing, masking whether the route exists at all.
    csrf = await login(request, server.baseUrl);
    const ping = await request.get(`${server.baseUrl}/v1/test-plugin/ping`, {
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(ping.status()).toBe(404);

    const db = dbAt(server.dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name='plugin_test-plugin__counter'").all();
    expect(tables).toHaveLength(0);
    db.close();
  });

  test('Phase 4 — Restart + Enable; migration runs', async ({ request }) => {
    await server.restart();
    csrf = await login(request, server.baseUrl);

    const enableRes = await request.post(`${server.baseUrl}/v1/plugins/test-plugin/enable`, {
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(enableRes.status()).toBe(200);

    await server.restart();

    const db = dbAt(server.dbPath);
    const stateRow = db.prepare("SELECT enabled FROM plugin_state WHERE name='test-plugin'").get() as any;
    expect(stateRow.enabled).toBe(1);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name='plugin_test-plugin__counter'").all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  test('Phase 5 — Plugin Does A Thing', async ({ request }) => {
    csrf = await login(request, server.baseUrl);
    const ping = await request.get(`${server.baseUrl}/v1/test-plugin/ping`, {
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(ping.status()).toBe(200);
    expect(await ping.json()).toEqual({ pong: true });
  });

  test('Phase 6 — Disable; route gone, table remains', async ({ request }) => {
    csrf = await login(request, server.baseUrl);
    await request.post(`${server.baseUrl}/v1/plugins/test-plugin/disable`, {
      headers: { 'X-CSRF-Token': csrf },
    });
    await server.restart();
    // Pass current csrf so csrfProtection passes with the existing session cookie.
    csrf = await login(request, server.baseUrl, csrf);

    // Use auth so the 404 reflects the route being unregistered, not auth rejection.
    const ping = await request.get(`${server.baseUrl}/v1/test-plugin/ping`, {
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(ping.status()).toBe(404);

    const db = dbAt(server.dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name='plugin_test-plugin__counter'").all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  test('Phase 7 — Uninstall; everything gone', async ({ request }) => {
    csrf = await login(request, server.baseUrl);
    const res = await request.post(`${server.baseUrl}/v1/plugins/uninstall`, {
      headers: { 'X-CSRF-Token': csrf },
      data: { name: 'test-plugin' },
    });
    expect(res.status()).toBe(200);

    expect(existsSync(join(server.dataDir, 'installed-plugins', 'node_modules', '@darkrideapp', 'plugin-test'))).toBe(false);

    const db = dbAt(server.dbPath);
    expect((db.prepare("SELECT COUNT(*) as c FROM plugin_installs WHERE name='test-plugin'").get() as any).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as c FROM plugin_state WHERE name='test-plugin'").get() as any).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE name LIKE 'plugin_test__%'").get() as any).c).toBe(0);
    db.close();

    expect(existsSync(join(server.dataDir, 'plugins', 'test-plugin'))).toBe(false);
  });

  test('Phase 8 — Final cleanliness audit', async ({ request }) => {
    const db = dbAt(server.dbPath);
    expect((db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE name LIKE 'plugin_test__%'").get() as any).c).toBe(0);
    db.close();

    const scopeDir = join(server.dataDir, 'installed-plugins', 'node_modules', '@darkrideapp');
    if (existsSync(scopeDir)) {
      expect(readdirSync(scopeDir)).not.toContain('plugin-test');
    }

    csrf = await login(request, server.baseUrl);
    const list = await (await request.get(`${server.baseUrl}/v1/plugins/installed`, { headers: { 'X-CSRF-Token': csrf } })).json();
    // GET /v1/plugins/installed returns { success, data: { plugins, darkrideVersion } }
    const found = (list.data?.plugins ?? []).find((p: any) => p.name === 'test-plugin');
    expect(found).toBeFalsy();
  });

  test('Phase 9 — Re-install (idempotency)', async ({ request }) => {
    csrf = await login(request, server.baseUrl);
    const res = await request.post(`${server.baseUrl}/v1/plugins/install`, {
      headers: { 'X-CSRF-Token': csrf },
      data: {
        installUrl: `git+file://${bundlePath}`,
        pluginData: { source: 'test-source' },
        confirmed: true,  // bypass unsigned-plugin prompt
      },
    });
    expect(res.status()).toBe(200);

    expect(existsSync(join(server.dataDir, 'installed-plugins', 'node_modules', '@darkrideapp', 'plugin-test'))).toBe(true);

    const db = dbAt(server.dbPath);
    expect((db.prepare("SELECT COUNT(*) as c FROM plugin_installs WHERE name='test-plugin'").get() as any).c).toBe(1);
    db.close();
  });
});
