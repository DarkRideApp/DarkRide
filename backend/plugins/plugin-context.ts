import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Router } from 'express';
import type {
  PluginContext,
  PluginNavItem,
  PluginPageDef,
  PluginAiTool,
  PluginAiContext,
  PluginTool,
  PluginToolContext,
  PluginJob,
  DeviceProviderContribution,
  ManagedAutomationDef,
  PluginSetting,
  PluginCommand,
  PluginNotificationEvent,
  PluginNotifyEvent,
  PluginLogger,
  HookBus,
  NamespacedStorage,
  PluginAiApi,
  PluginAgent,
  UiSlotDefinition,
  UiContribution,
  PluginApi,
  CloudStorageService,
  FileStorageService,
  AutomationRunner,
  SettingsApi,
  CloudFilesApi,
  AutomationsApi,
  WebsocketApi,
  ApkApi,
  PathsApi,
  DispatcherApi,
  DocStoreApi,
} from '@darkrideapp/plugin-sdk';
import { registerEndpoint } from '../api/api-service';
import { registerPluginScopes, type ScopeMetadata } from '../auth/scopes-registry';
import { createLoggers } from '../logs';
import type { AiAgentFactory } from '../services/ai-agent-factory';
import type { AiTierStore } from '../services/ai-tier-store';
import type { HookBusImpl } from '@darkrideapp/plugin-sdk';

export interface CollectedContributions {
  nav: PluginNavItem[];
  pages: PluginPageDef[];
  routes: Array<(router: Router) => void>;
  aiTools: PluginAiTool[];
  aiContexts: PluginAiContext[];
  tools: PluginTool[];
  toolContexts: PluginToolContext[];
  jobs: PluginJob[];
  deviceProviders: DeviceProviderContribution[];
  managedAutomations: ManagedAutomationDef[];
  settings: PluginSetting[];
  commands: PluginCommand[];
  notificationEvents: PluginNotificationEvent[];
  protocolDecoders: unknown[];
  dbTables: Record<string, unknown>;
  uiSlots: UiSlotDefinition[];
  uiContributions: UiContribution[];
}

export interface ServiceRegistryCallbacks {
  expose: (pluginName: string, impl: unknown) => void;
  peer: <T>(callerName: string, targetName: string) => T;
  has: (targetName: string) => boolean;
}

export function createEmptyContributions(): CollectedContributions {
  return {
    nav: [],
    pages: [],
    routes: [],
    aiTools: [],
    aiContexts: [],
    tools: [],
    toolContexts: [],
    jobs: [],
    deviceProviders: [],
    managedAutomations: [],
    settings: [],
    commands: [],
    notificationEvents: [],
    protocolDecoders: [],
    dbTables: {},
    uiSlots: [],
    uiContributions: [],
  };
}

export class PluginContextImpl implements PluginContext {
  readonly pluginName: string;
  readonly pluginDir: string;
  readonly hooks: HookBus;
  private collected: CollectedContributions;
  private _files: NamespacedStorage | null = null;
  private aiFactory: AiAgentFactory | null = null;
  private aiScopes: string[] = [];
  private aiTierStore: AiTierStore | null = null;
  private pluginLoadedCheck: ((name: string) => boolean) | null = null;
  private serviceRegistry: ServiceRegistryCallbacks | null = null;
  private _notify: ((event: PluginNotifyEvent) => void) | null = null;
  private _cloudStorage: CloudStorageService | null = null;
  private _runner: AutomationRunner | null = null;
  private _fileSync: FileStorageService | null = null;
  private _documentStore: DocStoreApi | null = null;
  private _rawDb: BetterSQLite3Database<any> | null = null;
  private _settings: SettingsApi | null = null;
  private _cloudFiles: CloudFilesApi | null = null;
  private _automations: AutomationsApi | null = null;
  private _websocket: WebsocketApi | null = null;
  private _apks: ApkApi | null = null;
  private _paths: PathsApi | null = null;
  private _dispatcher: DispatcherApi | null = null;
  private loggerCache = new Map<string, PluginLogger>();

  constructor(
    pluginName: string,
    hookBus: HookBusImpl,
    collected: CollectedContributions,
    pluginDir: string = process.cwd(),
  ) {
    this.pluginName = pluginName;
    this.pluginDir = pluginDir;
    this.hooks = hookBus;
    this.collected = collected;
  }

  logger(subsystem?: string): PluginLogger {
    const systemId = subsystem ? `${this.pluginName}:${subsystem}` : this.pluginName;
    const cached = this.loggerCache.get(systemId);
    if (cached) return cached;
    const logger = createLoggers(systemId);
    this.loggerCache.set(systemId, logger);
    return logger;
  }

  nav(items: PluginNavItem[]): void {
    this.collected.nav.push(...items);
  }

  pages(defs: PluginPageDef[]): void {
    this.collected.pages.push(...defs);
  }

