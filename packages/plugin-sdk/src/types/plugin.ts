import type { Router } from 'express';
import type { PluginApi } from './api';
import type { PluginAiApi, PluginAiTool, PluginAiContext } from './ai';
import type { PluginTool, PluginToolContext } from './tools';
import type { PluginNavItem, PluginPageDef, PluginSetting, PluginCommand, UiSlotDefinition, UiContribution } from './ui';
import type { PluginJob } from './jobs';
import type { PluginNotificationEvent, PluginNotifyEvent } from './notify';
import type { HookBus } from './hooks';
import type { NamespacedStorage } from './storage';
import type { CloudStorageService, FileStorageService, AutomationRunner } from './services';
import type {
  SettingsApi,
  CloudFilesApi,
  AutomationsApi,
  WebsocketApi,
  ApkApi,
  PathsApi,
} from './ctx-extensions';

export type { PluginNavItem, PluginPageDef, PluginSetting, PluginCommand, UiSlotDefinition, UiContribution };

// --- Logger ---

export interface PluginLogger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

// --- Plugin Context ---

export interface PluginContext {
  readonly pluginName: string;
  /**
   * Absolute filesystem path to this plugin's package root. Use this to
   * resolve assets that ship alongside the plugin (sidecar binaries,
   * data files, templates, etc.) rather than constructing paths relative
   * to the host's CWD — the same plugin can live at `<host>/plugins/<slug>/`
   * (workspace dev) or under the host's managed install prefix
   * (marketplace install), and CWD-relative paths only work for the former.
   *
   * Example:
   *   const sidecarSrc = path.join(ctx.pluginDir, 'sidecar');
   */
  readonly pluginDir: string;
  /**
   * Return a logger scoped to this plugin. System id becomes either
   * `pluginName` (no subsystem) or `pluginName:subsystem`. Repeated calls
   * with the same subsystem return the same logger instance.
   */
  logger(subsystem?: string): PluginLogger;
  nav(items: PluginNavItem[]): void;
  pages(defs: PluginPageDef[]): void;
  routes(setup: (router: Router) => void): void;
  dbTables(schema: Record<string, unknown>): void;
  /**
   * @deprecated Use `tools()` instead. The `aiTools()` API predates the
   * unified tools system (AI chat + MCP + REST + SKILL.md + automation
   * scripts) and is kept only for backward compatibility. New plugins
   * should register tools via `ctx.tools()` and group them via
   * `ctx.toolContexts()`.
   */
  aiTools(tools: PluginAiTool[]): void;
  /**
   * @deprecated Use `toolContexts()` instead. See `aiTools` deprecation note.
   */
  aiContexts(contexts: PluginAiContext[]): void;
  tools(tools: PluginTool[]): void;
  toolContexts(contexts: PluginToolContext[]): void;
  uiSlots(defs: UiSlotDefinition[]): void;
  uiContributions(contribs: UiContribution[]): void;
  jobs(jobs: PluginJob[]): void;
  settingsDefs(defs: PluginSetting[]): void;
  commands(cmds: PluginCommand[]): void;
  notificationEvents(events: PluginNotificationEvent[]): void;
  protocolDecoders(decoders: unknown[]): void;
  scopes(scopes: Array<{ key: string; label: string; description: string; category: string }>): void;
  hooks: HookBus;
  /** AI analysis API — trigger AI analysis with access to registered tools */
  readonly ai: PluginAiApi;
  /** Check if another plugin is loaded (for optional dependency UI) */
  isPluginLoaded(name: string): boolean;
  /**
   * Expose this plugin's typed service so peer plugins can use it.
   * Call from start(). Calling more than once throws.
   *
   * The TypeScript type T is the contract; consumers import T from
   * this plugin's api.ts and pass it to peer<T>(...). The runtime
   * stores the impl untyped — TS enforces the contract at the boundary.
   */
  exposeService<T>(impl: T): void;

  /**
   * Look up a peer plugin's exposed service. Throws if the named plugin
   * is not loaded, or if it is loaded but has not called exposeService yet.
   *
   * Safe to call any time after this plugin's start() begins, because
   * declared dependencies have already finished start() by then.
   */
  peer<T>(pluginName: string): T;

  /**
   * Check if a peer plugin is loaded AND has exposed a service.
   * Use for optional dependencies.
   *
   * Returns `false` (rather than throwing) when the service registry
   * is not wired yet — i.e. when called from `register()`. The registry
   * is wired before `start()` runs, so `hasPeer()` only returns
   * meaningful answers from `start()` onwards. Calling it earlier
   * always returns `false` regardless of whether the named plugin
   * actually exists.
   */
  hasPeer(pluginName: string): boolean;
  // BetterSQLite3Database is widened to `any` so the SDK package compiles
  // without drizzle-orm peer deps. Task 6 will retype service-shape fields.
  db<T extends Record<string, unknown>>(schema: T): any;
  files(): NamespacedStorage;

