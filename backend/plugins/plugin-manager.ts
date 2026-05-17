import { readFileSync } from 'fs';
import { resolve } from 'path';
import semver from 'semver';
import type { Router } from 'express';
import { is, Table, getTableName } from 'drizzle-orm';
import type {
  PluginDefinition,
  PluginMetadata,
  PluginAiTool,
  PluginAiContext,
  PluginTool,
  PluginToolContext,
  PluginJob,
  PluginSetting,
  PluginNotificationEvent,
} from '@darkrideapp/plugin-sdk';
import { HookBusImpl } from '@darkrideapp/plugin-sdk';
import { PluginContextImpl, createEmptyContributions } from './plugin-context';
import { computeLoadOrder } from './load-order';
import type { CollectedContributions, ServiceRegistryCallbacks } from './plugin-context';
import type { AiAgentFactory } from '../services/ai-agent-factory';
import type { AiTierStore } from '../services/ai-tier-store';
import { isSupportedScope } from '../auth/scopes-registry';
import { createLoggers } from '../logs';
import type { ServiceUserManager } from '../auth/service-user-manager';

const { log, error: logError } = createLoggers('plugin-manager');

const CORE_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
})();

interface LoadedPlugin {
  definition: PluginDefinition;
  contributions: CollectedContributions;
  context: PluginContextImpl;
  /** package.json#version when known — preferred over definition.version (deprecated). */
  packageVersion?: string;
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private hookBus = new HookBusImpl();
  private loadOrder: string[] | null = null;
  private services = new Map<string, unknown>();
  private startedPlugins: string[] = [];   // plugins whose start() resolved (for stopAll cleanup)
  private serviceUserManager: ServiceUserManager | null = null;

  getHookBus(): HookBusImpl {
    return this.hookBus;
  }

  loadPlugin(definition: PluginDefinition, packageVersion?: string, pluginDir?: string): void {
    if (this.plugins.has(definition.name)) {
      throw new Error(`Plugin "${definition.name}" is already loaded`);
    }

    // Prefer package.json#version (the authoritative published version)
    // over definition.version (the deprecated in-source string).
    const resolvedVersion = packageVersion ?? definition.version ?? 'unknown';

    if (definition.darkride) {
      const ok = semver.satisfies(CORE_VERSION, definition.darkride, { includePrerelease: true });
      if (!ok) {
        log(`WARN: Plugin "${definition.name}@${resolvedVersion}" requires darkride ${definition.darkride} but core is ${CORE_VERSION}. Loading anyway — runtime errors may occur.`);
      }
    }

    this.validateAiScopes(definition);

    const contributions = createEmptyContributions();
    const ctx = new PluginContextImpl(definition.name, this.hookBus, contributions, pluginDir);

    ctx.setServiceRegistry({
      expose: (pluginName, impl) => {
        if (this.services.has(pluginName)) {
          throw new Error(`Plugin "${pluginName}" called exposeService more than once`);
        }
        this.services.set(pluginName, impl);
      },
      peer: <T>(callerName: string, targetName: string): T => {
        const impl = this.services.get(targetName);
        if (impl === undefined) {
          if (!this.plugins.has(targetName)) {
            throw new Error(
              `Plugin "${callerName}" requested peer "${targetName}", which is not loaded. ` +
              `Add "${targetName}" to dependencies or optionalDependencies.`,
            );
          }
          throw new Error(
            `Plugin "${callerName}" requested peer "${targetName}", which is loaded but ` +
            `has not exposed a service. Either call exposeService in its start(), or ` +
            `this is a usage error (called peer() before that plugin's start() completed).`,
          );
        }
        return impl as T;
      },
      has: (targetName) => this.services.has(targetName),
    });

    definition.register(ctx);

    this.plugins.set(definition.name, { definition, contributions, context: ctx, packageVersion });
    this.loadOrder = null;
    log(`Loaded plugin: ${definition.name}@${resolvedVersion}`);
  }

