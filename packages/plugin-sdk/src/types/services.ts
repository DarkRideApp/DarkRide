/**
 * Host service-shape interfaces. Plugins receive instances of these via
 * `ctx.cloudStorage`, `ctx.fileSync`, `ctx.runner`, etc. Backend classes
 * implement these interfaces.
 *
 * Implementations live in `backend/services/*.ts`. This file is the
 * public contract — plugins type against these, backend declares
 * `implements`.
 */

import type { NamespacedStorage } from './storage';

// ---------------------------------------------------------------------------
// Helper interfaces referenced by service methods.
// (Moved from backend/services/* into the SDK to keep service interfaces
// self-contained.)
// ---------------------------------------------------------------------------

/** S3-compatible cloud storage configuration. */
export interface CloudStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  provider: string; // 's3' | 'b2' | 'r2' | 'custom'
}

/** Result of a list-objects call. */
export interface ListResult {
  prefixes: string[];
  files: { key: string; size: number; lastModified: Date | null }[];
}

/** Snapshot of local-cache and cloud-sync health. */
export interface CloudStatus {
  configured: boolean;
  localCacheUsageMb: number;
  localCacheBudgetMb: number;
  filesTracked: number;
  filesCloudOnly: number;
  pendingUploads: number;
  errors: { cloudKey: string; error: string }[];
}

/** Result of acquiring a local copy of a cloud-tracked file. */
export interface AcquireResult {
  path?: string;
  error?: string;
}

/** Quiet-hours schedule that suppresses non-critical notifications. */
export interface QuietHoursConfig {
  enabled: boolean;
  startTime: string;   // "HH:MM" (24-hour)
  endTime: string;     // "HH:MM" (24-hour)
  timezone: string;    // IANA timezone, e.g. "America/New_York"
  daysOfWeek: number[]; // 0=Sunday, 1=Monday, ..., 6=Saturday
}

/** Notification event payload passed to `NotificationService.emit()`. */
export interface NotificationEvent {
  type: string;
  title: string;
  body: string;
  sourceType?: string;
  sourceId?: string;
  /** Deep link path within the UI, e.g. /ui/automations/session/42 */
  url?: string;
}

/** Per-channel delivery configuration (Discord, Slack, Telegram, email, webhook, etc.). */
export interface ChannelConfig {
  // Discord / Slack / Webhook / ntfy / gotify
  url?: string;
  // Telegram
  botToken?: string;
  chatId?: string;
  // Webhook / ntfy / gotify — custom HTTP headers
  headers?: Record<string, string>;
  // ntfy helpers
  topic?: string;
  // gotify helpers
  appToken?: string;
  // Email (SMTP)
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  fromAddress?: string;
  toAddresses?: string;
}

/**
 * Schema-only definition for an AI tool (no execute function).
 * Mirrors `AiToolDefinition` from `shared/types/ai-chat.ts`; duplicated here
 * so the plugin SDK has no dependency on the host's shared module.
 */
export interface AiToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  /** Which page contexts this tool is available in (e.g. ['devices', 'automations']). */
  context: string[];
}

// ---------------------------------------------------------------------------
// Service interfaces.
// ---------------------------------------------------------------------------

/**
 * Cloud-storage service — upload/download large blobs via S3-compatible API.
 * Implementation: backend/services/cloud-storage.ts.
 */
export interface CloudStorageService {
  /** (Re)configure the S3 client with new credentials/endpoint. Clears presign cache. */
  configure(config: CloudStorageConfig): void;

  /** Flush pending hash state and release resources. Call on server shutdown. */
  shutdown(): void;

  /** Returns true if the client has been configured with valid credentials. */
  isConfigured(): boolean;

  /** Number of presigned URLs currently held in the in-memory cache. */
  getPresignCacheSize(): number;

  /**
   * Upload a file to cloud storage. Returns true if actually uploaded,
   * false if dedup-skipped (identical file already present).
   */
  upload(cloudKey: string, localPath: string): Promise<boolean>;

  /** Download an object to a local file path. Returns `{ error }` on failure. */
  download(cloudKey: string, localPath: string): Promise<{ error?: string }>;

  /** Download an object directly into a Buffer (no temp file). */
  downloadBuffer(cloudKey: string): Promise<{ buffer?: Buffer; error?: string }>;