  /**
   * Register HTTP/WebSocket-REST endpoints. The setup callback receives a
   * per-plugin api object with get/post/put/delete/patch methods that register
   * the endpoint in both the Express router and the WS-REST routing table.
   *
   * Available from start() onwards (services constructed there are typically
   * captured in handler closures).
   */
  api(setup: (api: PluginApi) => void): void;

  /**
   * Emit a notification through the core's notification service. The event
   * is delivered to the user's configured channels (Discord, Slack, ntfy, etc.)
   * subject to their notification preferences. Available after the plugin is
   * loaded; throws if accessed during `register()`.
   */
  notify(event: PluginNotifyEvent): void;

  /**
   * The core's cloud-storage service. Plugins that handle large blobs (tile
   * sets, snapshot files, etc.) use this for upload/download. Available
   * after the plugin is loaded; throws if accessed during `register()`.
   */
  cloudStorage: CloudStorageService;

  /**
   * The core's automation runner — used by plugins that schedule scripted
   * actions in response to events (e.g. user-defined trigger scripts). Most
   * plugins do not need this. Available after the plugin is loaded; throws
   * if accessed during `register()`.
   */
  runner: AutomationRunner;

  /**
   * The core's raw file-sync service. Most plugins should use `files()` for
   * plugin-scoped storage; `fileSync` is the escape hatch for plugins that
   * need cross-namespace operations (e.g. reading APK files from the global
   * APK namespace). Available after the plugin is loaded; throws if accessed
   * during `register()`.
   */
  fileSync: FileStorageService;

  /** Host's settings table — key/value persistence. */
  settings: SettingsApi;

  /** Host's cloudFiles table — sync-state management for namespaced files. */
  cloudFiles: CloudFilesApi;

  /** Host's automations table — read-only listing. */
  automations: AutomationsApi;

  /** Host's websocket layer — broadcasts and filtered channels. */
  websocket: WebsocketApi;

  /** Host's APK tracker — lookup, materialize, analysis sidecar paths. */
  apks: ApkApi;

  /** Host's path helpers — resolve relative paths under DATA_ROOT. */
  paths: PathsApi;
}

// --- Plugin Definition ---

export interface PluginDefinition {
  name: string;
  /**
   * @deprecated The host derives the runtime version from `package.json#version`.
   * Setting it on the definition is allowed for backwards compatibility but
   * does not affect what users see in the marketplace UI; that always comes
   * from the published tarball's package.json. Leave it unset in new plugins.
   */
  version?: string;
  darkride?: string;
  dependencies: string[];
  optionalDependencies: string[];
  aiScopes: string[];
  /**
   * Per-plugin start timeout in ms. Default: 30_000.
   * If start() does not resolve within this window, treated as a fatal
   * peer-init failure (same error shape as if start() had thrown).
   */
  startTimeoutMs?: number;
  /**
   * Synchronous, declarative-only setup. Called once, before any plugin's
   * start(). May call: nav, pages, settings, commands, scopes,
   * notificationEvents, dbTables, hooks.define, uiSlots/uiContributions,
   * tools, toolContexts, jobs that don't depend on services.
   *
   * MUST NOT: construct services, perform I/O, call peer(), register
   * routes that need services, or do anything async.
   */
  register(ctx: PluginContext): void;
  /**
   * Async runtime setup. Called in topological dependency order, AFTER
   * all plugins' register() have run. Inside start(), this plugin's
   * required and optional peers (if loaded) have already finished start().
   *
   * Failure: throwing (or timing out per startTimeoutMs) aborts boot.
   */
  start?(ctx: PluginContext): Promise<void>;
  /**
   * Async teardown. Called in REVERSE topological order during shutdown.
   * Failures are logged but do not stop the shutdown loop.
   */
  stop?(ctx: PluginContext): Promise<void>;
}

export interface PluginInput {
  name: string;
  /**
   * @deprecated Authoritative version is `package.json#version`; the host
   * reads that during discovery and uses it for `pluginState.version`,
   * marketplace "update available" comparisons, and the Plugin Manager UI.
   * Setting it here is allowed but redundant — leave it unset in new plugins.
   */
  version?: string;
  darkride?: string;
  dependencies?: string[];
  optionalDependencies?: string[];
  aiScopes?: string[];
  /** See {@link PluginDefinition.startTimeoutMs}. Default: 30_000. */
  startTimeoutMs?: number;
  register(ctx: PluginContext): void;
  /** See {@link PluginDefinition.start}. Async runtime setup, called in dependency order. */
  start?(ctx: PluginContext): Promise<void>;
  /** See {@link PluginDefinition.stop}. Async teardown, called in reverse dependency order. */
  stop?(ctx: PluginContext): Promise<void>;
}

// --- Plugin Metadata (serializable, sent to frontend) ---

export interface PluginMetadata {
  name: string;
  version: string;
  nav: PluginNavItem[];
  pages: PluginPageDef[];
  settings: PluginSetting[];
  commands: PluginCommand[];
  notificationEvents: PluginNotificationEvent[];
  tools: Array<{ name: string; description: string; contexts: string[] }>;
  toolContexts: PluginToolContext[];
  uiSlots: UiSlotDefinition[];
  uiContributions: UiContribution[];
}
