import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, unique, primaryKey, blob, real } from 'drizzle-orm/sqlite-core';

export const proxies = sqliteTable('proxies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull(),
  username: text('username'),
  password: text('password'),
  failureCount: integer('failure_count').default(0),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(), // ADB device ID or iOS UDID
  name: text('name'),
  platform: text('platform').notNull().default('android'), // 'android' | 'ios'
  isRooted: integer('is_rooted', { mode: 'boolean' }).default(false),
  setupVersion: integer('setup_version').default(0),
  bridgePort: integer('bridge_port'), // Allocated Python Bridge port (9100-9199 android, 9200-9299 ios)
  wgPort: integer('wg_port'), // WireGuard tunnel port for mitmproxy
  fridaVersion: text('frida_version'),
  lastSeen: integer('last_seen', { mode: 'timestamp' }),
  manufacturer: text('manufacturer'),
  model: text('model'),
  androidVersion: text('android_version'),
  iosVersion: text('ios_version'),
  apiLevel: integer('api_level'),
  cpuAbi: text('cpu_abi'),
  serialNumber: text('serial_number'),
  bootloaderLocked: integer('bootloader_locked', { mode: 'boolean' }),
  // FK to device_instances row that spawned this device (managed emulators).
  // Null for unmanaged / physical devices that connect directly via ADB.
  // Declared to match migration 0095's `REFERENCES device_instances(id)` (no
  // ON DELETE — defaults to NO ACTION). Forward ref via callback since
  // deviceInstances is defined below.
  instanceId: integer('instance_id').references(() => deviceInstances.id),
});

/**
 * Managed device-instance lifecycle (emulator support). See spec
 * `docs/specs/2026-05-20-emulator-support-design.md` §7.1.
 *
 * Every emulator created via DarkRide gets a row here. The provider+runtime
 * pair identifies WHO owns it (e.g. `docker-android` + container id, `avd` +
 * AVD name). When the instance boots, an ADB-side `devices` row is matched
 * and linked via `devices.instance_id`.
 */
