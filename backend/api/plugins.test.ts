import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerPluginEndpoints } from './plugins';
import { getDataRoot } from '../config/paths';
import type { PluginManager } from '../plugins/plugin-manager';
import type { PluginStateManager } from '../services/plugin-state-manager';
import type { PluginInstaller, InstallResult } from '../services/plugin-installer';
import type { PluginSourceManager, MarketplacePlugin, SourceFetchResult } from '../services/plugin-source-manager';
import type { PluginVerifier, VerificationResult, SignablePlugin } from '../services/plugin-verifier';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockBroadcastToAll = vi.fn();
vi.mock('../websocket/index', () => ({
  broadcastToAll: (...args: any[]) => mockBroadcastToAll(...args),
}));

const mockDropPluginTables = vi.fn();
const mockListPluginTables = vi.fn(() => [] as string[]);
vi.mock('../db/plugin-migrator', () => ({
  dropPluginTables: (...args: any[]) => mockDropPluginTables(...args),
  listPluginTables: (...args: any[]) => mockListPluginTables(...args),
  applyPluginMigrations: vi.fn(),
  backfillPluginMigrationsFromJournal: vi.fn(),
}));

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const utimesSyncSpy = vi.fn();

const rmSyncSpy = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    readFileSync: (path: string, enc?: string) => {
      if (path.includes('package.json')) {
        return JSON.stringify({ version: '1.5.0' });
      }
      return actual.readFileSync(path, enc);
    },
    utimesSync: (...args: any[]) => utimesSyncSpy(...args),
    rmSync: (...args: any[]) => rmSyncSpy(...args),
  };
});