  routes(setup: (router: Router) => void): void {
    this.collected.routes.push(setup);
  }

  api(setup: (api: PluginApi) => void): void {
    const api: PluginApi = {
      get: (path, handler, opts) => registerEndpoint('GET', path, handler, opts),
      post: (path, handler, opts) => registerEndpoint('POST', path, handler, opts),
      put: (path, handler, opts) => registerEndpoint('PUT', path, handler, opts),
      delete: (path, handler, opts) => registerEndpoint('DELETE', path, handler, opts),
      patch: (path, handler, opts) => registerEndpoint('PATCH', path, handler, opts),
    };
    setup(api);
  }

  dbTables(schema: Record<string, unknown>): void {
    Object.assign(this.collected.dbTables, schema);
  }

  aiTools(tools: PluginAiTool[]): void {
    this.collected.aiTools.push(...tools);
  }

  aiContexts(contexts: PluginAiContext[]): void {
    this.collected.aiContexts.push(...contexts);
  }

  tools(tools: PluginTool[]): void {
    this.collected.tools.push(...tools);
  }

  toolContexts(contexts: PluginToolContext[]): void {
    this.collected.toolContexts.push(...contexts);
  }

  jobs(jobs: PluginJob[]): void {
    this.collected.jobs.push(...jobs);
  }

  deviceProviders(providers: DeviceProviderContribution[]): void {
    this.collected.deviceProviders.push(...providers);
  }

  managedAutomations(defs: ManagedAutomationDef[]): void {
    // Collect at register-time; the host runs reconcile against these AFTER
    // plugin migrations land and BEFORE start() — see PluginManager.
    this.collected.managedAutomations.push(...defs);
  }

  settingsDefs(defs: PluginSetting[]): void {
    this.collected.settings.push(...defs);
  }

  commands(cmds: PluginCommand[]): void {
    this.collected.commands.push(...cmds);
  }

  notificationEvents(events: PluginNotificationEvent[]): void {
    this.collected.notificationEvents.push(...events);
  }

  protocolDecoders(decoders: unknown[]): void {
    this.collected.protocolDecoders.push(...decoders);
  }

  uiSlots(defs: UiSlotDefinition[]): void {
    this.collected.uiSlots.push(...defs);
  }

  uiContributions(contribs: UiContribution[]): void {
    this.collected.uiContributions.push(...contribs);
  }

  scopes(scopes: ScopeMetadata[]): void {
    registerPluginScopes(this.pluginName, scopes);
  }

  setFiles(storage: NamespacedStorage): void {
    this._files = storage;
  }

  files(): NamespacedStorage {
    if (!this._files) throw new Error('files() not available until plugin is fully loaded');
    return this._files;
  }

  setNotify(fn: (event: PluginNotifyEvent) => void): void {
    this._notify = fn;
  }

  notify(event: PluginNotifyEvent): void {
    if (!this._notify) {
      throw new Error(
        `Plugin "${this.pluginName}": notify() not available until plugin is fully loaded. ` +
        `Call from start() or later, not register().`,
      );
    }
    this._notify(event);
  }

  setCloudStorage(svc: CloudStorageService): void {
    this._cloudStorage = svc;
  }

