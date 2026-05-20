import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { applyMigrations } from '../db/migrator';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { PluginManager } from '../plugins/plugin-manager';
import { computeLoadOrder } from '../plugins/load-order';
import { AiToolRegistry } from '../services/ai-tools';
import * as schema from '../db/schema';
import type { NamespacedStorage } from '@darkrideapp/plugin-sdk';

export interface PluginTestHarness {
  /** Express app with plugin routes registered */
  app: express.Express;
  /** Drizzle DB instance (in-memory SQLite) */
  db: ReturnType<typeof drizzle>;
  /** Raw SQLite instance (for direct SQL and seed functions) */
  sqlite: Database.Database;
  /** Plugin manager with the plugin loaded */
  pluginManager: PluginManager;
  /** AI tool registry with plugin tools registered */
  toolRegistry: AiToolRegistry;
  /** Clean up resources. Returns a Promise when start:true was used (awaits stopAll). */
  cleanup(): void | Promise<void>;
}

export interface CreateHarnessOptions {
  /** Path to plugin directory (e.g. 'plugins/kitchen-sink') */
  pluginDir: string;
  /** Additional plugin directories to load alongside (for dependency testing) */
  additionalPlugins?: string[];
  /**
   * Seed data function called after DB setup.
   * Receives the raw better-sqlite3 Database instance for direct SQL.
   */
  seed?: (db: Database.Database) => void;
  /**
   * When true, runs the full register() → start() lifecycle instead of just
   * register(). Wires DB, file storage, and stub core services before calling
   * startAll(). Routes and tools registered in start() will be available in the
   * returned harness. Cleanup will call stopAll() to release plugin resources.
   * Default: false (backward-compatible — only register() is called).
   */
  start?: boolean;
  /**
   * Override any of the stub core services injected when start:true is used.
   * User-provided values take precedence over the built-in no-op stubs.
   * Useful for spying on notify events or providing a custom runner.
   */
  coreServices?: Partial<{
    cloudStorage: unknown;
    notify: (event: any) => void;
    runner: unknown;
    fileSync: unknown;
    settings: unknown;
    cloudFiles: unknown;
    automations: unknown;
    websocket: unknown;
    apks: unknown;
    paths: unknown;
    dispatcher: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// Stub core services (no-ops used when start:true is set)
// ---------------------------------------------------------------------------

/** Stub NamespacedStorage that satisfies the interface without touching disk. */
const stubNamespacedStorage: NamespacedStorage = {
  write: async () => {},
  read: async () => Buffer.alloc(0),
  getFilePath: async () => '/stub/path',
  url: () => 'stub://file',
  exists: async () => false,
  delete: async () => {},
  list: async () => [],
  flush: async () => {},
};

/**
 * Stub FileStorageService — satisfies the forPlugin() shape that
 * PluginManager.wireFiles() expects. Cast to any to avoid importing the
 * concrete class (which pulls in S3 SDK, fs timers, etc.).
 */
const stubFileSync = {
  forPlugin: (_name: string): NamespacedStorage => stubNamespacedStorage,
} as any; // CloudStorageService / FileStorageService shapes not needed at runtime

/** Stub CloudStorageService — no-op methods matching the runtime surface. */
const stubCloudStorage = {
  isConfigured: () => false,
  upload: async () => false,
  download: async () => ({ error: 'stub' }),
  downloadBuffer: async () => ({ error: 'stub' }),
  delete: async () => {},
  exists: async () => false,
  presignUrl: async () => null,
  listObjects: async () => ({ prefixes: [], files: [] }),
  listAllKeys: async () => [],
  listAllKeysWithETags: async () => [],
  headBucket: async () => {},
  configure: () => {},
  shutdown: () => {},
  getPresignCacheSize: () => 0,
  retryUpload: () => {},
  getStatus: () => ({ configured: false, localCacheUsageMb: 0, localCacheBudgetMb: 0, filesTracked: 0, filesCloudOnly: 0, pendingUploads: 0, errors: [] }),
  trackFile: () => {},
  acquireLocal: async () => ({ error: 'stub' }),
  acquireLocalByPrefix: async () => ({ error: 'stub' }),
  getDirectUrl: async () => null,
  removeFile: async () => {},
  forPlugin: (_name: string): NamespacedStorage => stubNamespacedStorage,
  forNamespace: (_ns: string): NamespacedStorage => stubNamespacedStorage,
  start: () => {},
  stop: () => {},
} as any; // typed as any — runtime no-ops only; interface matching is not needed

/** Stub notify — no-op. Overridable via coreServices.notify. */
const stubNotify = (_event: any): void => { /* no-op */ };

/** Stub AutomationRunner — satisfies the runner surface used by plugins. */
const stubRunner = {
  runAutomation: async () => ({ sessionId: 0, success: true }),
  getRules: () => [],
  getCaptureRules: () => [],
  runRules: async () => {},
  runCaptureRules: async () => {},
  disposeCaptureRuleIsolates: () => {},
  setNotificationService: () => {},
  setIosDeviceManager: () => {},
  setToolRegistry: () => {},
  setHookBus: () => {},
} as any; // typed as any — runtime no-ops only

/** Stub SettingsApi — in-memory map. */
const stubSettings = {
  get: async () => null,
  getJson: async () => null,
  set: async () => {},
  setJson: async () => {},
  delete: async () => {},
  list: async () => [],
} as any;

/** Stub CloudFilesApi — no-op. */
const stubCloudFiles = {
  listByNamespace: async () => [],
  setSyncState: async () => {},
  setSyncError: async () => {},
  delete: async () => {},
  upsertByCloudKey: async () => {},
} as any;

/** Stub AutomationsApi — empty list. */
const stubAutomations = {
  list: async () => [],
} as any;

/** Stub WebsocketApi — no-op. */
const stubWebsocket = {
  broadcast: () => {},
  registerChannel: () => {},
} as any;

/** Stub ApkApi — no-op. */
const stubApks = {
  lookupVersion: async () => null,
  ensureLocal: async () => '/stub/apk',
  analysisDbPath: () => '/stub/analysis.db',
} as any;

/** Stub PathsApi — pass-through. */
const stubPaths = {
  fileStorage: (rel: string) => `/stub/${rel}`,
} as any;

/**
 * Stub DispatcherApi — returns a no-op Dispatcher object so plugins that
 * construct dispatchers in start() (e.g. to capture a closure) don't crash
 * under the harness. The returned object is structurally a Dispatcher but
 * does not actually perform any I/O; calling .dispatch on it would error.
 * Tests that need a real dispatcher must pass coreServices.dispatcher.
 */
const stubDispatcher = ((_spec: any): any => ({
  dispatch: () => false,
  close: () => Promise.resolve(),
  destroy: () => Promise.resolve(),
  on: () => stubDispatcher,
  once: () => stubDispatcher,
  off: () => stubDispatcher,
  emit: () => false,
  removeListener: () => stubDispatcher,
})) as any;

// ---------------------------------------------------------------------------

/**
 * Create a fully wired test environment for a single plugin.
 *
 * Spins up an in-memory SQLite database with all core migrations and
 * the target plugin's own migrations applied (plus any additionalPlugins'
 * migrations), discovers and loads the specified plugin, creates an Express
 * app with the plugin's routes, and registers the plugin's tools in an
 * AiToolRegistry.
 *
 * When `start: true` is provided the harness also runs the full
 * register() → start() lifecycle by wiring DB, stub file storage, and stub
 * core services (cloudStorage, notify, runner, fileSync) before calling
 * startAll(). Routes and tools registered during start() will be present in
 * the returned app and toolRegistry. Any service can be overridden via the
 * `coreServices` option (user-provided values take precedence over stubs).
 * When start was used, cleanup() calls stopAll() — it returns a Promise in
 * that case, so callers should await it.
 *
 * @param options - Plugin directory path (string) or full options object
 * @returns A harness with app, db, pluginManager, toolRegistry, and cleanup()
 *
 * @example
 * ```ts
 * const harness = await createPluginTestHarness('plugins/kitchen-sink');
 * const res = await request(harness.app).get('/v1/kitchen-sink/items');
 * expect(res.status).toBe(200);
 * harness.cleanup();
 * ```
 */
export async function createPluginTestHarness(
  options: CreateHarnessOptions | string,
): Promise<PluginTestHarness> {
  const opts: CreateHarnessOptions =
    typeof options === 'string' ? { pluginDir: options } : options;

  // 1a. Create in-memory DB (no migrations yet — wait until plugins are discovered)
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF'); // Tests rarely seed all FK targets
  const db = drizzle(sqlite, { schema }) as any;

  // 2. Discover and load the target plugin (and any additionalPlugins)
  const { discoverPlugins } = await import('../plugins/discover');

  const targetDir = resolve(opts.pluginDir);
  const parentDir = resolve(targetDir, '..');
  const discovered = await discoverPlugins([parentDir]);

  const plugin = discovered.find((d) => resolve(d.path) === targetDir);
  if (!plugin) {
    sqlite.close();
    throw new Error(
      `Plugin not found at ${targetDir}. ` +
        `Discovered ${discovered.length} plugin(s) in ${parentDir}: ` +
        `[${discovered.map((d) => d.name).join(', ')}]`,
    );
  }

  // Collect all plugin entries (target + additional) for topo sort and loading
  const allPluginEntries: { name: string; definition: import('@darkrideapp/plugin-sdk').PluginDefinition; path: string }[] = [
    { name: plugin.definition.name, definition: plugin.definition, path: targetDir },
  ];
  if (opts.additionalPlugins) {
    for (const dir of opts.additionalPlugins) {
      const additionalDir = resolve(dir);
      const additionalParent = resolve(additionalDir, '..');
      const additional = await discoverPlugins([additionalParent]);
      const found = additional.find((d) => resolve(d.path) === additionalDir);
      if (found) {
        allPluginEntries.push({ name: found.definition.name, definition: found.definition, path: additionalDir });
      }
    }
  }

  // Load plugins into manager in topo order so peer() calls work correctly
  const pluginLoadOrder = computeLoadOrder(
    allPluginEntries.map(e => ({ name: e.name, definition: e.definition })),
  );
  const pluginByName = new Map(allPluginEntries.map(e => [e.name, e]));

  const pluginManager = new PluginManager();
  for (const name of pluginLoadOrder) {
    pluginManager.loadPlugin(pluginByName.get(name)!.definition);
  }

  // 1b. Apply core migrations + plugin migrations in topological dependency order
  const migrationFolders: string[] = [resolve('./migrations')];
  for (const name of pluginLoadOrder) {
    const entry = pluginByName.get(name)!;
    const pluginMigrationsDir = resolve(entry.path, 'migrations');
    if (
      existsSync(pluginMigrationsDir) &&
      existsSync(resolve(pluginMigrationsDir, 'meta/_journal.json'))
    ) {
      migrationFolders.push(pluginMigrationsDir);
    }
  }

  applyMigrations(sqlite, migrationFolders);

  // Wire plugin-loaded check so ctx.isPluginLoaded() works
  pluginManager.wirePluginLoadedCheck();

  // 3. If start:true, run the full lifecycle before collecting routes/tools
  if (opts.start) {
    pluginManager.wireDb(db);
    pluginManager.wireFiles({
      forPlugin: (_name: string): NamespacedStorage => stubNamespacedStorage,
    });
    pluginManager.wireCoreServices({
      cloudStorage: (opts.coreServices?.cloudStorage ?? stubCloudStorage) as any,
      notify: opts.coreServices?.notify ?? stubNotify,
      runner: (opts.coreServices?.runner ?? stubRunner) as any,
      fileSync: (opts.coreServices?.fileSync ?? stubFileSync) as any,
      settings: (opts.coreServices?.settings ?? stubSettings) as any,
      cloudFiles: (opts.coreServices?.cloudFiles ?? stubCloudFiles) as any,
      automations: (opts.coreServices?.automations ?? stubAutomations) as any,
      websocket: (opts.coreServices?.websocket ?? stubWebsocket) as any,
      apks: (opts.coreServices?.apks ?? stubApks) as any,
      paths: (opts.coreServices?.paths ?? stubPaths) as any,
      dispatcher: (opts.coreServices?.dispatcher ?? stubDispatcher) as any,
    });
    await pluginManager.startAll();
  }

  // 4. Create Express app with plugin routes
  // getAllRouteSetups() reads live from contributions — collects everything
  // registered in both register() and (if started) start().
  const app = express();
  app.use(express.json());

  const router = express.Router();
  for (const setup of pluginManager.getAllRouteSetups()) {
    setup(router);
  }
  // Plugin routes include /v1/ prefix in their paths, so mount at root
  app.use(router);

  // 5. Register plugin tools in the AiToolRegistry
  const toolRegistry = new AiToolRegistry();

  // Unified tools (PluginTool — uses `contexts` field)
  for (const tool of pluginManager.getAllTools()) {
    toolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as any,
      context: tool.contexts,
      execute: tool.execute,
    });
  }

  // Legacy AI tools (PluginAiTool — uses `context` field)
  for (const tool of pluginManager.getAllAiTools()) {
    // Skip if a unified tool with the same name was already registered
    const existing = toolRegistry.getToolsForContext(tool.context[0] || '');
    if (existing.some((t) => t.name === tool.name)) continue;

    toolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as any,
      context: tool.context,
      execute: tool.execute,
    });
  }

  // 6. Seed data if provided
  if (opts.seed) {
    opts.seed(sqlite);
  }

  return {
    app,
    db,
    sqlite,
    pluginManager,
    toolRegistry,
    cleanup() {
      if (opts.start) {
        // stopAll() is async — return the promise so callers can await it
        return pluginManager.stopAll().finally(() => sqlite.close());
      }
      sqlite.close();
    },
  };
}