  /**
   * Download multiple keys concurrently, calling `onItem` for each successful
   * download. Returns the number of successful downloads.
   */
  downloadBatch(
    keys: string[],
    concurrency: number,
    onItem: (key: string, buffer: Buffer, index: number) => void,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number>;

  /** Delete an object from cloud storage. */
  delete(cloudKey: string): Promise<void>;

  /** Returns true if the object exists in cloud storage. */
  exists(cloudKey: string): Promise<boolean>;

  /**
   * Return a presigned download URL for the object. Result is cached.
   * Returns null if cloud storage is not configured.
   */
  presignUrl(cloudKey: string, expiresInSec?: number): Promise<string | null>;

  /** Verify the configured bucket is reachable. Throws if not. */
  headBucket(): Promise<void>;

  /** List objects (files and common prefixes) under a prefix. */
  listObjects(prefix: string, delimiter?: string): Promise<ListResult>;

  /** List ALL object keys under a prefix (paginated, no delimiter). */
  listAllKeys(prefix: string): Promise<string[]>;

  /**
   * List ALL objects under a prefix with their ETags (paginated).
   * For single-part uploads, ETag is the MD5 hex hash of the content.
   */
  listAllKeysWithETags(prefix: string): Promise<{ key: string; etag: string }[]>;
}

/**
 * File-storage service — local-first file management with transparent cloud sync.
 * Implementation: backend/services/file-storage.ts.
 */
export interface FileStorageService {
  /**
   * Return a namespaced storage handle scoped to a plugin.
   * Data is stored under `data/plugins/<pluginName>/` locally and
   * `plugins/<pluginName>/` in cloud.
   */
  forPlugin(pluginName: string): NamespacedStorage;

  /**
   * Return a namespaced storage handle for a generic namespace.
   * Data is stored under `data/<namespace>/` locally and `<namespace>/` in cloud.
   */
  forNamespace(namespace: string): NamespacedStorage;

  /** Start background upload, eviction, backup, and session-sync workers. */
  start(): void;

  /** Stop all background workers. */
  stop(): void;

  /**
   * Register a local file for cloud upload.
   * No-op if cloud storage is not configured.
   */
  trackFile(localPath: string, cloudKey: string, fileType: string, fileSize: number): void;

  /**
   * Ensure a cloud-tracked file is available locally (downloading if necessary).
   * Returns the resolved local path on success.
   */
  acquireLocal(cloudKey: string, holder: string, localPath?: string): Promise<AcquireResult>;

  /**
   * Acquire all cloud-tracked files whose keys start with `prefix`.
   * Used to recover split APK sub-files. Returns `{ error }` on any failure.
   */
  acquireLocalByPrefix(prefix: string, holder: string): Promise<{ error?: string }>;

  /** Return a presigned download URL for a cloud key. */
  getDirectUrl(cloudKey: string): Promise<string | null>;

  /** Delete a file from cloud, disk, and the tracking database. */
  removeFile(cloudKey: string): Promise<void>;

  /** Return a snapshot of current cloud-sync health and cache usage. */
  getStatus(): CloudStatus;

  /** Clear a sync error for a cloud key so the upload worker will retry it. */
  retryUpload(cloudKey: string): void;

  /** Run a cloud backup immediately (public, for job system). Throws if cloud not configured. */
  runBackupNow(): Promise<void>;

  /**
   * Sync pinned automation sessions — queue any untracked screenshots for upload.
   * Returns counts of sessions and files processed.
   */
  syncPinnedSessions(): Promise<{
    pinnedSessions: number;
    screenshots: number;
    queued: number;
    alreadyTracked: number;
    missingOnDisk: number;
  }>;
}

/**
 * Automation runner — compiles and executes automation scripts.
 * Implementation: backend/services/automation-runner.ts.
 *
 * Note: `setHookBus`, `setNotificationService`, `setIosDeviceManager`,
 * `setToolRegistry`, and `runRules` take host-specific types and are not
 * included in this interface. The plugin surface is limited to the
 * automation execution and rule query methods.
 */
export interface AutomationRunner {
  /**
   * Run an automation by ID. Creates a session, compiles the code, and
   * executes it in a sandbox. Returns the session ID and success state.
   */
  runAutomation(
    automationId: number,
    deviceId: string | undefined,
    triggerType: string,
  ): Promise<{ sessionId: number; success: boolean; error?: string }>;