  get cloudStorage(): CloudStorageService {
    if (this._cloudStorage === null) {
      throw new Error(
        `Plugin "${this.pluginName}": cloudStorage not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._cloudStorage;
  }

  setRunner(runner: AutomationRunner): void {
    this._runner = runner;
  }

  get runner(): AutomationRunner {
    if (this._runner === null) {
      throw new Error(
        `Plugin "${this.pluginName}": runner not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._runner;
  }

  setFileSync(fileSync: FileStorageService): void {
    this._fileSync = fileSync;
  }

  get fileSync(): FileStorageService {
    if (this._fileSync === null) {
      throw new Error(
        `Plugin "${this.pluginName}": fileSync not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._fileSync;
  }

  setDocumentStore(api: DocStoreApi): void {
    this._documentStore = api;
  }

  get documentStore(): DocStoreApi {
    if (this._documentStore === null) {
      throw new Error(
        `Plugin "${this.pluginName}": documentStore not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._documentStore;
  }

  setSettingsApi(api: SettingsApi): void {
    this._settings = api;
  }

  get settings(): SettingsApi {
    if (this._settings === null) {
      throw new Error(
        `Plugin "${this.pluginName}": ctx.settings not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._settings;
  }

  setCloudFilesApi(api: CloudFilesApi): void {
    this._cloudFiles = api;
  }

  get cloudFiles(): CloudFilesApi {
    if (this._cloudFiles === null) {
      throw new Error(
        `Plugin "${this.pluginName}": ctx.cloudFiles not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._cloudFiles;
  }

  setAutomationsApi(api: AutomationsApi): void {
    this._automations = api;
  }

  get automations(): AutomationsApi {
    if (this._automations === null) {
      throw new Error(
        `Plugin "${this.pluginName}": ctx.automations not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._automations;
  }

  setWebsocketApi(api: WebsocketApi): void {
    this._websocket = api;
  }

  get websocket(): WebsocketApi {
    if (this._websocket === null) {
      throw new Error(
        `Plugin "${this.pluginName}": ctx.websocket not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._websocket;
  }

  setApksApi(api: ApkApi): void {
    this._apks = api;
  }

  get apks(): ApkApi {
    if (this._apks === null) {
      throw new Error(
        `Plugin "${this.pluginName}": ctx.apks not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._apks;
  }

  setPathsApi(api: PathsApi): void {
    this._paths = api;
  }

  get paths(): PathsApi {
    if (this._paths === null) {
      throw new Error(
        `Plugin "${this.pluginName}": ctx.paths not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._paths;
  }

  setDispatcherApi(api: DispatcherApi): void {
    this._dispatcher = api;
  }

  get dispatcher(): DispatcherApi {
    if (this._dispatcher === null) {
      throw new Error(
        `Plugin "${this.pluginName}": ctx.dispatcher not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    return this._dispatcher;
  }

  setAiFactory(factory: AiAgentFactory): void {
    this.aiFactory = factory;
  }

  setAiScopes(scopes: string[]): void {
    this.aiScopes = scopes;
  }

  setAiTierStore(store: AiTierStore): void {
    this.aiTierStore = store;
  }

  setPluginLoadedCheck(check: (name: string) => boolean): void {
    this.pluginLoadedCheck = check;
  }

  setServiceRegistry(callbacks: ServiceRegistryCallbacks): void {
    this.serviceRegistry = callbacks;
  }

  isPluginLoaded(name: string): boolean {
    if (!this.pluginLoadedCheck) return false;
    return this.pluginLoadedCheck(name);
  }

  exposeService<T>(impl: T): void {
    if (!this.serviceRegistry) {
      throw new Error(
        `Plugin "${this.pluginName}": service registry not wired. ` +
        `exposeService() must be called from start(), not register().`,
      );
    }
    this.serviceRegistry.expose(this.pluginName, impl as unknown);
  }

  peer<T>(pluginName: string): T {
    if (!this.serviceRegistry) {
      throw new Error(
        `Plugin "${this.pluginName}": service registry not wired. ` +
        `peer() must be called from start() or later, not register().`,
      );
    }
    return this.serviceRegistry.peer<T>(this.pluginName, pluginName);
  }

  /**
   * Returns `false` when the service registry has not been wired yet
   * (i.e. when called from `register()` — the registry is wired before
   * `start()` runs). This is asymmetric with `exposeService` and `peer`,
   * which throw in the same situation: `hasPeer` is meant for optional-
   * dependency guards, so silently answering `false` is the safer
   * contract. Call it from `start()` or later for meaningful results.
   */
  hasPeer(pluginName: string): boolean {
    if (!this.serviceRegistry) return false;
    return this.serviceRegistry.has(pluginName);
  }

  get ai(): PluginAiApi {
    const pluginName = this.pluginName;
    const factory = this.aiFactory;
    const aiScopes = this.aiScopes;
    const tierStore = this.aiTierStore;
    return {
      agent(options) {
        if (!factory) throw new Error(`Plugin "${pluginName}": AI factory not wired`);
        if (aiScopes.length === 0) {
          throw new Error(
            `Plugin "${pluginName}" did not declare aiScopes; no AI identity available. ` +
            `Add aiScopes to your plugin manifest.`,
          );
        }
        return factory.forPluginInternal(pluginName, aiScopes, options) as PluginAgent;
      },
      forUser(userId, options) {
        if (!factory) throw new Error(`Plugin "${pluginName}": AI factory not wired`);
        if (aiScopes.length === 0) {
          throw new Error(
            `Plugin "${pluginName}" did not declare aiScopes; no AI identity available. ` +
            `Add aiScopes to your plugin manifest.`,
          );
        }
        return factory.forPluginActingForInternal(pluginName, userId, aiScopes, options) as PluginAgent;
      },
      listTiers() {
        if (!tierStore) return [];
        return tierStore.list().map(t => ({
          name: t.name,
          sortOrder: t.sortOrder,
          isHardcoded: t.isHardcoded,
          enabledModelCount: t.enabledModelCount,
        }));
      },
    };
  }

  setDb(db: BetterSQLite3Database<any>): void {
    this._rawDb = db;
  }

  db<T extends Record<string, unknown>>(schema: T): BetterSQLite3Database<T> {
    if (!this._rawDb) {
      throw new Error(
        `Plugin "${this.pluginName}": db() not available until plugin is fully loaded. ` +
        `Access from start() or later, not register().`,
      );
    }
    const rawSqlite = (this._rawDb as any).$client;
    return drizzle(rawSqlite, { schema }) as BetterSQLite3Database<T>;
  }
}