export const deviceInstances = sqliteTable('device_instances', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  providerId: text('provider_id').notNull(), // 'docker-android' | 'avd' | plugin-id
  runtimeId: text('runtime_id').notNull(),   // container id / AVD name / VM uuid
  displayName: text('display_name'),
  serial: text('serial'),                     // ADB serial once known
  state: text('state').notNull(),             // DeviceInstanceState
  spawnedByDarkride: integer('spawned_by_darkride', { mode: 'boolean' }).notNull().default(false),
  spawnMetadata: text('spawn_metadata', { mode: 'json' }).$type<Record<string, unknown>>(), // provider-specific snapshot of spawn opts
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastStateAt: integer('last_state_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Per-instance config bag (key/value strings). Holds provider-specific
 * settings the create flow collected (image tag, RAM/CPU sliders, etc.)
 * without polluting the canonical instance row.
 */
export const deviceInstanceConfig = sqliteTable('device_instance_config', {
  instanceId: integer('instance_id').notNull().references(() => deviceInstances.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (table) => [
  primaryKey({ columns: [table.instanceId, table.key] }),
]);

export const automations = sqliteTable('automations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  code: text('code').notNull(),
  passcode: text('passcode').notNull(),
  requiresDevice: integer('requires_device', { mode: 'boolean' }).notNull().default(true),
  requiresHttpsCapture: integer('requires_https_capture', { mode: 'boolean' }).default(false),
  timeoutMs: integer('timeout_ms').default(300000),
  isRule: integer('is_rule', { mode: 'boolean' }).default(false),
  isCaptureRule: integer('is_capture_rule', { mode: 'boolean' }).default(false),
  priority: integer('priority').default(0),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  schedule: text('schedule'), // JSON: ScheduleConfig | null
  deviceFilter: text('device_filter'), // JSON: DeviceFilter | null
  // ── Managed-automations framework (2026-06-06) ─────────────────────────
  // Plugins can register automations they own via ctx.managedAutomations.
  // The host stamps provenance + a 3-way merge state machine on the row,
  // but execution/scheduling/sessions reuse the existing engine unchanged.
  // "Managed" is just `managed_by IS NOT NULL`.
  /** Owning plugin name. NULL = ordinary automation. */
  managedBy: text('managed_by'),
  /** Plugin-stable script key. Unique with managedBy. */
  managedKey: text('managed_key'),
  /** The default the plugin currently ships (refreshed every plugin load). */
  currentDefaultCode: text('current_default_code'),
  /** The default the operator's override was forked from (merge ancestor). */
  baseDefaultCode: text('base_default_code'),
  /** Has the operator forked the script? */
  isOverridden: integer('is_overridden', { mode: 'boolean' }).notNull().default(false),
  /** Does the plugin permit forking? Drives the IDE component. */
  allowUserOverride: integer('allow_user_override', { mode: 'boolean' }).notNull().default(true),
  /**
   * Snapshot of the schedule the plugin currently ships, refreshed every
   * plugin load. NOT a tracked override — the operator's actual `schedule`
   * is what runs; this is only the "revert to default" target the SDK IDE
   * offers when the operator's value differs.
   */
  currentDefaultSchedule: text('current_default_schedule'),
  /** Same idea for `enabled` — the plugin's current default, separate from the operator-owned `enabled` field. */
  currentDefaultEnabled: integer('current_default_enabled', { mode: 'boolean' }),
  /**
   * One-line description from the plugin's ManagedAutomationDef. Nullable
   * because ordinary (non-managed) automations don't carry one. Refreshed
   * on every plugin load through the reconciler's insert + silent-adopt +
   * preserve-override paths.
   */
  description: text('description'),
  /**
   * Opt-in: should a failed managed run fire the standard `automation:failure`
   * notification event? Default false — operator didn't author the script,
   * most plugins surface health in their own UI. Ordinary (non-managed) rows
   * still fire failure notifications unconditionally (this column is
   * ignored when managed_by IS NULL).
   */
  emitFailureNotification: integer('emit_failure_notification', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const automationSessions = sqliteTable('automation_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  automationId: integer('automation_id').references(() => automations.id),
  deviceId: text('device_id').references(() => devices.id),
  name: text('name'),
  status: text('status', { enum: ['running', 'success', 'failed', 'cancelled'] }).notNull(),
  triggerType: text('trigger_type').notNull(),
  logs: text('logs'),
  isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  /**
   * Denormalised at session creation from automation.managed_by IS NOT NULL.
   * Lets the session-history default filter ("hide managed") be a plain
   * column scan with no join. Back-filled to 0 when an automation is
   * orphaned from its plugin so the operator's now-owned history is visible.
   */
  managed: integer('managed', { mode: 'boolean' }).notNull().default(false),
});

export const screenshots = sqliteTable('screenshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').references(() => automationSessions.id),
  filename: text('filename').notNull(),
  name: text('name'),
  domSnapshot: text('dom_snapshot'),
  capturedAt: integer('captured_at', { mode: 'timestamp' }).notNull(),
});

export const capturedTraffic = sqliteTable('captured_traffic', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').references(() => automationSessions.id),
  deviceId: text('device_id').references(() => devices.id),
  requestMethod: text('request_method').notNull(),
  requestUrl: text('request_url').notNull(),
  hostname: text('hostname'),
  requestHeaders: text('request_headers'),
  requestBody: text('request_body'),
  responseStatus: integer('response_status'),
  responseHeaders: text('response_headers'),
  responseBody: text('response_body'),
  responseBodyBinary: blob('response_body_binary', { mode: 'buffer' }),
  responseContentType: text('response_content_type'),
  type: text('type').default('http'),
  wsCloseCode: integer('ws_close_code'),
  wsCloseReason: text('ws_close_reason'),
  wsMessageCount: integer('ws_message_count').default(0),
  capturedAt: integer('captured_at', { mode: 'timestamp' }).notNull(),
  matchedRules: text('matched_rules'),
});

export const websocketMessages = sqliteTable('websocket_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trafficId: integer('traffic_id').references(() => capturedTraffic.id),
  sessionId: integer('session_id').references(() => automationSessions.id),
  deviceId: text('device_id').references(() => devices.id),
  direction: text('direction').notNull(), // 'send' | 'receive'
  opcode: text('opcode').notNull(), // 'text' | 'binary' | 'close'
  payload: text('payload'),
  isBinary: integer('is_binary', { mode: 'boolean' }).default(false),
  payloadSize: integer('payload_size').default(0),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
});

export const savedTraffic = sqliteTable('saved_traffic', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull(),
  method: text('method').notNull(),
  requestHeaders: text('request_headers'),
  requestBody: text('request_body'),
  responseStatus: integer('response_status'),
  responseHeaders: text('response_headers'),
  responseBody: text('response_body'),
  deviceId: text('device_id'),
  savedAt: integer('saved_at', { mode: 'timestamp' }).notNull(),
});