  /**
   * Return all enabled rules (non-capture) ordered by priority.
   * Rules are automations with `isRule: true`.
   */
  getRules(): Array<{
    id: number;
    name: string;
    code: string;
    priority: number | null;
  }>;

  /**
   * Return all enabled capture rules ordered by priority.
   * Capture rules are automations with `isCaptureRule: true`.
   */
  getCaptureRules(): Array<{
    id: number;
    name: string;
    code: string;
    priority: number | null;
  }>;

  /**
   * Execute all enabled capture rules for a device. Each rule may register
   * long-lived traffic-hook callbacks; their isolates are retained until
   * `disposeCaptureRuleIsolates` is called.
   */
  runCaptureRules(deviceId: string, sessionId: number): Promise<void>;

  /**
   * Dispose every persistent capture-rule isolate for a device. Safe to call
   * when there are no active isolates.
   */
  disposeCaptureRuleIsolates(deviceId: string): void;
}

/**
 * Notification service — dispatch events to configured channels (Discord, Slack,
 * Telegram, email, webhook, ntfy, gotify). Respects quiet-hours scheduling.
 * Implementation: backend/services/notification-service.ts.
 */
export interface NotificationService {
  /**
   * Emit a notification event (fire-and-forget). Dispatches to all enabled
   * channels subscribed to this event type. Non-critical events are queued
   * during quiet hours and flushed when quiet hours end.
   */
  emit(event: NotificationEvent): void;

  /**
   * Send a test notification directly to a specific channel, bypassing event
   * subscription checks. Returns the delivery result.
   */
  testChannel(channelId: number): Promise<{ success: boolean; error?: string }>;

  /** Return the current quiet-hours configuration, or null if not set. */
  getQuietHoursConfig(): QuietHoursConfig | null;

  /** Number of events currently queued (waiting for quiet hours to end). */
  getQueuedCount(): number;

  /**
   * Return recent notification history, newest first.
   * History rows are host-specific DB rows; typed as `unknown` here.
   * Cast to the concrete row type when needed inside the host.
   */
  getHistory(limit?: number, offset?: number): unknown[];

  /** Delete notification history entries older than `cutoffDate`. */
  pruneHistory(cutoffDate: Date): void;
}

/**
 * Registry for AI tools — register, discover, and execute named tools.
 * Implementation: backend/services/ai-tools.ts.
 */
export interface AiToolRegistry {
  /** Register a tool (overwrites if name already exists). */
  register(tool: AiToolDefinition & {
    execute: (params: any) => Promise<any>;
    requiredScope?: string;
    requiresConfirmation?: boolean;
    allowUnattended?: boolean;
  }): void;

  /**
   * Return schema-only definitions (no `execute`) for a single context,
   * plus the `request_tools` meta-tool.
   */
  getToolDefinitions(context: string): AiToolDefinition[];

  /**
   * Return deduplicated schema-only definitions for multiple contexts,
   * plus the `request_tools` meta-tool.
   */
  getToolDefinitionsForContexts(contexts: string[]): AiToolDefinition[];

  /** Check if a tool requires user confirmation. */
  requiresConfirmation(name: string): boolean;

  /**
   * Execute a registered tool by name.
   * Optionally checks `userScopes` against the tool's `requiredScope`.
   * When `unattended` is true, tools with `allowUnattended: false` are blocked.
   * Throws if the tool is unknown, blocked, or the caller lacks the required scope.
   */
  executeTool(name: string, params: any, userScopes?: Set<string>, unattended?: boolean): Promise<any>;

  /** Return every unique context string across all registered tools. */
  listContexts(): string[];

  /**
   * Return contexts that have at least one tool accessible given the filter options.
   */
  listAccessibleContexts(userScopes?: Set<string>, unattended?: boolean): string[];

  /**
   * Return schema-only definitions for a single context, filtered by user scopes
   * and unattended mode. Plus the `request_tools` meta-tool.
   */
  getToolDefinitionsForUser(context: string, userScopes?: Set<string>, unattended?: boolean): AiToolDefinition[];

  /**
   * Return deduplicated schema-only definitions for multiple contexts,
   * filtered by user scopes and unattended mode, plus the `request_tools` meta-tool.
   */
  getToolDefinitionsForContextsForUser(contexts: string[], userScopes?: Set<string>, unattended?: boolean): AiToolDefinition[];
}
