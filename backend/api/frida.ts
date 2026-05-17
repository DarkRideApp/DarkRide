import { eq, desc, and, sql } from 'drizzle-orm';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join, resolve } from 'path';
import { getDataRoot } from '../config/paths';
import { registerEndpoint } from './api-service';
import { fridaScripts, fridaReleases } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { FridaReleaseManager } from '../services/frida-release-manager';
import type { PythonBridgeManager } from '../services/python-bridge';
import type { DeviceManager } from '../services/device-manager';
import type { GadgetInjector } from '../services/gadget-injector';
import { createLoggers } from '../logs';
import { CATEGORY_LABELS, seedFridaScriptLibrary } from '../services/frida-script-library';
import { callFridaBridge as callFridaBridgeShared } from '../services/frida-bridge';

const execAsync = promisify(exec);
const { log, error: logError } = createLoggers('frida');

export function registerFridaEndpoints(db: AppDatabase, releaseManager: FridaReleaseManager, bridgeManager: PythonBridgeManager, deviceManager?: DeviceManager): void {
  // --- Script CRUD ---

  // GET /v1/frida/scripts — list all scripts, optionally filter by targetApp query param
  registerEndpoint('GET', '/v1/frida/scripts', (req, res) => {
    const targetApp = req.query.targetApp as string | undefined;
    let rows;
    if (targetApp) {
      rows = db.select().from(fridaScripts).where(eq(fridaScripts.targetApp, targetApp)).orderBy(desc(fridaScripts.updatedAt)).all();
    } else {
      rows = db.select().from(fridaScripts).orderBy(desc(fridaScripts.updatedAt)).all();
    }
    res.json({ success: true, data: rows });
  }, { requires: ['core.frida:read'] });

  // GET /v1/frida/scripts/categories — MUST be before :id route
  registerEndpoint('GET', '/v1/frida/scripts/categories', (_req, res) => {
    const rows = db.select({
      category: fridaScripts.category,
      count: sql<number>`count(*)`,
    }).from(fridaScripts).where(eq(fridaScripts.isBuiltin, true)).groupBy(fridaScripts.category).all();

    const result: Record<string, { count: number; label: string }> = {};
    for (const row of rows) {
      if (row.category) {
        result[row.category] = {
          count: row.count,
          label: CATEGORY_LABELS[row.category] || row.category,
        };
      }
    }
    res.json({ success: true, data: result });
  }, { requires: ['core.frida:read'] });

  // POST /v1/frida/scripts/reseed — force re-seed library scripts
  registerEndpoint('POST', '/v1/frida/scripts/reseed', (_req, res) => {
    seedFridaScriptLibrary(db);
    const rows = db.select().from(fridaScripts).orderBy(desc(fridaScripts.updatedAt)).all();
    res.json({ success: true, data: rows });
  }, { requires: ['core.frida:manage'] });

  // GET /v1/frida/scripts/:id
  registerEndpoint('GET', '/v1/frida/scripts/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const script = db.select().from(fridaScripts).where(eq(fridaScripts.id, id)).all()[0];
    if (!script) {
      res.status(404).json({ success: false, error: 'Script not found' });
      return;
    }
    res.json({ success: true, data: script });
  }, { requires: ['core.frida:read'] });

  // POST /v1/frida/scripts — create
  registerEndpoint('POST', '/v1/frida/scripts', (req, res) => {
    const { name, code, targetApp, description, category } = req.body;
    if (!name || !code) {
      res.status(400).json({ success: false, error: 'name and code are required' });
      return;
    }
    const now = new Date();
    db.insert(fridaScripts).values({ name, code, targetApp: targetApp || null, description: description || null, category: category || null, createdAt: now, updatedAt: now }).run();
    const script = db.select().from(fridaScripts).orderBy(desc(fridaScripts.id)).all()[0];
    res.json({ success: true, data: script });
  }, { requires: ['core.frida:manage'] });

  // PUT /v1/frida/scripts/:id — update
  registerEndpoint('PUT', '/v1/frida/scripts/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = db.select().from(fridaScripts).where(eq(fridaScripts.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Script not found' });
      return;
    }
    const { name, code, targetApp, description, category } = req.body;
    db.update(fridaScripts).set({
      ...(name !== undefined ? { name } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(targetApp !== undefined ? { targetApp } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(category !== undefined ? { category } : {}),
      updatedAt: new Date(),
    }).where(eq(fridaScripts.id, id)).run();
    const updated = db.select().from(fridaScripts).where(eq(fridaScripts.id, id)).all()[0];
    res.json({ success: true, data: updated });
  }, { requires: ['core.frida:manage'] });

  // DELETE /v1/frida/scripts/:id
  registerEndpoint('DELETE', '/v1/frida/scripts/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = db.select().from(fridaScripts).where(eq(fridaScripts.id, id)).all()[0];
    if (existing?.isBuiltin) {
      res.status(400).json({ success: false, error: 'Cannot delete builtin library scripts' });
      return;
    }
    db.delete(fridaScripts).where(eq(fridaScripts.id, id)).run();
    res.json({ success: true });
  }, { requires: ['core.frida:manage'] });

  // --- Release Management ---

  // GET /v1/frida/releases
  registerEndpoint('GET', '/v1/frida/releases', (_req, res) => {
    const releases = db.select().from(fridaReleases).orderBy(desc(fridaReleases.id)).all();
    res.json({ success: true, data: releases });
  }, { requires: ['core.frida:read'] });

  // POST /v1/frida/releases/sync
  registerEndpoint('POST', '/v1/frida/releases/sync', async (_req, res) => {
    await releaseManager.syncReleases();
    const releases = db.select().from(fridaReleases).orderBy(desc(fridaReleases.id)).all();
    res.json({ success: true, data: releases });
  }, { requires: ['core.frida:manage'] });

  // POST /v1/frida/releases/:version/download
  registerEndpoint('POST', '/v1/frida/releases/:version/download', async (req, res) => {
    try {
      const binPath = await releaseManager.downloadVersion(req.params.version);
      res.json({ success: true, data: { version: req.params.version, path: binPath } });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }, { requires: ['core.frida:manage'] });

  // DELETE /v1/frida/releases/:version
  registerEndpoint('DELETE', '/v1/frida/releases/:version', (req, res) => {
    releaseManager.deleteVersion(req.params.version);
    res.json({ success: true });
  }, { requires: ['core.frida:manage'] });

  // --- Device Operations (through Python bridge) ---
  // callFridaBridge is exported from services/frida-bridge so the AI tool
  // definitions can call it directly (without looping through HTTP and
  // hitting the host's auth middleware as unauthenticated).
  const callFridaBridge = (deviceId: string, method: string, params: Record<string, any> = {}) =>
    callFridaBridgeShared(bridgeManager, deviceId, method, params);

  registerEndpoint('GET', '/v1/frida/status/:deviceId', async (req, res) => {
    try {
      const apps = await callFridaBridge(req.params.deviceId, 'frida_list_apps', {});
      res.json({ success: true, data: { status: 'running', appCount: apps.length } });
    } catch {
      res.json({ success: true, data: { status: 'stopped' } });
    }
  }, { requires: ['core.frida:read'] });

  registerEndpoint('POST', '/v1/frida/start/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId;
    const version = (req.body?.version as string) || releaseManager.getDefaultVersion();
    try {
      // Wake & unlock the device if needed
      try { await callFridaBridge(deviceId, 'wakeAndUnlock', {}); } catch {}

      // Skip binary push + restart if frida-server is already running and responsive
      try {
        const testResult = await callFridaBridge(deviceId, 'frida_list_apps', {});
        if (testResult && Array.isArray(testResult)) {
          log(`frida-server already running on ${deviceId} — skipping restart`);
          res.json({ success: true, data: { status: 'already-running', apps: testResult.length } });
          return;
        }
      } catch {
        // Server not running — proceed with start
      }

      // Resolve version — 'auto' matches the Python frida package version
      const resolved = releaseManager.resolveVersion(version);
      if (!resolved) {
        res.status(400).json({ success: false, error: `No Frida version available (requested: ${version}). Sync releases first.` });
        return;
      }

      // Ensure this version exists in the release DB (auto-resolved version
      // might not have been synced yet) and download if needed
      await releaseManager.ensureVersion(resolved);

      // Push frida-server binary to device
      const localPath = releaseManager.getBinaryPath(resolved);
      log(`Pushing frida-server ${resolved} to ${deviceId}...`);
      await execAsync(`adb -s ${deviceId} push "${localPath}" /data/local/tmp/frida-server`, { timeout: 30000 });
      await execAsync(`adb -s ${deviceId} shell chmod 755 /data/local/tmp/frida-server`, { timeout: 5000 });

      const result = await callFridaBridge(deviceId, 'frida_start_server', {});
      res.json({ success: true, data: { ...result, version: resolved } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.frida:manage'] });

  registerEndpoint('POST', '/v1/frida/stop/:deviceId', async (req, res) => {
    try {
      const result = await callFridaBridge(req.params.deviceId, 'frida_stop_server', {});
      deviceManager?.markIdle(req.params.deviceId);
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.frida:manage'] });

  registerEndpoint('POST', '/v1/frida/spawn/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId;
    const { bundleId, scripts, code, mode, pid } = req.body;
    try {
      // Combine inline code with any named scripts
      let combinedCode = '';
      if (scripts) {
        const scriptNames = Array.isArray(scripts) ? scripts : [scripts];
        for (const name of scriptNames) {
          const script = db.select().from(fridaScripts).where(eq(fridaScripts.name, name)).all()[0];
          if (script) combinedCode += script.code + '\n';
        }
      }
      if (typeof code === 'string' && code.trim()) {
        combinedCode += code;
      }
      // Mark device as busy so standby timer doesn't put it to sleep
      deviceManager?.markBusy(deviceId);
      const bridgeMethod = mode === 'controlled' ? 'frida_spawn_controlled' : 'frida_run';
      const params = {
        bundle_id: bundleId,
        code: combinedCode,
        mode: mode === 'controlled' ? undefined : (mode || 'spawn'),
        pid,
      };

      // Retry on transient Frida errors — server may not be fully ready or process may have crashed
      let lastErr: any;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const result = await callFridaBridge(deviceId, bridgeMethod, params);
          res.json({ success: true, data: result });
          return;
        } catch (err: any) {
          lastErr = err;
          const isRetryable = err.message?.includes('need Gadget')
            || err.message?.includes('unable to find process')
            || err.message?.includes('Bad access')
            || err.message?.includes('crashed');
          if (isRetryable) {
            log(`Spawn attempt ${attempt + 1} failed (server not ready), retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          throw err; // Non-retryable error
        }
      }
      throw lastErr;
    } catch (err: any) {
      deviceManager?.markIdle(deviceId);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.frida:manage'] });

  registerEndpoint('GET', '/v1/frida/apps/:deviceId', async (req, res) => {
    try {
      const apps = await callFridaBridge(req.params.deviceId, 'frida_list_apps', {});
      res.json({ success: true, data: apps });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.frida:read'] });

  registerEndpoint('GET', '/v1/frida/messages/:deviceId', async (req, res) => {
    const since = parseInt(req.query.since as string || '0');
    try {
      const result = await callFridaBridge(req.params.deviceId, 'frida_get_messages', { since });
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.frida:read'] });
}

export function registerFridaGadgetEndpoints(injector: GadgetInjector): void {
  // POST /v1/frida/gadget/inject
  registerEndpoint('POST', '/v1/frida/gadget/inject', async (req, res) => {
    const { packageName, versionCode, fridaVersion } = req.body;
    if (!packageName) {
      res.status(400).json({ success: false, error: 'packageName is required' });
      return;
    }
    try {
      const result = await injector.inject(packageName, versionCode, fridaVersion);
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.frida:manage'] });

  // GET /v1/frida/gadget/injected
  registerEndpoint('GET', '/v1/frida/gadget/injected', (_req, res) => {
    res.json({ success: true, data: injector.listInjected() });
  }, { requires: ['core.frida:read'] });

  // DELETE /v1/frida/gadget/injected/:id
  registerEndpoint('DELETE', '/v1/frida/gadget/injected/:id', (req, res) => {
    injector.deleteInjected(parseInt(req.params.id));
    res.json({ success: true });
  }, { requires: ['core.frida:manage'] });

  // POST /v1/frida/gadget/install/:deviceId
  registerEndpoint('POST', '/v1/frida/gadget/install/:deviceId', async (req, res) => {
    const { injectedApkId } = req.body;
    const deviceId = req.params.deviceId;
    if (!injectedApkId) {
      res.status(400).json({ success: false, error: 'injectedApkId is required' });
      return;
    }
    try {
      const row = injector.listInjected().find(r => r.id === injectedApkId);
      if (!row) {
        res.status(404).json({ success: false, error: 'Injected APK not found' });
        return;
      }
      const apkPath = resolve(join(getDataRoot(), 'apks-injected'), row.filename);
      // Uninstall original (ignore failure)
      try { await execAsync(`adb -s ${deviceId} uninstall ${row.packageName}`, { timeout: 15000 }); } catch {}
      // Install injected APK
      await execAsync(`adb -s ${deviceId} install "${apkPath}"`, { timeout: 60000 });
      res.json({ success: true, data: { packageName: row.packageName, fridaVersion: row.fridaVersion } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.frida:manage'] });
}
