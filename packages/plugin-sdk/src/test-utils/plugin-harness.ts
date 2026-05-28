import type { PluginContext, PluginDefinition } from '../types/plugin';
import type { HookBus } from '../types/hooks';
import type { PluginAiApi } from '../types/ai';

export interface PluginHarness {
  /** The mocked context the plugin's register/start ran against. */
  ctx: PluginContext;
  /** Run the plugin's stop() if defined. */
  stop(): Promise<void>;
}

export interface MakePluginHarnessOptions {
  plugin: PluginDefinition;
  /** Override any field on the constructed ctx for assertions. */
  mocks?: Partial<PluginContext>;
}

/**
 * Boot a plugin in isolation against a mocked PluginContext for unit tests.
 * Calls plugin.register(ctx) and (if defined) plugin.start(ctx).
 *
 * The default ctx has no-op implementations of every required field.
 * Override specific fields via `mocks` to capture spies or inject test doubles.
 */
export async function makePluginHarness(opts: MakePluginHarnessOptions): Promise<PluginHarness> {
  const { plugin, mocks = {} } = opts;
  const ctx: PluginContext = { ...createDefaultMockCtx(plugin.name), ...mocks };

  plugin.register(ctx);
  if (plugin.start) await plugin.start(ctx);

  return {
    ctx,
    async stop() {
      if (plugin.stop) await plugin.stop(ctx);
    },
  };
}

function createDefaultMockCtx(pluginName: string): PluginContext {
  const noopLogger = {
    log: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  };

  return {
    pluginName,
    pluginDir: process.cwd(),
    logger: () => noopLogger as any,
    nav: () => {},
    pages: () => {},
    routes: () => {},
    api: () => {},
    dbTables: () => {},
    aiTools: () => {},
    aiContexts: () => {},
    tools: () => {},
    toolContexts: () => {},
    jobs: () => {},
    settingsDefs: () => {},
    commands: () => {},
    notificationEvents: () => {},
    protocolDecoders: () => {},
    uiSlots: () => {},
    uiContributions: () => {},
    scopes: () => {},
    files: () => { throw new Error('files() not available in default mock — pass via mocks'); },
    notify: () => {},
    hooks: createNoopHookBus(),
    ai: createNoopAiApi(),
    isPluginLoaded: () => false,
    exposeService: () => {},
    peer: (name: string) => { throw new Error(`peer('${name}') not available in default mock — pass via mocks`); },
    hasPeer: () => false,
    db: () => { throw new Error('db() not available in default mock — pass via mocks'); },
    cloudStorage: createNoopCloudStorage(),
    runner: createNoopRunner(),
    fileSync: createNoopFileSync(),
    settings: createNoopSettings(),
    cloudFiles: createNoopCloudFiles(),
    automations: createNoopAutomations(),
    websocket: createNoopWebsocket(),
    apks: createNoopApks(),
    paths: createNoopPaths(),
    dispatcher: () => { throw new Error('dispatcher() not available in default mock — pass via mocks'); },
  } as PluginContext;
}

function createNoopHookBus(): HookBus {
  return {
    define: () => {},
    on: () => {},
    off: () => {},
    emit: () => {},
  };
}

function createNoopAiApi(): PluginAiApi {
  const noopAgent: any = {};
  return {
    agent: () => noopAgent,
    forUser: () => noopAgent,
    listTiers: () => [],
  };
}

function createNoopSettings() {
  return {
    get: async () => null,
    getJson: async () => null,
    set: async () => {},
    setJson: async () => {},
    delete: async () => {},
    list: async () => [],
  };
}

function createNoopCloudFiles() {
  return {
    listByNamespace: async () => [],
    setSyncState: async () => {},
    setSyncError: async () => {},
    setRetain: async () => {},
    delete: async () => {},
    upsertByCloudKey: async () => {},
  };
}

function createNoopAutomations() {
  return { list: async () => [] };
}

function createNoopWebsocket() {
  return {
    broadcast: () => {},
    registerChannel: () => {},
  };
}

function createNoopApks() {
  return {
    lookupVersion: async () => null,
    ensureLocal: async () => '/tmp/no-op-apk',
    analysisDbPath: () => '/tmp/no-op-analysis.db',
  };
}

function createNoopPaths() {
  return {
    fileStorage: (rel: string) => `/tmp/${rel}`,
  };
}

function createNoopCloudStorage(): any {
  // Minimal stub. Real callers override via mocks if they need cloud-storage behavior.
  return {};
}

function createNoopRunner(): any {
  return {};
}

function createNoopFileSync(): any {
  return {};
}