  getLoadOrder(): string[] {
    if (this.loadOrder) return this.loadOrder;
    this.loadOrder = computeLoadOrder(
      Array.from(this.plugins.entries()).map(([name, plugin]) => ({ name, definition: plugin.definition })),
    );
    return this.loadOrder;
  }

  getPluginMetadata(): PluginMetadata[] {
    return Array.from(this.plugins.values()).map(({ definition, contributions, packageVersion }) => ({
      name: definition.name,
      version: packageVersion ?? definition.version ?? 'unknown',
      nav: contributions.nav,
      pages: contributions.pages,
      settings: contributions.settings,
      commands: contributions.commands,
      notificationEvents: contributions.notificationEvents,
      tools: contributions.tools.map(t => ({ name: t.name, description: t.description, contexts: t.contexts })),
      toolContexts: contributions.toolContexts,
      uiSlots: contributions.uiSlots,
      uiContributions: contributions.uiContributions,
    }));
  }

  getAllRouteSetups(): Array<(router: Router) => void> {
    const result: Array<(router: Router) => void> = [];
    for (const { contributions } of this.plugins.values()) {
      result.push(...contributions.routes);
    }
    return result;
  }

  getAllAiTools(): PluginAiTool[] {
    const result: PluginAiTool[] = [];
    for (const { contributions } of this.plugins.values()) {
      result.push(...contributions.aiTools);
    }
    return result;
  }

  getAllAiContexts(): PluginAiContext[] {
    const result: PluginAiContext[] = [];
    for (const { contributions } of this.plugins.values()) {
      result.push(...contributions.aiContexts);
    }
    return result;
  }

  getAllTools(): PluginTool[] {
    const result: PluginTool[] = [];
    for (const { contributions } of this.plugins.values()) {
      result.push(...contributions.tools);
    }
    return result;
  }

  getAllToolContexts(): PluginToolContext[] {
    const result: PluginToolContext[] = [];
    for (const { contributions } of this.plugins.values()) {
      result.push(...contributions.toolContexts);
    }
    return result;
  }

  getAllJobs(): PluginJob[] {
    const result: PluginJob[] = [];
    for (const { contributions } of this.plugins.values()) {
      result.push(...contributions.jobs);
    }
    return result;
  }

  getAllSettings(): PluginSetting[] {
    const result: PluginSetting[] = [];
    for (const { contributions } of this.plugins.values()) {
      result.push(...contributions.settings);
    }
    return result;
  }

  getAllNotificationEvents(): PluginNotificationEvent[] {
    const result: PluginNotificationEvent[] = [];
    for (const { contributions } of this.plugins.values()) {
      result.push(...contributions.notificationEvents);
    }
    return result;
  }

  getAllProtocolDecoders(): unknown[] {
    const result: unknown[] = [];
    for (const { contributions } of this.plugins.values()) {
      result.push(...contributions.protocolDecoders);
    }
    return result;
  }

  /**
   * Check for table name collisions between plugins and optionally against core schema.
   * Throws if any two plugins declare the same table name, or if a plugin table
   * collides with a core table.
   */
  validateTableNames(coreSchema?: Record<string, unknown>): void {
    // Map: table name → plugin name that owns it
    const tableOwners = new Map<string, string>();

    // Collect core table names first
    if (coreSchema) {
      for (const val of Object.values(coreSchema)) {
        if (is(val as any, Table)) {
          const name = getTableName(val as Table);
          tableOwners.set(name, '(core)');
        }
      }
    }

    // Check each plugin's tables against the map
    for (const [pluginName, { contributions }] of this.plugins) {
      for (const val of Object.values(contributions.dbTables)) {
        if (!is(val as any, Table)) continue;
        const tableName = getTableName(val as Table);

        const existingOwner = tableOwners.get(tableName);
        if (existingOwner) {
          throw new Error(
            `Table name collision: "${tableName}" is declared by both ${existingOwner} and plugin "${pluginName}"`,
          );
        }
        tableOwners.set(tableName, `plugin "${pluginName}"`);
      }
    }
  }