export const blockedDomains = sqliteTable('blocked_domains', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  domain: text('domain').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const hiddenDomains = sqliteTable('hidden_domains', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  domain: text('domain').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const credentials = sqliteTable('credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  appId: text('app_id').notNull(),
  username: text('username').notNull(),
  password: text('password').notNull(),
  customFields: text('custom_fields'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export interface RestartRequiredState {
  reason: string;
  since: number;
}

export const systemState = sqliteTable('system_state', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<RestartRequiredState>().notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const trackedApps = sqliteTable('tracked_apps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  packageName: text('package_name').notNull().unique(),
  appName: text('app_name'),
  autoFetchPlayStore: integer('auto_fetch_play_store', { mode: 'boolean' }).default(true),
  lastPlayStoreVersion: text('last_play_store_version'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const apkVersions = sqliteTable('apk_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trackedAppId: integer('tracked_app_id').references(() => trackedApps.id).notNull(),
  versionCode: integer('version_code').notNull(),
  versionName: text('version_name'),
  filename: text('filename').notNull(),
  fileSize: integer('file_size'),
  deviceId: text('device_id'),
  source: text('source').default('device'), // 'device' | 'playstore' | 'upload'
  downloadedAt: integer('downloaded_at', { mode: 'timestamp' }).notNull(),
});

export const analysisJobs = sqliteTable('analysis_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  apkVersionId: integer('apk_version_id').references(() => apkVersions.id).notNull(),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  stage: text('stage'), // null | 'metadata' | 'decompiling' | 'storing' | 'scanning' | 'done'
  error: text('error'),
  /** When true, skip the AI review step at end of pipeline (used for regeneration after cloud re-download — AI notes already exist). */
  skipAiReview: integer('skip_ai_review', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

export const apkNotes = sqliteTable('apk_notes', {
  versionId: integer('version_id').primaryKey().references(() => apkVersions.id, { onDelete: 'cascade' }),
  content: text('content').notNull().default(''),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const injectedApks = sqliteTable('injected_apks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trackedAppId: integer('tracked_app_id').references(() => trackedApps.id),
  packageName: text('package_name').notNull(),
  versionCode: integer('version_code').notNull(),
  versionName: text('version_name'),
  fridaVersion: text('frida_version').notNull(),
  filename: text('filename').notNull(),
  fileSize: integer('file_size'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const fridaScripts = sqliteTable('frida_scripts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  code: text('code').notNull(),
  targetApp: text('target_app'),
  description: text('description'),
  category: text('category'),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const dbSizeSnapshots = sqliteTable('db_size_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sizeBytes: integer('size_bytes').notNull(),
  capturedAt: integer('captured_at', { mode: 'timestamp' }).notNull(),
});

export const diskUsageSnapshots = sqliteTable('disk_usage_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  capturedAt: integer('captured_at', { mode: 'timestamp' }).notNull(),
  volumeTotalBytes: integer('volume_total_bytes').notNull(),
  volumeFreeBytes: integer('volume_free_bytes').notNull(),
  // JSON map of top-level subdir name -> size in bytes, e.g. {"couchbase":23622320128}
  dirSizes: text('dir_sizes', { mode: 'json' }).$type<Record<string, number>>().notNull(),
});

export const cloudFiles = sqliteTable('cloud_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  namespace: text('namespace').notNull().default(''),
  /** DATA_ROOT-relative path, e.g. "apks/pkg/file.apk" or "plugins/maps/data.bin".
   *  Absolute path is computed via `absoluteLocalPath(row.relativePath)`. */
  relativePath: text('relative_path').notNull().default(''),
  cloudKey: text('cloud_key').notNull().unique(),
  fileType: text('file_type').notNull(),
  fileSize: integer('file_size').notNull(),
  syncState: text('sync_state').notNull(),
  syncError: text('sync_error'),
  retain: integer('retain', { mode: 'boolean' }).notNull().default(false),
  lastAccessed: integer('last_accessed', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const aiConversations = sqliteTable('ai_conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pageContext: text('page_context').notNull(),
  contextId: text('context_id').notNull(),
  title: text('title'),
  messages: text('messages').notNull(), // JSON array of AiMessage[]
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  /** Claude CLI session ID for --resume support (null for non-CLI conversations) */
  claudeSessionId: text('claude_session_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const aiProviders = sqliteTable('ai_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  apiKey: text('api_key'),
  baseUrl: text('base_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const aiTiers = sqliteTable('ai_tiers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull(),
  isHardcoded: integer('is_hardcoded', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const aiModels = sqliteTable('ai_models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  providerId: integer('provider_id').references(() => aiProviders.id),
  model: text('model'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  priority: integer('priority').notNull().default(0),
  cooldownMinutes: integer('cooldown_minutes').default(10),
  tierId: integer('tier_id').references(() => aiTiers.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const fridaReleases = sqliteTable('frida_releases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  version: text('version').notNull().unique(),
  downloadUrl: text('download_url').notNull(),
  releaseDate: integer('release_date', { mode: 'timestamp' }),
  isDownloaded: integer('is_downloaded', { mode: 'boolean' }).default(false),
  fileSize: integer('file_size'),
  gadgetDownloadUrl: text('gadget_download_url'),
});

export const apkContents = sqliteTable('apk_contents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  apkVersionId: integer('apk_version_id').references(() => apkVersions.id).notNull(),
  apkName: text('apk_name').notNull(),
  entriesJson: text('entries_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const apkDiffReports = sqliteTable('apk_diff_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  apkVersionId: integer('apk_version_id').references(() => apkVersions.id).notNull(),
  compareVersionId: integer('compare_version_id').references(() => apkVersions.id).notNull(),
  status: text('status', { enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'] }).notNull().default('pending'),
  diffJson: text('diff_json'),
  aiSummary: text('ai_summary'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

export const apiEndpointGroups = sqliteTable('api_endpoint_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description'),
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const apiEndpoints = sqliteTable('api_endpoints', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  method: text('method').notNull(),
  hostname: text('hostname').notNull(),
  pathPattern: text('path_pattern').notNull(),
  firstSeen: integer('first_seen', { mode: 'timestamp' }).notNull(),
  lastSeen: integer('last_seen', { mode: 'timestamp' }).notNull(),
  requestCount: integer('request_count').default(1),
  sampleRequestHeaders: text('sample_request_headers'),
  sampleRequestBody: text('sample_request_body'),
  sampleResponseStatus: integer('sample_response_status'),
  sampleResponseHeaders: text('sample_response_headers'),
  sampleResponseBody: text('sample_response_body'),
  groupId: integer('group_id').references(() => apiEndpointGroups.id),
  responseSpec: text('response_spec'),
}, (table) => [
  unique().on(table.method, table.hostname, table.pathPattern),
]);

export const apiEndpointSessions = sqliteTable('api_endpoint_sessions', {
  endpointId: integer('endpoint_id').notNull().references(() => apiEndpoints.id),
  sessionId: integer('session_id').notNull().references(() => automationSessions.id),
}, (table) => [
  primaryKey({ columns: [table.endpointId, table.sessionId] }),
]);

export const apiEndpointGroupPatterns = sqliteTable('api_endpoint_group_patterns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  groupId: integer('group_id').notNull().references(() => apiEndpointGroups.id),
  pattern: text('pattern').notNull(),
  patternType: text('pattern_type').notNull().default('exact'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
}, (table) => [
  unique().on(table.groupId, table.pattern),
]);

export const apiEndpointQueryParams = sqliteTable('api_endpoint_query_params', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  endpointId: integer('endpoint_id').notNull().references(() => apiEndpoints.id),
  paramName: text('param_name').notNull(),
  sampleValues: text('sample_values').notNull().default('[]'), // JSON array of strings, max 10
  occurrenceCount: integer('occurrence_count').notNull().default(1),
  firstSeen: integer('first_seen', { mode: 'timestamp' }).notNull(),
  lastSeen: integer('last_seen', { mode: 'timestamp' }).notNull(),
});

export const notificationChannels = sqliteTable('notification_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'discord' | 'slack' | 'telegram' | 'webhook' | 'ntfy' | 'gotify' | 'email'
  config: text('config').notNull(), // JSON: channel-specific config
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  events: text('events').notNull(), // JSON array of subscribed event types
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const notificationHistory = sqliteTable('notification_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: integer('channel_id').references(() => notificationChannels.id),
  channelName: text('channel_name').notNull(),
  eventType: text('event_type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  sourceType: text('source_type'), // 'automation' | 'apk' | 'device' | 'map' | 'capture'
  sourceId: text('source_id'),
  success: integer('success', { mode: 'boolean' }).default(true),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const notificationQueue = sqliteTable('notification_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull(), // JSON-serialised NotificationEvent
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const jobConfig = sqliteTable('job_config', {
  jobId: text('job_id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  schedule: text('schedule'), // cron expression or interval description
  lastRunAt: integer('last_run_at'), // unix ms; null = never run
  lastError: text('last_error'),     // error message from last run, or null on success
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const interceptRules = sqliteTable('intercept_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  matchHostname: text('match_hostname').notNull(),
  matchPath: text('match_path'),
  matchMethod: text('match_method'),
  matchStatusCode: text('match_status_code'),
  matchHeader: text('match_header'),
  matchBody: text('match_body'),
  phase: text('phase', { enum: ['request', 'response'] }).notNull(),
  actions: text('actions').notNull(),
  deviceFilter: text('device_filter'),
  priority: integer('priority').notNull().default(0),
  sessionId: integer('session_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const clientCerts = sqliteTable('client_certs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  hostnames: text('hostnames').notNull(),
  certPem: text('cert_pem').notNull(),
  keyPem: text('key_pem').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  sessionId: integer('session_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const pluginState = sqliteTable('plugin_state', {
  name: text('name').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  installedVia: text('installed_via').notNull().default('workspace'),
  version: text('version'),
  description: text('description'),
  author: text('author'),
  npmPackage: text('npm_package'),
  installedAt: integer('installed_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
  signature: text('signature'),
  signedBy: text('signed_by'),
  approvedAiScopes: text('approved_ai_scopes', { mode: 'json' }).$type<string[] | null>(),
  /**
   * Last fatal error (e.g. migration failure) that caused the host to
   * auto-disable this plugin. Null when the plugin booted cleanly.
   * Surfaced via /v1/plugins/installed so the UI can show the user what
   * went wrong without making them dig through logs.
   */
  lastError: text('last_error'),
});

export const pluginSources = sqliteTable('plugin_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'registry' | 'git'
  url: text('url').notNull(),
  authToken: text('auth_token'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  priority: integer('priority').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

export const pluginMigrations = sqliteTable('plugin_migrations', {
  pluginName: text('plugin_name').notNull(),
  filename: text('filename').notNull(),
  appliedAt: integer('applied_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.pluginName, t.filename] }),
}));

export const pluginInstalls = sqliteTable('plugin_installs', {
  name: text('name').primaryKey().notNull(),
  npmPackage: text('npm_package').notNull(),
  sourceUrl: text('source_url').notNull(),
  resolvedRef: text('resolved_ref'),
  sourceId: integer('source_id'),
  /**
   * Auth token used at install time. Persisted so replay-on-boot can
   * re-authenticate against private repos when the originating source
   * row has been deleted (or the install was via raw URL with no
   * sourceId in the first place). Stored at the same security level
   * as pluginSources.authToken — opaque in DB, never logged.
   * Nullable for backwards-compatible rows from pre-0090 installs.
   */
  authToken: text('auth_token'),
  installedAt: integer('installed_at').notNull(),
});

export const trustedSigningKeys = sqliteTable('trusted_signing_keys', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  label: text('label').notNull(),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull().default(false),
  addedBy: integer('added_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

// ---- Auth tables ----

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  email: text('email'),
  displayName: text('display_name'),
  passwordHash: text('password_hash'),
  passwordUpdatedAt: integer('password_updated_at', { mode: 'timestamp' }),
  passwordMustChange: integer('password_must_change', { mode: 'boolean' }).notNull().default(false),
  providerId: text('provider_id').notNull(),
  externalId: text('external_id'),
  scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  kind: text('kind', { enum: ['human', 'core-service', 'plugin-service'] as const })
    .notNull().default('human'),
  serviceOwner: text('service_owner'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  lockedUntil: integer('locked_until', { mode: 'timestamp' }),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  userAgent: text('user_agent'),
  ipHash: text('ip_hash'),
  csrfToken: text('csrf_token').notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
});

export const apiKeys = sqliteTable('api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  internal: integer('internal', { mode: 'boolean' }).notNull().default(false),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
});

export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  purpose: text('purpose').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
});

export const aiCallLog = sqliteTable('ai_call_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
  identityType: text('identity_type', {
    enum: ['user', 'core-service', 'plugin', 'plugin-acting-for-user'] as const,
  }).notNull(),
  actorUserId: integer('actor_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  onBehalfOfPlugin: text('on_behalf_of_plugin'),
  onBehalfOfService: text('on_behalf_of_service'),
  actingForUserId: integer('acting_for_user_id')
    .references(() => users.id, { onDelete: 'set null' }),
  effectiveScopes: text('effective_scopes', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  pageContext: text('page_context'),
  contextId: text('context_id'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  turns: integer('turns'),
  costUsd: real('cost_usd'),
  outcome: text('outcome', { enum: ['success', 'error', 'aborted'] as const }),
  error: text('error'),
});

export * from './oauth-schema';