vi.mock('../config/paths', () => ({
  getDataRoot: vi.fn(() => '/mock/data'),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockPluginManager(metadata: any[] = []): PluginManager {
  return {
    getPluginMetadata: vi.fn().mockReturnValue(metadata),
  } as any;
}

function createMockStateManager(overrides: Partial<Record<keyof PluginStateManager, any>> = {}): PluginStateManager {
  return {
    getAll: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    isEnabled: vi.fn().mockReturnValue(false),
    setEnabled: vi.fn(),
    setVersion: vi.fn(),
    setLastError: vi.fn(),
    upsert: vi.fn(),
    upsertManagedPending: vi.fn(),
    remove: vi.fn(),
    reconcile: vi.fn(),
    ...overrides,
  } as any;
}

function createMockInstaller(overrides: Partial<Record<keyof PluginInstaller, any>> = {}): PluginInstaller {
  return {
    install: vi.fn().mockResolvedValue({ success: true }),
    installManaged: vi.fn().mockResolvedValue({ success: true, pkgName: 'mock-plugin', resolvedRef: null }),
    uninstall: vi.fn().mockResolvedValue({ success: true }),
    update: vi.fn().mockResolvedValue({ success: true }),
    getLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
    isCompatible: vi.fn().mockReturnValue(true),
    ...overrides,
  } as any;
}

function createMockVerifier(overrides: Partial<Record<keyof PluginVerifier, any>> = {}): PluginVerifier {
  return {
    verify: vi.fn().mockReturnValue({ status: 'unsigned' } as VerificationResult),
    checkInstallPermission: vi.fn().mockReturnValue('allow'),
    canonicalize: vi.fn().mockReturnValue('{}'),
    verifyContents: vi.fn().mockReturnValue({ ok: true, pinned: false }),
    getTrustedKeys: vi.fn().mockReturnValue([]),
    addTrustedKey: vi.fn(),
    removeTrustedKey: vi.fn(),
    ...overrides,
  } as any;
}

function createMockSourceManager(overrides: Partial<Record<keyof PluginSourceManager, any>> = {}): PluginSourceManager {
  return {
    getAll: vi.fn().mockReturnValue([
      {
        id: 1,
        name: 'DarkRide Official',
        type: 'registry',
        url: 'https://plugins.darkride.app/plugins.json',
        authToken: null,
        enabled: true,
        isDefault: true,
        priority: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]),
    getEnabled: vi.fn().mockReturnValue([]),
    add: vi.fn().mockReturnValue(2),
    update: vi.fn(),
    remove: vi.fn(),
    fetchAll: vi.fn().mockResolvedValue([]),
    fetchRegistry: vi.fn().mockResolvedValue([]),
    fetchGitRepo: vi.fn().mockResolvedValue(null),
    getCacheFetchedAt: vi.fn().mockReturnValue(null),
    getCachedPlugins: vi.fn().mockReturnValue([]),
    ...overrides,
  } as any;
}

function createMockPluginInstallsRepo() {
  return {
    record: vi.fn(),
    remove: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getMissingDirs: vi.fn().mockReturnValue([]),
  } as any;
}

function createApp(
  pluginManager: PluginManager,
  stateManager?: PluginStateManager,
  installer?: PluginInstaller,
  sourceManager?: PluginSourceManager,
  verifier?: PluginVerifier,
  pluginInstallsRepo?: ReturnType<typeof createMockPluginInstallsRepo>,
  rawSqlite?: any,
) {
  clearEndpoints();
  registerPluginEndpoints(pluginManager, stateManager, installer, sourceManager, verifier, pluginInstallsRepo, rawSqlite);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

/**
 * Create a real on-disk fixture so the install endpoint's dynamic require()
 * picks up a definition with the desired runtime name.
 */
function setupInstalledPlugin(
  dataRoot: string,
  npmPackage: string,
  runtimeName: string,
  version = '1.0.0',
  dependencies: string[] = [],
) {
  const pkgDir = join(dataRoot, 'installed-plugins', 'node_modules', npmPackage);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: npmPackage, version }),
  );
  writeFileSync(
    join(pkgDir, 'darkride-plugin.js'),
    `module.exports = { name: ${JSON.stringify(runtimeName)}, dependencies: ${JSON.stringify(dependencies)}, register() {} };\n`,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

/**
 * Normalise a path to forward slashes before matching. These assertions look
 * for scoped package segments like `@darkride/plugin-a`, but the path is joined
 * natively, so on Windows the scope separator is a backslash and the match
 * silently failed.
 */
function posixPath(p: unknown): string {
  return String(p).split('\\').join('/');
}

describe('Plugin API Endpoints', () => {
  let pluginManager: PluginManager;
  let stateManager: PluginStateManager;
  let installer: PluginInstaller;
  let sourceManager: PluginSourceManager;
  let pluginInstallsRepo: ReturnType<typeof createMockPluginInstallsRepo>;
  let app: express.Express;
  let tmpDataRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDataRoot = mkdtempSync(join(tmpdir(), 'plugins-api-test-'));
    vi.mocked(getDataRoot).mockReturnValue(tmpDataRoot);
    pluginManager = createMockPluginManager();
    stateManager = createMockStateManager();
    installer = createMockInstaller();
    sourceManager = createMockSourceManager();
    pluginInstallsRepo = createMockPluginInstallsRepo();
    app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);
  });

  afterEach(() => {
    rmSync(tmpDataRoot, { recursive: true, force: true });
  });

  // ─── GET /v1/plugins/installed ────────────────────────────────────────────

  describe('GET /v1/plugins/installed', () => {
    it('returns merged plugin state and metadata', async () => {
      const stateRows = [
        { name: 'plugin-a', enabled: true, installedVia: 'workspace', version: '1.0.0', description: null, author: null, npmPackage: null },
        { name: 'plugin-b', enabled: false, installedVia: 'npm', version: '2.0.0', description: 'A B plugin', author: 'test', npmPackage: '@darkride/plugin-b' },
      ];
      const metadata = [
        { name: 'plugin-a', version: '1.0.0', nav: [], pages: [], settings: [], commands: [], notificationEvents: [], tools: [], toolContexts: [] },
      ];

      pluginManager = createMockPluginManager(metadata);
      stateManager = createMockStateManager({ getAll: vi.fn().mockReturnValue(stateRows) });
      app = createApp(pluginManager, stateManager, installer);

      const res = await request(app).get('/v1/plugins/installed');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.plugins).toHaveLength(2);

      const pluginA = res.body.data.plugins.find((p: any) => p.name === 'plugin-a');
      expect(pluginA.loaded).toBe(true);
      expect(pluginA.metadata).toBeDefined();
      expect(pluginA.metadata.name).toBe('plugin-a');

      const pluginB = res.body.data.plugins.find((p: any) => p.name === 'plugin-b');
      expect(pluginB.loaded).toBe(false);
      expect(pluginB.metadata).toBeNull();
    });

    it('includes darkrideVersion in response', async () => {
      const res = await request(app).get('/v1/plugins/installed');

      expect(res.status).toBe(200);
      expect(res.body.data.darkrideVersion).toBe('1.5.0');
    });

    it('returns 501 when stateManager not provided', async () => {
      app = createApp(pluginManager, undefined, installer);

      const res = await request(app).get('/v1/plugins/installed');

      expect(res.status).toBe(501);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not available');
    });

    it('reports updateAvailable + latestVersion when marketplace has a newer version', async () => {
      stateManager.getAll = vi.fn().mockReturnValue([
        { name: 'sample', enabled: true, installedVia: 'managed', version: '1.0.0', npmPackage: '@example.org/plugin-sample' },
      ]);
      pluginManager.getPluginMetadata = vi.fn().mockReturnValue([]);
      sourceManager.getCachedPlugins = vi.fn().mockReturnValue([
        { name: 'sample', npmPackage: '@example.org/plugin-sample', latestVersion: '1.0.1' },
      ]);

      const res = await request(app).get('/v1/plugins/installed');

      expect(res.status).toBe(200);
      const plugin = res.body.data.plugins[0];
      expect(plugin.updateAvailable).toBe(true);
      expect(plugin.latestVersion).toBe('1.0.1');
    });

    it('reports updateAvailable=false when marketplace has same or older version', async () => {
      stateManager.getAll = vi.fn().mockReturnValue([
        { name: 'sample', enabled: true, installedVia: 'managed', version: '1.0.1', npmPackage: '@example.org/plugin-sample' },
      ]);
      pluginManager.getPluginMetadata = vi.fn().mockReturnValue([]);
      sourceManager.getCachedPlugins = vi.fn().mockReturnValue([
        { name: 'sample', npmPackage: '@example.org/plugin-sample', latestVersion: '1.0.1' },
      ]);

      const res = await request(app).get('/v1/plugins/installed');

      expect(res.body.data.plugins[0].updateAvailable).toBe(false);
      expect(res.body.data.plugins[0].latestVersion).toBe('1.0.1');
    });

    it('reports updateAvailable=false when plugin is not in marketplace', async () => {
      stateManager.getAll = vi.fn().mockReturnValue([
        { name: 'orphan', enabled: true, installedVia: 'managed', version: '1.0.0', npmPackage: '@x/orphan' },
      ]);
      pluginManager.getPluginMetadata = vi.fn().mockReturnValue([]);
      sourceManager.getCachedPlugins = vi.fn().mockReturnValue([]);

      const res = await request(app).get('/v1/plugins/installed');

      expect(res.body.data.plugins[0].updateAvailable).toBe(false);
      expect(res.body.data.plugins[0].latestVersion).toBeUndefined();
    });

    it('handles missing sourceManager gracefully (no marketplace configured)', async () => {
      const appNoSource = createApp(pluginManager, stateManager, installer);
      stateManager.getAll = vi.fn().mockReturnValue([
        { name: 'sample', enabled: true, installedVia: 'managed', version: '1.0.0', npmPackage: '@example.org/plugin-sample' },
      ]);
      pluginManager.getPluginMetadata = vi.fn().mockReturnValue([]);

      const res = await request(appNoSource).get('/v1/plugins/installed');

      expect(res.status).toBe(200);
      expect(res.body.data.plugins[0].updateAvailable).toBe(false);
    });
  });

  // ─── POST /v1/plugins/:name/enable ────────────────────────────────────────

  describe('POST /v1/plugins/:name/enable', () => {
    beforeEach(() => {
      stateManager = createMockStateManager({
        get: vi.fn().mockImplementation((n: string) =>
          n === 'plugin-a' || n === '@darkride/plugin-x'
            ? { name: n, enabled: false, installedVia: 'managed' }
            : undefined,
        ),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);
    });

    it('enables a plugin and returns restartRequired', async () => {
      const res = await request(app).post('/v1/plugins/plugin-a/enable');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(stateManager.setEnabled).toHaveBeenCalledWith('plugin-a', true);
    });

    it('handles URL-encoded plugin names', async () => {
      const res = await request(app).post('/v1/plugins/%40darkride%2Fplugin-x/enable');

      expect(res.status).toBe(200);
      expect(stateManager.setEnabled).toHaveBeenCalledWith('@darkride/plugin-x', true);
    });

    it('returns 404 when the plugin does not exist (no ghost restart state)', async () => {
      const res = await request(app).post('/v1/plugins/does-not-exist/enable');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(stateManager.setEnabled).not.toHaveBeenCalled();
    });

    it('returns 501 without stateManager', async () => {
      app = createApp(pluginManager, undefined, installer);

      const res = await request(app).post('/v1/plugins/plugin-a/enable');

      expect(res.status).toBe(501);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── POST /v1/plugins/:name/disable ───────────────────────────────────────

  describe('POST /v1/plugins/:name/disable', () => {
    beforeEach(() => {
      stateManager = createMockStateManager({
        get: vi.fn().mockImplementation((n: string) =>
          n === 'plugin-a'
            ? { name: n, enabled: true, installedVia: 'managed' }
            : undefined,
        ),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);
    });

    it('disables a plugin and returns restartRequired', async () => {
      const res = await request(app).post('/v1/plugins/plugin-a/disable');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(stateManager.setEnabled).toHaveBeenCalledWith('plugin-a', false);
    });

    it('returns 404 when the plugin does not exist (no ghost restart state)', async () => {
      const res = await request(app).post('/v1/plugins/does-not-exist/disable');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(stateManager.setEnabled).not.toHaveBeenCalled();
    });

    it('returns 501 without stateManager', async () => {
      app = createApp(pluginManager, undefined, installer);

      const res = await request(app).post('/v1/plugins/plugin-a/disable');

      expect(res.status).toBe(501);
    });
  });

  // ─── POST /v1/plugins/install ─────────────────────────────────────────────

  describe('POST /v1/plugins/install', () => {
    it('installs a valid npm package', async () => {
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-b', 'demo-plugin-b', '1.0.1');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, pkgName: '@darkride/plugin-demo-b', resolvedRef: null, npmShasum: null });

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({ npmPackage: '@darkride/plugin-demo-b' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(res.body.name).toBe('demo-plugin-b');
      expect(installer.installManaged).toHaveBeenCalledWith('@darkride/plugin-demo-b', null);
      expect(pluginInstallsRepo.record).toHaveBeenCalledWith(expect.objectContaining({
        name: 'demo-plugin-b',
        npmPackage: '@darkride/plugin-demo-b',
      }));
      expect(stateManager.upsertManagedPending).toHaveBeenCalledWith('demo-plugin-b', '@darkride/plugin-demo-b', null);
      // The install endpoint must persist the just-installed version so the
      // UI shows the correct version immediately rather than waiting for
      // the next boot's reconcile. (1.5.0 is from the file-level fs mock.)
      expect(stateManager.setVersion).toHaveBeenCalledWith('demo-plugin-b', '1.5.0');
    });

    it('rejects install when name collides with an existing workspace plugin', async () => {
      // The installed plugin's definition.name is 'demo-plugin-b'. Stage
      // a workspace plugin already registered under the same name. The
      // install endpoint must refuse with 409 and roll back the npm
      // install rather than letting the managed copy run migrations on
      // a name the workspace copy will continue serving.
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-b', 'demo-plugin-b', '1.0.1');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, pkgName: '@darkride/plugin-demo-b', resolvedRef: null, npmShasum: null,
      });
      stateManager = createMockStateManager({
        get: vi.fn().mockImplementation((n: string) =>
          n === 'demo-plugin-b'
            ? { name: 'demo-plugin-b', installedVia: 'workspace', enabled: true }
            : undefined,
        ),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({ npmPackage: '@darkride/plugin-demo-b' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.nameCollision).toEqual({ existingSource: 'workspace' });
      expect(pluginInstallsRepo.record).not.toHaveBeenCalled();
      expect(stateManager.upsertManagedPending).not.toHaveBeenCalled();
      // Rollback removed the tarball.
      const rolledBack = rmSyncSpy.mock.calls.find(c => posixPath(c[0]).endsWith('@darkride/plugin-demo-b'));
      expect(rolledBack).toBeDefined();
    });

    it('allows install when name collides with a previous "missing" managed install (re-install path)', async () => {
      // A user who uninstalled a managed plugin (or whose plugin row is
      // marked 'missing' after a failed boot) should be able to
      // reinstall the same name. The 'missing' state is the recovery
      // path, not a collision.
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-b', 'demo-plugin-b', '1.0.1');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, pkgName: '@darkride/plugin-demo-b', resolvedRef: null, npmShasum: null,
      });
      stateManager = createMockStateManager({
        get: vi.fn().mockImplementation((n: string) =>
          n === 'demo-plugin-b'
            ? { name: 'demo-plugin-b', installedVia: 'missing', enabled: false }
            : undefined,
        ),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({ npmPackage: '@darkride/plugin-demo-b' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pluginInstallsRepo.record).toHaveBeenCalled();
    });

    it('rejects missing npmPackage body field', async () => {
      const res = await request(app)
        .post('/v1/plugins/install')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('npmPackage');
    });

    it('returns error when npm install fails', async () => {
      installer = createMockInstaller({
        installManaged: vi.fn().mockResolvedValue({ success: false, error: 'npm ERR! 404 Not Found' }),
      });
      app = createApp(pluginManager, stateManager, installer, undefined, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({ npmPackage: '@darkride/nonexistent' });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('404');
    });

    it('returns 501 without stateManager or installer', async () => {
      app = createApp(pluginManager, undefined, undefined);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({ npmPackage: '@darkride/plugin-foo' });

      expect(res.status).toBe(501);
    });

    it('rejects install when plugin has unmet plugin dependencies', async () => {
      // demo-plugin-a declares dependencies: ['demo-plugin-b']; maps is not installed.
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-a', 'demo-plugin-a', '1.0.0', ['demo-plugin-b']);
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, pkgName: '@darkride/plugin-demo-a', resolvedRef: null,
      });
      // stateManager.get returns undefined for 'demo-plugin-b' → unmet
      stateManager = createMockStateManager({ get: vi.fn().mockReturnValue(undefined) });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({ npmPackage: '@darkride/plugin-demo-a' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/dependenc/i);
      expect(res.body.missingDependencies).toEqual(['demo-plugin-b']);
      // Must NOT record the install or update state — install is rolled back.
      expect(pluginInstallsRepo.record).not.toHaveBeenCalled();
      expect(stateManager.upsertManagedPending).not.toHaveBeenCalled();
    });

    it('allows install when dependency is already in state (even if missing on disk)', async () => {
      // maps was previously installed but went missing. Still counts as "going
      // to be there" — user can reinstall maps and they boot together.
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-a', 'demo-plugin-a', '1.0.0', ['demo-plugin-b']);
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, pkgName: '@darkride/plugin-demo-a', resolvedRef: null,
      });
      // 'demo-plugin-b' is in state but missing — must still allow the install.
      stateManager = createMockStateManager({
        get: vi.fn().mockImplementation((name: string) =>
          name === 'demo-plugin-b' ? { name: 'demo-plugin-b', installedVia: 'managed', enabled: true } : undefined,
        ),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({ npmPackage: '@darkride/plugin-demo-a' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects install when dependency state is missing (not just absent)', async () => {
      // maps is in state DB with installedVia: 'missing'. Treated as not present.
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-a', 'demo-plugin-a', '1.0.0', ['demo-plugin-b']);
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, pkgName: '@darkride/plugin-demo-a', resolvedRef: null,
      });
      stateManager = createMockStateManager({
        get: vi.fn().mockImplementation((name: string) =>
          name === 'demo-plugin-b' ? { name: 'demo-plugin-b', installedVia: 'missing', enabled: true } : undefined,
        ),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({ npmPackage: '@darkride/plugin-demo-a' });

      expect(res.status).toBe(400);
      expect(res.body.missingDependencies).toEqual(['demo-plugin-b']);
    });

    it('content pin: refuses install when signed npmShasum mismatches installed', async () => {
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-b', 'demo-plugin-b', '1.0.1');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, pkgName: '@darkride/plugin-demo-b', resolvedRef: null, npmShasum: 'sha512-installed',
      });
      const verifier = createMockVerifier({
        verifyContents: vi.fn().mockReturnValue({ ok: false, reason: 'installed npm shasum (sha512-installed) does not match signed shasum (sha512-signed)' }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({
          npmPackage: '@darkride/plugin-demo-b',
          pluginData: {
            name: 'demo-plugin-b', npmPackage: '@darkride/plugin-demo-b', npmShasum: 'sha512-signed',
            signature: 'a-signature', signedBy: 'darkride-official',
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.contentMismatch).toBe(true);
      expect(res.body.error).toMatch(/shasum|content tampering/i);
      // Verify a rollback was attempted: installer was called, but record/state never.
      expect(installer.installManaged).toHaveBeenCalled();
      expect(pluginInstallsRepo.record).not.toHaveBeenCalled();
      expect(stateManager.upsertManagedPending).not.toHaveBeenCalled();
    });

    it('content pin: allows install when signed npmShasum matches installed', async () => {
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-b', 'demo-plugin-b', '1.0.1');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, pkgName: '@darkride/plugin-demo-b', resolvedRef: null, npmShasum: 'sha512-matching',
      });
      const verifier = createMockVerifier({
        verifyContents: vi.fn().mockReturnValue({ ok: true, pinned: true }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({
          npmPackage: '@darkride/plugin-demo-b',
          pluginData: {
            name: 'demo-plugin-b', npmPackage: '@darkride/plugin-demo-b', npmShasum: 'sha512-matching',
            signature: 'a-signature', signedBy: 'darkride-official',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pluginInstallsRepo.record).toHaveBeenCalled();
    });

    it('content pin: skipped when signed manifest has no pin (legacy signature)', async () => {
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-b', 'demo-plugin-b', '1.0.1');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, pkgName: '@darkride/plugin-demo-b', resolvedRef: null, npmShasum: 'sha512-anything',
      });
      const verifyContentsSpy = vi.fn().mockReturnValue({ ok: true, pinned: false });
      const verifier = createMockVerifier({ verifyContents: verifyContentsSpy });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({
          npmPackage: '@darkride/plugin-demo-b',
          pluginData: {
            name: 'demo-plugin-b', npmPackage: '@darkride/plugin-demo-b',
            signature: 'legacy-signature', signedBy: 'darkride-official',
            // no npmShasum, no gitRef → legacy signature; install proceeds without content check
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Endpoint must not have called verifyContents at all — the gate is skipped early.
      expect(verifyContentsSpy).not.toHaveBeenCalled();
    });

    it('optionalDependencies do NOT block install when absent', async () => {
      // demo-plugin-a declares optionalDependencies: ['unrelated']; no deps.
      // Optional means "use if present" — install should succeed regardless.
      const pkgDir = join(tmpDataRoot, 'installed-plugins', 'node_modules', '@darkride/plugin-demo-a');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@darkride/plugin-demo-a', version: '1.0.0' }));
      writeFileSync(
        join(pkgDir, 'darkride-plugin.js'),
        `module.exports = { name: 'demo-plugin-a', dependencies: [], optionalDependencies: ['unrelated'], register() {} };\n`,
      );
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, pkgName: '@darkride/plugin-demo-a', resolvedRef: null,
      });
      stateManager = createMockStateManager({ get: vi.fn().mockReturnValue(undefined) });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({ npmPackage: '@darkride/plugin-demo-a' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ─── POST /v1/plugins/uninstall ───────────────────────────────────────────

  describe('POST /v1/plugins/uninstall', () => {
    it('uninstalls an npm plugin', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'plugin-a',
          npmPackage: '@darkride/plugin-a',
          installedVia: 'npm',
        }),
      });
      app = createApp(pluginManager, stateManager, installer);

      const res = await request(app)
        .post('/v1/plugins/uninstall')
        .send({ name: 'plugin-a' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(installer.uninstall).toHaveBeenCalledWith('@darkride/plugin-a');
      expect(stateManager.remove).toHaveBeenCalledWith('plugin-a');
    });

    it('workspace plugin returns 400 (removed by code change, not UI)', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'local-plugin',
          npmPackage: null,
          installedVia: 'workspace',
        }),
      });
      app = createApp(pluginManager, stateManager, installer);

      const res = await request(app)
        .post('/v1/plugins/uninstall')
        .send({ name: 'local-plugin' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Workspace/);
      expect(installer.uninstall).not.toHaveBeenCalled();
      expect(stateManager.remove).not.toHaveBeenCalled();
    });

    it('returns 404 for unknown plugin', async () => {
      const res = await request(app)
        .post('/v1/plugins/uninstall')
        .send({ name: 'nonexistent-plugin' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/v1/plugins/uninstall')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('returns 500 when npm uninstall fails', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'plugin-a',
          npmPackage: '@darkride/plugin-a',
          installedVia: 'npm',
        }),
      });
      installer = createMockInstaller({
        uninstall: vi.fn().mockResolvedValue({ success: false, error: 'Permission denied' }),
      });
      app = createApp(pluginManager, stateManager, installer);

      const res = await request(app)
        .post('/v1/plugins/uninstall')
        .send({ name: 'plugin-a' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Permission denied');
      expect(stateManager.remove).not.toHaveBeenCalled();
    });
  });

  // ─── POST /v1/plugins/uninstall — by installedVia ────────────────────────

  describe('POST /v1/plugins/uninstall — by installedVia', () => {
    const mockRawSqlite = {} as any;

    beforeEach(() => {
      vi.clearAllMocks();
      pluginManager = createMockPluginManager();
      stateManager = createMockStateManager();
      installer = createMockInstaller();
      sourceManager = createMockSourceManager();
      pluginInstallsRepo = createMockPluginInstallsRepo();
    });

    // Safe default: preserveData omitted ⇒ true. Tables + data/plugins/<name>/ are kept.

    it('managed (default safe): removes install + state, KEEPS tables and data dir', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({ name: '@x/p', enabled: false, installedVia: 'managed', npmPackage: '@x/p' }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).post('/v1/plugins/uninstall').send({ name: '@x/p' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(pluginInstallsRepo.remove).toHaveBeenCalledWith('@x/p');
      expect(stateManager.remove).toHaveBeenCalledWith('@x/p');
      expect(mockDropPluginTables).not.toHaveBeenCalled();
      // rmSync should run once on the npm pkgDir but NOT on data/plugins/<name>/
      const dataPluginsCalls = rmSyncSpy.mock.calls.filter((c: any[]) => posixPath(c[0]).includes('/plugins/@x/p'));
      expect(dataPluginsCalls).toHaveLength(0);
    });

    it('missing (default safe): removes state + repo row, KEEPS tables and data dir, no installer call', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({ name: 'p', enabled: false, installedVia: 'missing' }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).post('/v1/plugins/uninstall').send({ name: 'p' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(false);
      expect(installer.uninstall).not.toHaveBeenCalled();
      expect(pluginInstallsRepo.remove).toHaveBeenCalledWith('p');
      expect(stateManager.remove).toHaveBeenCalledWith('p');
      expect(mockDropPluginTables).not.toHaveBeenCalled();
      expect(rmSyncSpy).not.toHaveBeenCalled();
    });

    it('npm (default safe): runs installer.uninstall, KEEPS tables and data dir', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({ name: 'p', enabled: true, installedVia: 'npm', npmPackage: '@x/p' }),
      });
      (installer.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).post('/v1/plugins/uninstall').send({ name: 'p' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(installer.uninstall).toHaveBeenCalledWith('@x/p');
      expect(stateManager.remove).toHaveBeenCalledWith('p');
      expect(mockDropPluginTables).not.toHaveBeenCalled();
      expect(rmSyncSpy).not.toHaveBeenCalled();
    });

    // Destructive path: preserveData: false. Tables dropped, data dir removed.

    it('managed (preserveData: false): rm -rf prefix, removes plugin_installs + plugin_state rows, drops tables', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({ name: '@x/p', enabled: false, installedVia: 'managed', npmPackage: '@x/p' }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).post('/v1/plugins/uninstall').send({ name: '@x/p', preserveData: false });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(pluginInstallsRepo.remove).toHaveBeenCalledWith('@x/p');
      expect(stateManager.remove).toHaveBeenCalledWith('@x/p');
      expect(mockDropPluginTables).toHaveBeenCalledWith(mockRawSqlite, '@x/p');
    });

    it('missing (preserveData: false): removes state + repo row, drops tables, no installer call', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({ name: 'p', enabled: false, installedVia: 'missing' }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).post('/v1/plugins/uninstall').send({ name: 'p', preserveData: false });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(false);
      expect(installer.uninstall).not.toHaveBeenCalled();
      expect(pluginInstallsRepo.remove).toHaveBeenCalledWith('p');
      expect(stateManager.remove).toHaveBeenCalledWith('p');
      expect(mockDropPluginTables).toHaveBeenCalledWith(mockRawSqlite, 'p');
    });

    it('npm (preserveData: false): drops tables and rm -rf data/plugins/<name>/', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({ name: 'p', enabled: true, installedVia: 'npm', npmPackage: '@x/p' }),
      });
      (installer.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).post('/v1/plugins/uninstall').send({ name: 'p', preserveData: false });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(installer.uninstall).toHaveBeenCalledWith('@x/p');
      expect(stateManager.remove).toHaveBeenCalledWith('p');
      expect(mockDropPluginTables).toHaveBeenCalledWith(mockRawSqlite, 'p');
    });

    it('workspace: returns 400', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({ name: 'p', enabled: true, installedVia: 'workspace' }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).post('/v1/plugins/uninstall').send({ name: 'p' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Workspace/);
    });
  });

  // ─── GET /v1/plugins/:name/uninstall-footprint ───────────────────────────

  describe('GET /v1/plugins/:name/uninstall-footprint', () => {
    const mockRawSqlite = {} as any;

    it('returns table list, data size, and npm package', async () => {
      mockListPluginTables.mockReturnValue(['plugin_p__a', 'plugin_p__b']);
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({ name: 'p', installedVia: 'managed', npmPackage: '@x/p' }),
      });
      // Set up a real on-disk data/plugins/p so size scan can run.
      const dir = join(tmpDataRoot, 'plugins', 'p');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'a.bin'), Buffer.alloc(1024));
      writeFileSync(join(dir, 'b.bin'), Buffer.alloc(2048));

      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).get('/v1/plugins/p/uninstall-footprint');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tables).toEqual(['plugin_p__a', 'plugin_p__b']);
      expect(res.body.data.fileStorageBytes).toBe(3072);
      expect(res.body.data.npmPackage).toBe('@x/p');
    });

    it('reports zero bytes when data dir does not exist', async () => {
      mockListPluginTables.mockReturnValue([]);
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({ name: 'absent', installedVia: 'missing', npmPackage: null }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).get('/v1/plugins/absent/uninstall-footprint');

      expect(res.status).toBe(200);
      expect(res.body.data.tables).toEqual([]);
      expect(res.body.data.fileStorageBytes).toBe(0);
      expect(res.body.data.npmPackage).toBeNull();
    });

    it('returns 404 for unknown plugin', async () => {
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo, mockRawSqlite);

      const res = await request(app).get('/v1/plugins/unknown/uninstall-footprint');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── POST /v1/plugins/update ──────────────────────────────────────────────

  describe('POST /v1/plugins/update', () => {
    it('updates an npm plugin', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'plugin-a',
          npmPackage: '@darkride/plugin-a',
          installedVia: 'npm',
        }),
      });
      app = createApp(pluginManager, stateManager, installer);

      const res = await request(app)
        .post('/v1/plugins/update')
        .send({ name: 'plugin-a' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(installer.update).toHaveBeenCalledWith('@darkride/plugin-a');
    });

    it('returns 400 for non-npm plugin (no npmPackage)', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'local-plugin',
          npmPackage: null,
          installedVia: 'workspace',
        }),
      });
      app = createApp(pluginManager, stateManager, installer);

      const res = await request(app)
        .post('/v1/plugins/update')
        .send({ name: 'local-plugin' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('no associated npm package');
    });

    it('returns 404 for unknown plugin', async () => {
      const res = await request(app)
        .post('/v1/plugins/update')
        .send({ name: 'nonexistent' });

      expect(res.status).toBe(404);
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/v1/plugins/update')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('refuses update when the new tarball renames definition.name', async () => {
      // The update endpoint must NOT silently absorb a definition.name
      // change — that would orphan the prior plugin_state row's data
      // (settings, tables, peer references) when the next boot's
      // reconcile inserts a fresh row under the new name. The author
      // should bump the npm package name to switch identities; we
      // refuse rather than corrupt the user's state.
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-renamed', 'new-runtime-name', '2.0.0');
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'old-runtime-name',
          npmPackage: '@darkride/plugin-renamed',
          installedVia: 'managed',
        }),
      });
      installer = createMockInstaller({
        update: vi.fn().mockResolvedValue({
          success: true,
          pkgName: '@darkride/plugin-renamed',
          resolvedRef: null,
          npmShasum: null,
        }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/update')
        .send({ name: 'old-runtime-name' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.identityChanged).toEqual({
        previous: 'old-runtime-name',
        attempted: 'new-runtime-name',
      });
      // setVersion must NOT have been called — the rename gate fires
      // before version persistence, leaving the state row clean.
      expect(stateManager.setVersion).not.toHaveBeenCalled();
    });

    it('allows update when definition.name is unchanged', async () => {
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-stable', 'stable-name', '2.0.0');
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'stable-name',
          npmPackage: '@darkride/plugin-stable',
          installedVia: 'managed',
        }),
      });
      installer = createMockInstaller({
        update: vi.fn().mockResolvedValue({
          success: true,
          pkgName: '@darkride/plugin-stable',
          resolvedRef: null,
          npmShasum: null,
        }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/update')
        .send({ name: 'stable-name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('content pin: rolls back and 400s when post-update artefact does not match signed manifest', async () => {
      // Simulates registry tampering between install and update: the
      // marketplace's signed manifest pins npmShasum=A but the freshly
      // installed package has npmShasum=B. The endpoint must roll back
      // the new tarball off disk and return 400.
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'plugin-a',
          npmPackage: '@darkride/plugin-a',
          installedVia: 'managed',
        }),
      });
      installer = createMockInstaller({
        update: vi.fn().mockResolvedValue({
          success: true,
          pkgName: '@darkride/plugin-a',
          resolvedRef: null,
          npmShasum: 'sha512-TAMPERED',
        }),
      });
      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockResolvedValue([{
          sourceName: 'official',
          sourceType: 'registry',
          plugins: [{
            name: 'plugin-a',
            npmPackage: '@darkride/plugin-a',
            signature: 'a-signature',
            signedBy: 'darkride-official',
            npmShasum: 'sha512-LEGITIMATE',
          }],
        }]),
      });
      const verifyContentsSpy = vi.fn().mockReturnValue({
        ok: false,
        reason: 'npm shasum mismatch (signed sha512-LEGITIMATE, installed sha512-TAMPERED)',
      });
      const verifier = createMockVerifier({ verifyContents: verifyContentsSpy });
      rmSyncSpy.mockReset();
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/update')
        .send({ name: 'plugin-a' });

      // Debug-friendly order: assert call shape first so a wrong-branch failure
      // tells you which gate the request slipped through.
      expect(verifyContentsSpy).toHaveBeenCalledWith(
        { npmShasum: 'sha512-LEGITIMATE', gitRef: undefined },
        { npmShasum: 'sha512-TAMPERED', gitRef: undefined },
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.contentMismatch).toBe(true);
      // Rollback called rmSync on the post-update tarball dir (fs.rmSync is
      // a spy in this suite; this confirms the rollback path was reached
      // with the expected target).
      const rollbackCall = rmSyncSpy.mock.calls.find(c => posixPath(c[0]).endsWith('@darkride/plugin-a'));
      expect(rollbackCall).toBeDefined();
      expect((rollbackCall as any)[1]).toEqual(expect.objectContaining({ recursive: true, force: true }));
    });

    it('content pin: skipped when marketplace has no signed entry for this plugin', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'plugin-a',
          npmPackage: '@darkride/plugin-a',
          installedVia: 'managed',
        }),
      });
      installer = createMockInstaller({
        update: vi.fn().mockResolvedValue({
          success: true,
          pkgName: '@darkride/plugin-a',
          resolvedRef: null,
          npmShasum: 'sha512-anything',
        }),
      });
      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockResolvedValue([{
          sourceName: 'official',
          sourceType: 'registry',
          plugins: [], // not present in marketplace
        }]),
      });
      const verifyContentsSpy = vi.fn();
      const verifier = createMockVerifier({ verifyContents: verifyContentsSpy });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/update')
        .send({ name: 'plugin-a' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(verifyContentsSpy).not.toHaveBeenCalled();
    });

    it('returns 500 when npm update fails', async () => {
      stateManager = createMockStateManager({
        get: vi.fn().mockReturnValue({
          name: 'plugin-a',
          npmPackage: '@darkride/plugin-a',
          installedVia: 'npm',
        }),
      });
      installer = createMockInstaller({
        update: vi.fn().mockResolvedValue({ success: false, error: 'Network error' }),
      });
      app = createApp(pluginManager, stateManager, installer);

      const res = await request(app)
        .post('/v1/plugins/update')
        .send({ name: 'plugin-a' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Network error');
    });

    it('returns 501 without stateManager or installer', async () => {
      app = createApp(pluginManager, undefined, undefined);

      const res = await request(app)
        .post('/v1/plugins/update')
        .send({ name: 'plugin-a' });

      expect(res.status).toBe(501);
    });
  });

  // ─── GET /v1/plugins/marketplace ──────────────────────────────────────────
  // Now delegates to sourceManager.fetchAll() — multi-source endpoint.

  describe('GET /v1/plugins/marketplace', () => {
    it('returns marketplace data from sourceManager', async () => {
      const fetchResults: SourceFetchResult[] = [
        {
          sourceName: 'Official',
          sourceType: 'registry',
          plugins: [
            {
              name: 'Maps',
              displayName: 'Maps Plugin',
              description: 'Map overlay plugin',
              author: 'DarkRide',
              repo: '',
              latestVersion: '1.0.0',
              category: 'theme-parks',
              license: 'MIT',
              npmPackage: '@darkride/plugin-demo-b',
              source: 'Official',
            },
          ],
        },
      ];

      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockResolvedValue(fetchResults),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.plugins).toHaveLength(1);
      expect(res.body.data.plugins[0].name).toBe('Maps');
      expect(sourceManager.fetchAll).toHaveBeenCalledTimes(1);
    });

    it('returns 502 when sourceManager.fetchAll throws', async () => {
      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockRejectedValue(new Error('Network unreachable')),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Network unreachable');
    });

    it('returns 501 without sourceManager', async () => {
      app = createApp(pluginManager, stateManager, installer, undefined);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(501);
      expect(res.body.error).toContain('not available');
    });
  });

  // ─── POST /v1/system/restart ──────────────────────────────────────────────

  describe('POST /v1/system/restart', () => {
    it('returns success message without actually exiting', async () => {
      const originalExit = process.exit;
      process.exit = vi.fn() as any;

      const res = await request(app).post('/v1/system/restart');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('restarting');
      expect(mockBroadcastToAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'system:restarting' }),
      );

      process.exit = originalExit;
    });

    it('touches index.ts before exit to trigger tsx watch restart', async () => {
      const originalExit = process.exit;
      process.exit = vi.fn() as any;
      utimesSyncSpy.mockReset();

      await request(app).post('/v1/system/restart');
      // Wait for the 500ms setTimeout to fire
      await new Promise((r) => setTimeout(r, 600));

      expect(utimesSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining('index.ts'),
        expect.any(Date),
        expect.any(Date),
      );

      process.exit = originalExit;
    });
  });

  // ─── Legacy endpoints ─────────────────────────────────────────────────────

  describe('GET /v1/plugins/registry', () => {
    it('returns plugin metadata', async () => {
      const metadata = [
        { name: 'plugin-a', version: '1.0.0', nav: [], pages: [], settings: [], commands: [], notificationEvents: [], tools: [], toolContexts: [] },
      ];
      pluginManager = createMockPluginManager(metadata);
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/registry');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('plugin-a');
    });
  });

  describe('GET /v1/plugins/list', () => {
    it('returns plugin name and version only', async () => {
      const metadata = [
        { name: 'plugin-a', version: '1.0.0', nav: [], pages: [], settings: [], commands: [], notificationEvents: [], tools: [], toolContexts: [] },
        { name: 'plugin-b', version: '2.0.0', nav: [], pages: [], settings: [], commands: [], notificationEvents: [], tools: [], toolContexts: [] },
      ];
      pluginManager = createMockPluginManager(metadata);
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/list');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { name: 'plugin-a', version: '1.0.0' },
        { name: 'plugin-b', version: '2.0.0' },
      ]);
    });
  });

  // ─── GET /v1/plugins/sources ────────────────────────────────────────────

  describe('GET /v1/plugins/sources', () => {
    it('returns all sources with auth tokens masked', async () => {
      sourceManager = createMockSourceManager({
        getAll: vi.fn().mockReturnValue([
          {
            id: 1,
            name: 'DarkRide Official',
            type: 'registry',
            url: 'https://plugins.darkride.app/plugins.json',
            authToken: null,
            enabled: true,
            isDefault: true,
            priority: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: 2,
            name: 'Private Registry',
            type: 'registry',
            url: 'https://private.example.com/plugins.json',
            authToken: 'secret-token-12345',
            enabled: true,
            isDefault: false,
            priority: 10,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/sources');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);

      // Default source has no token — should be null
      expect(res.body.data[0].authToken).toBeNull();
      // Private source has a token — should be masked
      expect(res.body.data[1].authToken).toBe('********');
      expect(res.body.data[1].name).toBe('Private Registry');
    });

    it('includes default source', async () => {
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/sources');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].isDefault).toBe(true);
      expect(res.body.data[0].name).toBe('DarkRide Official');
    });

    it('returns 501 without sourceManager', async () => {
      app = createApp(pluginManager, stateManager, installer, undefined);

      const res = await request(app).get('/v1/plugins/sources');

      expect(res.status).toBe(501);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not available');
    });
  });

  // ─── POST /v1/plugins/sources ───────────────────────────────────────────

  describe('POST /v1/plugins/sources', () => {
    it('creates a registry source', async () => {
      const res = await request(app)
        .post('/v1/plugins/sources')
        .send({ name: 'My Registry', type: 'registry', url: 'https://example.com/plugins.json' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBe(2);
      expect(sourceManager.add).toHaveBeenCalledWith({
        name: 'My Registry',
        type: 'registry',
        url: 'https://example.com/plugins.json',
        authToken: undefined,
      });
    });

    it('creates a git source', async () => {
      const res = await request(app)
        .post('/v1/plugins/sources')
        .send({ name: 'My Plugin', type: 'git', url: 'https://gitea.local/org/my-plugin.git' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBe(2);
      expect(sourceManager.add).toHaveBeenCalledWith({
        name: 'My Plugin',
        type: 'git',
        url: 'https://gitea.local/org/my-plugin.git',
        authToken: undefined,
      });
    });

    it('creates a source with auth token', async () => {
      const res = await request(app)
        .post('/v1/plugins/sources')
        .send({
          name: 'Private Reg',
          type: 'registry',
          url: 'https://private.example.com/plugins.json',
          authToken: 'ghp_secret123',
        });

      expect(res.status).toBe(200);
      expect(sourceManager.add).toHaveBeenCalledWith(
        expect.objectContaining({ authToken: 'ghp_secret123' }),
      );
    });

    it('rejects invalid type', async () => {
      const res = await request(app)
        .post('/v1/plugins/sources')
        .send({ name: 'Bad', type: 'npm', url: 'https://example.com' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('type must be');
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post('/v1/plugins/sources')
        .send({ type: 'registry', url: 'https://example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name, type, and url are required');
    });

    it('rejects missing url', async () => {
      const res = await request(app)
        .post('/v1/plugins/sources')
        .send({ name: 'Test', type: 'registry' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name, type, and url are required');
    });

    it('rejects missing type', async () => {
      const res = await request(app)
        .post('/v1/plugins/sources')
        .send({ name: 'Test', url: 'https://example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name, type, and url are required');
    });

    it('returns 400 when sourceManager.add throws (duplicate URL)', async () => {
      sourceManager = createMockSourceManager({
        add: vi.fn().mockImplementation(() => { throw new Error('A source with this URL already exists'); }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app)
        .post('/v1/plugins/sources')
        .send({ name: 'Dup', type: 'registry', url: 'https://plugins.darkride.app/plugins.json' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already exists');
    });

    it('returns 501 without sourceManager', async () => {
      app = createApp(pluginManager, stateManager, installer, undefined);

      const res = await request(app)
        .post('/v1/plugins/sources')
        .send({ name: 'X', type: 'registry', url: 'https://example.com' });

      expect(res.status).toBe(501);
    });
  });

  // ─── PUT /v1/plugins/sources/:id ────────────────────────────────────────

  describe('PUT /v1/plugins/sources/:id', () => {
    it('updates source name for non-default source', async () => {
      sourceManager = createMockSourceManager({
        getAll: vi.fn().mockReturnValue([
          { id: 1, name: 'DarkRide Official', type: 'registry', url: 'https://plugins.darkride.app/plugins.json', authToken: null, enabled: true, isDefault: true, priority: 0 },
          { id: 2, name: 'Custom', type: 'registry', url: 'https://custom.example.com', authToken: null, enabled: true, isDefault: false, priority: 10 },
        ]),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app)
        .put('/v1/plugins/sources/2')
        .send({ name: 'Renamed Source' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(sourceManager.update).toHaveBeenCalledWith(2, {
        name: 'Renamed Source',
        url: undefined,
        authToken: undefined,
        enabled: undefined,
      });
    });

    it('updates source enabled status for non-default source', async () => {
      sourceManager = createMockSourceManager({
        getAll: vi.fn().mockReturnValue([
          { id: 1, name: 'DarkRide Official', type: 'registry', url: 'https://plugins.darkride.app/plugins.json', authToken: null, enabled: true, isDefault: true, priority: 0 },
          { id: 2, name: 'Custom', type: 'registry', url: 'https://custom.example.com', authToken: null, enabled: true, isDefault: false, priority: 10 },
        ]),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app)
        .put('/v1/plugins/sources/2')
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(sourceManager.update).toHaveBeenCalledWith(2, expect.objectContaining({ enabled: false }));
    });

    it('rejects changing default source URL', async () => {
      const res = await request(app)
        .put('/v1/plugins/sources/1')
        .send({ url: 'https://evil.com/plugins.json' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot modify the default source');
      expect(sourceManager.update).not.toHaveBeenCalled();
    });

    it('rejects name change for default source', async () => {
      const res = await request(app)
        .put('/v1/plugins/sources/1')
        .send({ name: 'Renamed Default' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Cannot modify the default source');
      expect(sourceManager.update).not.toHaveBeenCalled();
    });

    it('allows auth token change for default source', async () => {
      const res = await request(app)
        .put('/v1/plugins/sources/1')
        .send({ authToken: 'new-token-123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(sourceManager.update).toHaveBeenCalledWith(1, { authToken: 'new-token-123' });
    });

    it('rejects non-numeric id', async () => {
      const res = await request(app)
        .put('/v1/plugins/sources/abc')
        .send({ name: 'Test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid source id');
    });

    it('returns 501 without sourceManager', async () => {
      app = createApp(pluginManager, stateManager, installer, undefined);

      const res = await request(app)
        .put('/v1/plugins/sources/1')
        .send({ name: 'X' });

      expect(res.status).toBe(501);
    });
  });

  // ─── DELETE /v1/plugins/sources/:id ─────────────────────────────────────

  describe('DELETE /v1/plugins/sources/:id', () => {
    it('deletes a non-default source', async () => {
      const res = await request(app).delete('/v1/plugins/sources/2');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(sourceManager.remove).toHaveBeenCalledWith(2);
    });

    it('rejects deleting the default source', async () => {
      sourceManager = createMockSourceManager({
        remove: vi.fn().mockImplementation(() => {
          throw new Error('Cannot remove the default source');
        }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).delete('/v1/plugins/sources/1');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot remove the default source');
    });

    it('rejects non-numeric id', async () => {
      const res = await request(app).delete('/v1/plugins/sources/xyz');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid source id');
    });

    it('returns 501 without sourceManager', async () => {
      app = createApp(pluginManager, stateManager, installer, undefined);

      const res = await request(app).delete('/v1/plugins/sources/2');

      expect(res.status).toBe(501);
    });
  });

  // ─── GET /v1/plugins/marketplace (multi-source) ─────────────────────────

  describe('GET /v1/plugins/marketplace (multi-source)', () => {
    it('returns aggregated plugins from all sources', async () => {
      const fetchResults: SourceFetchResult[] = [
        {
          sourceName: 'DarkRide Official',
          sourceType: 'registry',
          plugins: [
            {
              name: 'demo-plugin-b',
              displayName: 'Maps Plugin',
              description: 'Map overlay plugin',
              author: 'DarkRide',
              repo: 'DarkRideApp/plugin-maps',
              latestVersion: '2.0.0',
              category: 'theme-parks',
              license: 'MIT',
              npmPackage: '@darkride/plugin-demo-b',
              source: 'DarkRide Official',
            },
          ],
        },
        {
          sourceName: 'Private Git',
          sourceType: 'git',
          plugins: [
            {
              name: 'custom-tool',
              displayName: 'Custom Tool',
              description: 'A private tool plugin',
              author: 'Internal',
              repo: '',
              latestVersion: '0.1.0',
              category: 'community',
              license: 'Proprietary',
              npmPackage: 'custom-tool',
              source: 'Private Git',
              installUrl: 'git+https://gitea.local/org/custom-tool.git',
            },
          ],
        },
      ];

      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockResolvedValue(fetchResults),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sources).toHaveLength(2);
      expect(res.body.data.plugins).toHaveLength(2);
      expect(res.body.data.plugins[0].name).toBe('demo-plugin-b');
      expect(res.body.data.plugins[0].source).toBe('DarkRide Official');
      expect(res.body.data.plugins[1].name).toBe('custom-tool');
      expect(res.body.data.plugins[1].installUrl).toBe('git+https://gitea.local/org/custom-tool.git');
    });

    it('returns empty plugins array when no sources have plugins', async () => {
      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockResolvedValue([
          { sourceName: 'Empty', sourceType: 'registry', plugins: [] },
        ]),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(200);
      expect(res.body.data.plugins).toHaveLength(0);
      expect(res.body.data.sources).toHaveLength(1);
    });

    it('returns 501 without sourceManager', async () => {
      app = createApp(pluginManager, stateManager, installer, undefined);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(501);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not available');
    });

    it('returns 502 when fetchAll throws', async () => {
      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockRejectedValue(new Error('All sources unreachable')),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('All sources unreachable');
    });
  });

  // ─── POST /v1/plugins/sources/:id/test ──────────────────────────────────

  describe('POST /v1/plugins/sources/:id/test', () => {
    it('returns preview of plugins found from a registry source', async () => {
      const registryPlugins: MarketplacePlugin[] = [
        {
          name: 'demo-plugin-b',
          displayName: 'Maps',
          description: 'Map overlay',
          author: 'DarkRide',
          repo: '',
          latestVersion: '1.0.0',
          category: 'theme-parks',
          license: 'MIT',
          npmPackage: '@darkride/plugin-demo-b',
          source: 'DarkRide Official',
        },
      ];

      sourceManager = createMockSourceManager({
        getAll: vi.fn().mockReturnValue([
          { id: 1, name: 'DarkRide Official', type: 'registry', url: 'https://plugins.darkride.app/plugins.json', authToken: null, enabled: true, isDefault: true, priority: 0 },
        ]),
        fetchRegistry: vi.fn().mockResolvedValue(registryPlugins),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).post('/v1/plugins/sources/1/test');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.plugins).toHaveLength(1);
      expect(res.body.data.plugins[0].name).toBe('demo-plugin-b');
    });

    it('returns preview of plugin found from a git source', async () => {
      const gitPlugin: MarketplacePlugin = {
        name: 'custom-tool',
        displayName: 'Custom Tool',
        description: 'A private plugin',
        author: 'Dev',
        repo: '',
        latestVersion: '0.1.0',
        category: 'community',
        license: 'MIT',
        npmPackage: 'custom-tool',
        source: 'My Git',
        installUrl: 'git+https://gitea.local/org/custom-tool.git',
      };

      sourceManager = createMockSourceManager({
        getAll: vi.fn().mockReturnValue([
          { id: 3, name: 'My Git', type: 'git', url: 'https://gitea.local/org/custom-tool.git', authToken: null, enabled: true, isDefault: false, priority: 10 },
        ]),
        fetchGitRepo: vi.fn().mockResolvedValue(gitPlugin),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).post('/v1/plugins/sources/3/test');

      expect(res.status).toBe(200);
      expect(res.body.data.plugins).toHaveLength(1);
      expect(res.body.data.plugins[0].installUrl).toContain('git+');
    });

    it('returns empty array when git source has no plugin entry', async () => {
      sourceManager = createMockSourceManager({
        getAll: vi.fn().mockReturnValue([
          { id: 3, name: 'My Git', type: 'git', url: 'https://gitea.local/org/not-a-plugin.git', authToken: null, enabled: true, isDefault: false, priority: 10 },
        ]),
        fetchGitRepo: vi.fn().mockResolvedValue(null),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).post('/v1/plugins/sources/3/test');

      expect(res.status).toBe(200);
      expect(res.body.data.plugins).toHaveLength(0);
    });

    it('returns 404 for unknown source id', async () => {
      const res = await request(app).post('/v1/plugins/sources/999/test');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 502 when fetch fails', async () => {
      sourceManager = createMockSourceManager({
        getAll: vi.fn().mockReturnValue([
          { id: 1, name: 'Broken', type: 'registry', url: 'https://down.example.com', authToken: null, enabled: true, isDefault: true, priority: 0 },
        ]),
        fetchRegistry: vi.fn().mockRejectedValue(new Error('HTTP 503')),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).post('/v1/plugins/sources/1/test');

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('503');
    });

    it('rejects non-numeric id', async () => {
      const res = await request(app).post('/v1/plugins/sources/abc/test');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid source id');
    });

    it('returns 501 without sourceManager', async () => {
      app = createApp(pluginManager, stateManager, installer, undefined);

      const res = await request(app).post('/v1/plugins/sources/1/test');

      expect(res.status).toBe(501);
    });
  });

  // ─── Install verification flow ──────────────────────────────────────────

  describe('POST /v1/plugins/install (verification)', () => {
    let verifier: PluginVerifier;

    it('signed plugin installs without prompt', async () => {
      verifier = createMockVerifier({
        checkInstallPermission: vi.fn().mockReturnValue('allow'),
      });
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-demo-b', 'demo-plugin-b');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, pkgName: '@darkride/plugin-demo-b', resolvedRef: null });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({
          npmPackage: '@darkride/plugin-demo-b',
          pluginData: { name: '@darkride/plugin-demo-b', category: 'theme-parks', signature: 'abc123', signedBy: 'darkride-official' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(installer.installManaged).toHaveBeenCalledWith('@darkride/plugin-demo-b', null);
    });

    it('unsigned plugin returns confirmRequired: true', async () => {
      verifier = createMockVerifier({
        checkInstallPermission: vi.fn().mockReturnValue('prompt'),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({
          npmPackage: 'community-plugin',
          pluginData: { name: 'community-plugin', category: 'community' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.confirmRequired).toBe(true);
      expect(res.body.warning).toContain('not verified');
      expect(installer.install).not.toHaveBeenCalled();
    });

    it('unsigned plugin with confirmed: true proceeds with install', async () => {
      verifier = createMockVerifier({
        checkInstallPermission: vi.fn().mockReturnValue('prompt'),
      });
      setupInstalledPlugin(tmpDataRoot, 'community-plugin', 'community-plugin');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, pkgName: 'community-plugin', resolvedRef: null });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({
          npmPackage: 'community-plugin',
          pluginData: { name: 'community-plugin', category: 'community' },
          confirmed: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(installer.installManaged).toHaveBeenCalledWith('community-plugin', null);
    });

    it('unsigned auth-category plugin returns 403 with blocked: true', async () => {
      verifier = createMockVerifier({
        checkInstallPermission: vi.fn().mockReturnValue('block'),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({
          npmPackage: 'shady-auth-plugin',
          pluginData: { name: 'shady-auth-plugin', category: 'auth-providers' },
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.blocked).toBe(true);
      expect(res.body.error).toContain('must be signed');
      expect(installer.install).not.toHaveBeenCalled();
    });

    it('signed auth plugin installs normally', async () => {
      verifier = createMockVerifier({
        checkInstallPermission: vi.fn().mockReturnValue('allow'),
      });
      setupInstalledPlugin(tmpDataRoot, '@darkride/plugin-oidc', 'oidc');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, pkgName: '@darkride/plugin-oidc', resolvedRef: null });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({
          npmPackage: '@darkride/plugin-oidc',
          pluginData: { name: '@darkride/plugin-oidc', category: 'auth-providers', signature: 'valid-sig', signedBy: 'darkride-official' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restartRequired).toBe(true);
      expect(installer.installManaged).toHaveBeenCalledWith('@darkride/plugin-oidc', null);
    });

    it('install without verifier skips verification entirely', async () => {
      // No verifier passed — existing behavior
      setupInstalledPlugin(tmpDataRoot, 'any-plugin', 'any-plugin');
      (installer.installManaged as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, pkgName: 'any-plugin', resolvedRef: null });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined, pluginInstallsRepo);

      const res = await request(app)
        .post('/v1/plugins/install')
        .send({
          npmPackage: 'any-plugin',
          pluginData: { name: 'any-plugin', category: 'auth-providers' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(installer.installManaged).toHaveBeenCalledWith('any-plugin', null);
    });
  });

  // ─── Signing key management ─────────────────────────────────────────────

  describe('GET /v1/plugins/signing-keys', () => {
    it('returns key list', async () => {
      const mockKeys = [
        { id: 'darkride-official', publicKey: 'abc123==', label: 'DarkRide Official', builtIn: true, addedBy: null, createdAt: new Date('2026-01-01') },
        { id: 'custom-key', publicKey: 'def456==', label: 'My Org Key', builtIn: false, addedBy: 1, createdAt: new Date('2026-04-01') },
      ];
      const verifier = createMockVerifier({
        getTrustedKeys: vi.fn().mockReturnValue(mockKeys),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app).get('/v1/plugins/signing-keys');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toEqual({
        id: 'darkride-official',
        label: 'DarkRide Official',
        builtIn: true,
        createdAt: expect.anything(),
      });
      expect(res.body.data[1]).toEqual({
        id: 'custom-key',
        label: 'My Org Key',
        builtIn: false,
        createdAt: expect.anything(),
      });
      // Ensure publicKey and addedBy are not exposed
      expect(res.body.data[0].publicKey).toBeUndefined();
      expect(res.body.data[0].addedBy).toBeUndefined();
    });

    it('returns 501 without verifier', async () => {
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined);

      const res = await request(app).get('/v1/plugins/signing-keys');

      expect(res.status).toBe(501);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /v1/plugins/signing-keys', () => {
    it('adds a trusted key', async () => {
      const verifier = createMockVerifier();
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app)
        .post('/v1/plugins/signing-keys')
        .send({ id: 'my-org-key', publicKey: 'base64pubkey==', label: 'My Org Key' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(verifier.addTrustedKey).toHaveBeenCalledWith('my-org-key', 'base64pubkey==', 'My Org Key', undefined);
    });

    it('rejects missing fields', async () => {
      const verifier = createMockVerifier();
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app)
        .post('/v1/plugins/signing-keys')
        .send({ id: 'my-org-key' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('id, publicKey, and label required');
    });

    it('returns 400 when addTrustedKey throws (duplicate)', async () => {
      const verifier = createMockVerifier({
        addTrustedKey: vi.fn().mockImplementation(() => { throw new Error('UNIQUE constraint failed'); }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app)
        .post('/v1/plugins/signing-keys')
        .send({ id: 'existing-key', publicKey: 'abc==', label: 'Dup Key' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('UNIQUE constraint');
    });

    it('returns 501 without verifier', async () => {
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined);

      const res = await request(app)
        .post('/v1/plugins/signing-keys')
        .send({ id: 'key', publicKey: 'abc==', label: 'Key' });

      expect(res.status).toBe(501);
    });
  });

  describe('DELETE /v1/plugins/signing-keys/:id', () => {
    it('removes a non-built-in key', async () => {
      const verifier = createMockVerifier();
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app).delete('/v1/plugins/signing-keys/custom-key');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(verifier.removeTrustedKey).toHaveBeenCalledWith('custom-key');
    });

    it('rejects removing a built-in key', async () => {
      const verifier = createMockVerifier({
        removeTrustedKey: vi.fn().mockImplementation(() => { throw new Error('Cannot remove built-in key'); }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app).delete('/v1/plugins/signing-keys/darkride-official');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot remove built-in key');
    });

    it('returns 400 for unknown key', async () => {
      const verifier = createMockVerifier({
        removeTrustedKey: vi.fn().mockImplementation(() => { throw new Error('Key not found'); }),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app).delete('/v1/plugins/signing-keys/nonexistent');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Key not found');
    });

    it('returns 501 without verifier', async () => {
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined);

      const res = await request(app).delete('/v1/plugins/signing-keys/some-key');

      expect(res.status).toBe(501);
    });
  });

  // ─── Marketplace verification field ───────────────────────────────────────

  describe('GET /v1/plugins/marketplace (verification)', () => {
    it('includes verification field when verifier is present', async () => {
      const mapPlugin: MarketplacePlugin = {
        name: 'demo-plugin-b',
        displayName: 'Maps Plugin',
        description: 'Map overlay',
        author: 'DarkRide',
        repo: '',
        latestVersion: '2.0.0',
        category: 'theme-parks',
        license: 'MIT',
        npmPackage: '@darkride/plugin-demo-b',
        source: 'Official',
      };
      const fetchResults: SourceFetchResult[] = [
        { sourceName: 'Official', sourceType: 'registry', plugins: [mapPlugin] },
      ];

      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockResolvedValue(fetchResults),
      });
      const verifier = createMockVerifier({
        verify: vi.fn().mockReturnValue({ status: 'verified', signedBy: 'darkride-official', keyLabel: 'DarkRide Official' } as VerificationResult),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, verifier);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(200);
      expect(res.body.data.plugins).toHaveLength(1);
      expect(res.body.data.plugins[0].verification).toEqual({
        status: 'verified',
        signedBy: 'darkride-official',
        keyLabel: 'DarkRide Official',
      });
    });

    it('does not include verification field when verifier is absent', async () => {
      const mapPlugin: MarketplacePlugin = {
        name: 'demo-plugin-b',
        displayName: 'Maps Plugin',
        description: 'Map overlay',
        author: 'DarkRide',
        repo: '',
        latestVersion: '2.0.0',
        category: 'theme-parks',
        license: 'MIT',
        npmPackage: '@darkride/plugin-demo-b',
        source: 'Official',
      };
      const fetchResults: SourceFetchResult[] = [
        { sourceName: 'Official', sourceType: 'registry', plugins: [mapPlugin] },
      ];

      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockResolvedValue(fetchResults),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager, undefined);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(200);
      expect(res.body.data.plugins[0].verification).toBeUndefined();
    });
  });

  // ─── GET /v1/plugins/marketplace — fetchedAt ────────────────────────────

  describe('GET /v1/plugins/marketplace (fetchedAt)', () => {
    it('includes fetchedAt in response', async () => {
      const now = Date.now();
      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockResolvedValue([]),
        getCacheFetchedAt: vi.fn().mockReturnValue(now),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).get('/v1/plugins/marketplace');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.fetchedAt).toBe(now);
    });
  });

  // ─── POST /v1/plugins/marketplace/refresh ───────────────────────────────

  describe('POST /v1/plugins/marketplace/refresh', () => {
    it('busts cache and returns fresh data', async () => {
      const freshPlugins: MarketplacePlugin[] = [
        {
          name: 'fresh-plugin',
          displayName: 'Fresh Plugin',
          description: 'Freshly fetched',
          author: 'Test',
          repo: '',
          latestVersion: '1.0.0',
          category: 'community',
          license: 'MIT',
          npmPackage: 'fresh-plugin',
          source: 'Official',
        },
      ];
      const freshResults: SourceFetchResult[] = [
        { sourceName: 'Official', sourceType: 'registry', plugins: freshPlugins },
      ];
      const now = Date.now();

      sourceManager = createMockSourceManager({
        fetchAll: vi.fn().mockResolvedValue(freshResults),
        getCacheFetchedAt: vi.fn().mockReturnValue(now),
      });
      app = createApp(pluginManager, stateManager, installer, sourceManager);

      const res = await request(app).post('/v1/plugins/marketplace/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.plugins).toHaveLength(1);
      expect(res.body.data.plugins[0].name).toBe('fresh-plugin');
      expect(res.body.data.fetchedAt).toBe(now);
      expect(sourceManager.fetchAll).toHaveBeenCalledWith(true);
    });

    it('returns 501 without sourceManager', async () => {
      app = createApp(pluginManager, stateManager, installer, undefined);

      const res = await request(app).post('/v1/plugins/marketplace/refresh');

      expect(res.status).toBe(501);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not available');
    });
  });
});