  getPluginNames(): string[] {
    return Array.from(this.plugins.keys());
  }

  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  /** Return the PluginDefinition (manifest) for a named plugin. Throws if not loaded. */
  getManifest(name: string): PluginDefinition {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin "${name}" not loaded`);
    return plugin.definition;
  }

  /** Return the PluginContext for a named plugin. Throws if the plugin is not loaded. */
  getPluginContext(name: string): PluginContextImpl {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin "${name}" is not loaded`);
    return plugin.context;
  }

  /**
   * Run start() for every plugin in topological dependency order.
   * Each plugin's start is wrapped in a timeout (default 30 000 ms,
   * overridable via the plugin's startTimeoutMs).
   * Throws on the first failure with a structured message naming the plugin.
   */
  async startAll(): Promise<void> {
    const order = this.getLoadOrder();
    for (const name of order) {
      const plugin = this.plugins.get(name)!;
      if (!plugin.definition.start) continue;
      const timeoutMs = plugin.definition.startTimeoutMs ?? 30_000;
      try {
        await this.runWithTimeout(
          () => plugin.definition.start!(plugin.context),
          timeoutMs,
          `Plugin "${name}" start() exceeded ${timeoutMs}ms`,
        );
        this.startedPlugins.push(name);
      } catch (err: any) {
        throw new Error(
          `Plugin "${name}" failed to start: ${err?.message ?? String(err)}`,
          { cause: err },
        );
      }
    }
  }

  /**
   * Run stop() for every plugin whose start() resolved, in REVERSE topo order.
   * Failures and timeouts are logged but do not halt subsequent shutdowns.
   * After this returns, the service registry is cleared.
   */
  async stopAll(): Promise<void> {
    for (const name of [...this.startedPlugins].reverse()) {
      const plugin = this.plugins.get(name);
      if (!plugin?.definition.stop) continue;
      try {
        await this.runWithTimeout(
          () => plugin.definition.stop!(plugin.context),
          10_000,
          `Plugin "${name}" stop() timed out after 10000ms`,
        );
      } catch (err: any) {
        logError(`Plugin "${name}" stop() failed: ${err?.message ?? String(err)}`);
      }
    }
    this.startedPlugins = [];
    this.services.clear();
  }

  private runWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      fn().then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  wireFiles(fileStorage: { forPlugin(name: string): any }): void {
    for (const [pluginName, plugin] of this.plugins) {
      plugin.context.setFiles(fileStorage.forPlugin(pluginName));
    }
  }

  /**
   * Wire the core database into every loaded plugin's context. Plugins call
   * `ctx.db(schema)` to get a typed drizzle instance backed by the same
   * underlying SQLite handle as core.
   */
  wireDb(db: import('drizzle-orm/better-sqlite3').BetterSQLite3Database<any>): void {
    for (const [, plugin] of this.plugins) {
      plugin.context.setDb(db);
    }
  }

  /**
   * Wire the core services (cloudStorage, notification emitter, automation
   * runner, raw file-sync) into every loaded plugin's context. Plugins access
   * these via `ctx.cloudStorage`, `ctx.notify(event)`, `ctx.runner`,
   * `ctx.fileSync` from `start()` onwards.
   *
   * This replaces the per-plugin `wiring.ts` singleton pattern — plugins no
   * longer need a side-channel to receive core-level deps.
   */
  wireCoreServices(services: {
    cloudStorage: import('@darkrideapp/plugin-sdk').CloudStorageService;
    notify: (event: import('@darkrideapp/plugin-sdk').PluginNotifyEvent) => void;
    runner: import('@darkrideapp/plugin-sdk').AutomationRunner;
    fileSync: import('@darkrideapp/plugin-sdk').FileStorageService;
    settings: import('@darkrideapp/plugin-sdk').SettingsApi;
    cloudFiles: import('@darkrideapp/plugin-sdk').CloudFilesApi;
    automations: import('@darkrideapp/plugin-sdk').AutomationsApi;
    websocket: import('@darkrideapp/plugin-sdk').WebsocketApi;
    apks: import('@darkrideapp/plugin-sdk').ApkApi;
    paths: import('@darkrideapp/plugin-sdk').PathsApi;
  }): void {
    for (const [, plugin] of this.plugins) {
      plugin.context.setCloudStorage(services.cloudStorage);
      plugin.context.setNotify(services.notify);
      plugin.context.setRunner(services.runner);
      plugin.context.setFileSync(services.fileSync);
      plugin.context.setSettingsApi(services.settings);
      plugin.context.setCloudFilesApi(services.cloudFiles);
      plugin.context.setAutomationsApi(services.automations);
      plugin.context.setWebsocketApi(services.websocket);
      plugin.context.setApksApi(services.apks);
      plugin.context.setPathsApi(services.paths);
    }
  }

  wireAi(factory: AiAgentFactory): void {
    for (const [name, plugin] of this.plugins) {
      plugin.context.setAiFactory(factory);
      plugin.context.setAiScopes(plugin.definition.aiScopes);
    }
  }

  wireAiTierStore(store: AiTierStore): void {
    for (const [, plugin] of this.plugins) {
      plugin.context.setAiTierStore(store);
    }
  }

  wirePluginLoadedCheck(): void {
    const isLoaded = (name: string) => this.plugins.has(name);
    for (const { context } of this.plugins.values()) {
      context.setPluginLoadedCheck(isLoaded);
    }
  }

  setServiceUserManager(mgr: ServiceUserManager): void {
    this.serviceUserManager = mgr;
  }

  applyConsent(pluginName: string, approvedScopes: string[] | null): void {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) throw new Error(`Plugin "${pluginName}" not loaded`);
    if (!this.serviceUserManager) throw new Error('ServiceUserManager not wired');

    const manifestScopes = plugin.definition.aiScopes;

    if (!approvedScopes || approvedScopes.length === 0) {
      this.serviceUserManager.removePluginServiceUser(pluginName);
      plugin.context.setAiScopes([]);
      return;
    }

    // Effective = intersection of approved and manifest.
    // Manifest-narrowed updates don't require re-consent; the effective set
    // simply shrinks to what the manifest still declares.
    const effective = manifestScopes.filter(s => approvedScopes.includes(s));

    if (effective.length === 0) {
      // Approved set has nothing in common with the current manifest.
      // Treat as denial.
      this.serviceUserManager.removePluginServiceUser(pluginName);
      plugin.context.setAiScopes([]);
      return;
    }

    this.serviceUserManager.ensurePluginServiceUser(pluginName, effective);
    plugin.context.setAiScopes(effective);
  }

  getConsentStatus(
    pluginName: string,
    approvedScopes: string[] | null,
  ): {
    state: 'unconsented' | 'ok' | 'ok-narrowed' | 'drift-wider';
    added: string[];
    removed: string[];
  } {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) throw new Error(`Plugin "${pluginName}" not loaded`);
    const manifest = new Set(plugin.definition.aiScopes);

    if (!approvedScopes) {
      return { state: 'unconsented', added: [...manifest], removed: [] };
    }

    const approved = new Set(approvedScopes);
    const added = [...manifest].filter(s => !approved.has(s));
    const removed = [...approved].filter(s => !manifest.has(s));

    if (added.length > 0) return { state: 'drift-wider', added, removed };
    if (removed.length > 0) return { state: 'ok-narrowed', added, removed };
    return { state: 'ok', added, removed };
  }

  private validateAiScopes(def: PluginDefinition): void {
    for (const scope of def.aiScopes) {
      if (scope.includes('*')) {
        throw new Error(
          `Plugin "${def.name}" aiScopes entry "${scope}" contains a wildcard. ` +
          `aiScopes must be concrete scope keys. Declare each needed scope individually.`,
        );
      }
      if (!isSupportedScope(scope)) {
        throw new Error(
          `Plugin "${def.name}" aiScopes entry "${scope}" is an unknown scope. ` +
          `This usually means the plugin was built against a newer server version ` +
          `or is missing a dependency. Check the plugin's minimum server version.`,
        );
      }
    }
  }
}
