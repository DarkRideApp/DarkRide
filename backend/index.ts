import { mkdirSync, statSync, existsSync } from 'fs';
import { join as pathJoin } from 'path';
import { app, httpServer, mountApiRouter } from './app';
import { initDatabase } from './db/index';
import { pruneOldData, cleanStaleSessions } from './db/prune';
import { setupWebSocket, getWebSocketServer, setStartupPhase, broadcastToAll } from './websocket/index';
import { createLoggers } from './logs';
import { DeviceManager } from './services/device-manager';
import { ProxyRotator } from './services/proxy-rotator';
import { PythonBridgeManager, ensureVenvAsync } from './services/python-bridge';
import { AutomationCompiler } from './services/automation-compiler';
import { AutomationRunner } from './services/automation-runner';
import { reconcileManagedAutomations } from './services/managed-automation-reconciler';
import { AutomationScheduler } from './services/automation-scheduler';
import { MitmproxyManager } from './services/mitmproxy-manager';
import { registerProxyEndpoints } from './api/proxies';
import { registerDeviceEndpoints } from './api/devices';
import { registerTrafficEndpoints } from './api/traffic';
import { registerAutomationEndpoints } from './api/automations';
import { registerManagedAutomationEndpoints } from './api/managed-automations';
import { registerAutomationTemplateEndpoints } from './api/automation-templates';
import { registerLiveStreamEndpoints, hasActiveViewers } from './websocket/live-stream';
import { registerAutomationWebsocketEndpoints } from './websocket/automation-handlers';
import { registerLiveLogEndpoints } from './websocket/livelog-handlers';
import { registerAdbShellEndpoints } from './websocket/adb-shell-handlers';
import { registerHostShellEndpoints } from './websocket/host-shell-handlers';
import { CaptureSessionManager } from './services/capture-session-manager';
import { registerCaptureEndpoints } from './api/capture';
import { registerBlocklistEndpoints } from './api/blocklist';
import { registerHiddenlistEndpoints } from './api/hiddenlist';
import { registerCredentialsEndpoints } from './api/credentials';
import { registerSettingsEndpoints } from './api/settings';
import { registerEndpoint, getApiRouter } from './api/api-service';
import { registerAiCompleteEndpoints } from './api/ai-complete';
import { registerAiChatApiEndpoints } from './api/ai-chat';
import { registerAppEndpoints } from './api/apps';
import { registerAppsUploadEndpoint } from './api/apps-upload';
import { registerUtilsEndpoints } from './api/utils';
import { dbSizeSnapshots, diskUsageSnapshots, settings, apkVersions, apkDiffReports, trackedApps, devices, deviceInstances, aiModels, aiProviders, capturedTraffic } from './db/schema';
import * as schema from './db/schema';
import { SavedTrafficStore } from './services/saved-traffic-store';
import { registerSavedTrafficEndpoints } from './api/saved-traffic';
import { ProxiedRequestService } from './services/proxied-request-service';
import { registerProxiedRequestEndpoints } from './api/proxied-requests';
import { syncBlocklistFile } from './services/blocklist-writer';
import { syncHiddenlistFile } from './services/hiddenlist-writer';
import { trafficHookRegistry } from './services/traffic-hook-registry';
import { ApkTracker } from './services/apk-tracker';
import { createSourceRegistry } from './services/apk-sources';
import { ApkAnalyzerService } from './services/apk-analyzer';
import { FridaReleaseManager } from './services/frida-release-manager';
import { registerFridaEndpoints, registerFridaGadgetEndpoints } from './api/frida';
import { seedFridaScriptLibrary } from './services/frida-script-library';
import { GadgetInjector } from './services/gadget-injector';
import { ToolManager } from './services/tool-manager';
import { registerToolEndpoints } from './api/tools';
import { registerAnalysisEndpoints } from './api/analysis';
import { eq, desc, sql, and, isNull, isNotNull } from 'drizzle-orm';
import { CloudStorageService } from './services/cloud-storage';
import { FileStorageService } from './services/file-storage';
import { registerCloudEndpoints } from './api/cloud';
import { AiToolRegistry } from './services/ai-tools';
import { mountMcpSseServer } from './services/mcp-server';
import { ClaudeCliProvider, writeMcpConfig } from './services/claude-cli-provider';
import { registerAllTools } from './services/ai-tool-definitions';
import { AiAgent, type AiAgentInterface, type TierConfig } from './services/ai-agent';
import { ClaudeCliAgent } from './services/claude-cli-agent';
import { createProvider } from './services/ai-provider';
import type { AiProvider } from './services/ai-provider';
import { registerAiChatEndpoints } from './websocket/ai-chat-handlers';
import { AiModelRouter, RateLimitCache } from './services/ai-model-router';
import { migrateAiSettingsToModels } from './db/migrate-ai-models';
import { migrateAiProviders } from './db/migrate-ai-providers';
import { registerAiModelEndpoints } from './api/ai-models';
import { registerAiProviderEndpoints } from './api/ai-providers';
import { registerAiTiersRoutes } from './api/ai-tiers';
import { AiTierStore } from './services/ai-tier-store';
import { ApkDiffEngine, DEFAULT_DIFF_PROMPT } from './services/apk-diff-engine';
import { registerApkDiffEndpoints } from './api/diff';
import { registerApkAvailabilityEndpoints } from './api/apk-availability';
import { ApkRestoreService } from './services/apk-restore-service';
import { registerApiCatalogueEndpoints } from './api/api-catalogue';
import { registerChangelogEndpoints } from './api/changelog';
import { mountFileServing } from './api/file-serving';
import { refreshPatternCache } from './services/api-catalogue';
import { APK_DIR, lookupVersionMeta, ensureApkLocal, analysisDbPath } from './utils/apk-paths';
import { getDataRoot, absoluteLocalPath } from './config/paths';
import { createSettingsApi } from './services/host-ctx-services/settings-api';
import { createCloudFilesApi } from './services/host-ctx-services/cloud-files-api';
import { createAutomationsApi } from './services/host-ctx-services/automations-api';
import { createWebsocketApi } from './services/host-ctx-services/websocket-api';
import { createApkApi } from './services/host-ctx-services/apk-api';
import { createPathsApi } from './services/host-ctx-services/paths-api';
import { createDispatcherApi } from './services/host-ctx-services/dispatcher-api';
import { createDocStoreApi } from './services/host-ctx-services/doc-store-api';
import { registerFilteredChannel } from './websocket/channel-registry';
import { registerIosSyslogHandlers } from './websocket/ios-syslog-handlers';
import { IosDeviceManager } from './services/ios-device-manager';
import { NotificationService } from './services/notification-service';
import { registerNotificationEndpoints } from './api/notifications';
import { LicenseService } from './services/license';
import { registerLicenseEndpoints } from './api/license';
import { JobRegistry } from './services/job-registry';
import { registerJobEndpoints } from './api/jobs';
import { PluginManager } from './plugins/plugin-manager';
import { computeLoadOrder } from './plugins/load-order';
import { discoverPlugins, discoverNpmPlugins, applyPluginFilter } from './plugins/discover';
import { registerPluginEndpoints } from './api/plugins';
import { registerPluginConsentEndpoints } from './api/plugin-consent';
import { PluginStateManager } from './services/plugin-state-manager';
import { PluginInstaller } from './services/plugin-installer';
import { PluginInstallsRepo } from './services/plugin-installs-repo';
import { PluginSourceManager } from './services/plugin-source-manager';
import { PluginVerifier } from './services/plugin-verifier';
import { registerPluginSettings } from './api/settings';
import { registerPluginNotificationEvents } from './services/notification-service';
import { registerInterceptRuleEndpoints } from './api/intercept-rules';
import { registerInterceptLiveEndpoints } from './api/intercept-live';
import { getArmed } from './services/intercept-hold-store';
import { writeHoldConfig } from './services/intercept-hold-config-writer';
import { registerClientCertEndpoints } from './api/client-certs';
import { onBroadcast } from './websocket/index';
import { registerToolApiEndpoints } from './api/tool-api';
import { SystemStateService } from './services/system-state-service';
import { registerSystemEndpoints } from './api/system';
import { SessionManager } from './auth/session-manager';
import { ClaimManager } from './auth/claim-manager';
import { ApiKeyManager } from './auth/api-key-manager';
import { initAuth } from './auth/init';
import { registerAuthEndpoints } from './api/auth';
import { registerApiKeyEndpoints } from './api/api-keys';
import { registerProfileEndpoints } from './api/profile';
import { registerAdminUserEndpoints } from './api/admin-users';
import { checkBootstrap } from './auth/bootstrap';
import { registerOAuthRoutes } from './api/oauth';
import { registerOAuthGrantsRoutes } from './api/oauth-grants';
import { ensureSystemUser } from './auth/system-user';
import { AiAgentFactory } from './services/ai-agent-factory';
import { AiCallLogger } from './services/ai-call-logger';
import { ServiceUserManager } from './auth/service-user-manager';
import { backfillFailedDiffs } from './services/apk-diff-backfill';
import { createProviderRegistry } from './services/providers';
import { createAdbDeviceProvider } from './services/providers/adb-device';
import { createIosDeviceProvider } from './services/providers/ios-device';
import { createDockerAndroidProvider } from './services/providers/docker-android';
import { createDockerClient, setActiveDockerClient, getActiveDockerClient, spawnContainerHttpForwarder } from './services/providers/docker-helpers';
import { createAvdProvider } from './services/providers/avd';
import { createCaptureModeRegistry } from './services/capture-mode-registry';
import { makeCaptureHandlers } from './services/capture-handlers';
import { ensureConfigs } from './services/wireguard-config';
import { reconcileWithProviders } from './services/device-manager-reconcile';
import { DeviceInstancesRepo } from './services/device-instances-repo';
import { stopSpawnedInstances } from './services/stop-spawned-instances';
import { registerDevicesProvidersEndpoints } from './api/devices-providers';
import { registerVideoTransportEndpoint } from './api/video-transport';
import { registerEmulatorGrpcBridge } from './api/emulator-grpc-bridge';
import { measureDiskUsage } from './services/disk-usage';

const { log, error } = createLoggers('server');


// User-authored scripts (plugin trigger scripts, automation scripts, plugin code)
// can reject promises or throw asynchronously without us getting a chance to
// catch. Do NOT crash the server on these — log loudly and continue. The
// trigger runner's per-script error tracking still applies to the awaited
// execution path; this handler covers orphan / fire-and-forget rejections.
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[unhandledRejection] (process continuing):', detail);
});

// Synchronous throws that escape every try/catch represent real VM-state
// corruption — restart is the safer default. User scripts running through
// AsyncFunction never reach this path; their sync throws surface as promise
// rejections via the await chain above.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.stack || err.message);
  process.exit(1);
});

// Validate Node.js version — zstd support in zlib requires >= 22.15.0
import zlib from 'zlib';
if (typeof zlib.zstdDecompressSync !== 'function') {
  console.error(`[FATAL] Node.js ${process.version} does not support zlib.zstdDecompressSync.`);
  console.error('        DarkRide requires Node.js >= 22.15.0 for zstd support. Please upgrade.');
  process.exit(1);
}

// Configuration from environment
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DATABASE_PATH = process.env.DATABASE_PATH || './data/darkride.db';
const SCREENSHOT_PATH = process.env.SCREENSHOT_PATH || pathJoin(getDataRoot(), 'screenshots');
const PRUNE_DAYS = parseInt(process.env.PRUNE_DAYS || '7', 10);

// Ensure runtime directories exist
mkdirSync(SCREENSHOT_PATH, { recursive: true });
mkdirSync(APK_DIR, { recursive: true });
mkdirSync(pathJoin(getDataRoot(), 'apks-injected'), { recursive: true });

// Initialize database
const db = initDatabase(DATABASE_PATH);

const pluginStateManager = new PluginStateManager(db);
const pluginInstaller = new PluginInstaller();
const pluginInstallsRepo = new PluginInstallsRepo(db);
const pluginSourceManager = new PluginSourceManager(db);
const pluginVerifier = new PluginVerifier(db);

// One-time hostname backfill for captured_traffic rows that predate the hostname column
{
  const nullCount = db.select({ count: sql<number>`count(*)` })
    .from(capturedTraffic)
    .where(and(isNull(capturedTraffic.hostname), isNotNull(capturedTraffic.requestUrl)))
    .get();
  const total = nullCount ? (nullCount as any).count : 0;
  if (total > 0) {
    log(`Backfilling hostname for ${total} traffic rows...`);
    const BATCH = 1000;
    let filled = 0;
    while (filled < total) {
      const rows = db.select({ id: capturedTraffic.id, requestUrl: capturedTraffic.requestUrl })
        .from(capturedTraffic)
        .where(and(isNull(capturedTraffic.hostname), isNotNull(capturedTraffic.requestUrl)))
        .limit(BATCH)
        .all();
      if (rows.length === 0) break;
      for (const row of rows) {
        let hostname: string | null = null;
        try { hostname = new URL(row.requestUrl).hostname; } catch {}
        if (hostname) {
          db.update(capturedTraffic)
            .set({ hostname })
            .where(eq(capturedTraffic.id, row.id))
            .run();
        }
      }
      filled += rows.length;
    }
    log(`Hostname backfill complete (${filled} rows processed).`);
  }
}

// One-time backfill for failed diffs whose sides are now restorable
{
  const backfilled = backfillFailedDiffs(db);
  if (backfilled > 0) {
    log(`Startup: converted ${backfilled} failed diffs to skipped`);
  }
}

// Auth middleware — must be installed BEFORE the API router is mounted so that
// cookieParser + authenticateRequest run first in the Express stack.
const sessionManager = new SessionManager(db);
const claimManager = new ClaimManager(db);
const apiKeyManager = new ApiKeyManager(db);
initAuth(app, db);

// Mount API router AFTER auth middleware so every route is protected.
mountApiRouter();

// Register OAuth routes (/.well-known/oauth-* and /oauth/*) — these are public
// and bypass auth via the allowlist in initAuth.
registerOAuthRoutes(app, db);

// Initialize notification service (early, so other services can use it)
const notificationService = new NotificationService(db);

// Initialize license service — verifies/stores DarkRide Pro license JWS.
// init() is awaited inside the async startup IIFE below to rehydrate any
// stored license from the DB before plugins / services start.
const licenseService = new LicenseService(db);
registerLicenseEndpoints(licenseService);

// Initialize services
const deviceManager = DeviceManager.getInstance(db);
// Emulator support — provider abstraction (spec docs/specs/2026-05-20-emulator-support-design.md §4).
// Discovery is now driven through the provider registry: once
// setProviderRegistry() is called, DeviceManager.start() schedules
// pollDevicesFromProviders() as the live poll. The legacy pollAdbDevices()
// remains only as the no-registry fallback; both paths share the same
// reconcileDiscovered() logic, so physical-device discovery is unchanged.
const providerRegistry = createProviderRegistry();
providerRegistry.register(createAdbDeviceProvider());
deviceManager.setProviderRegistry(providerRegistry);

const captureModeRegistry = createCaptureModeRegistry();
deviceManager.setCaptureModeRegistry(captureModeRegistry);
// Real handlers are registered AFTER captureManager is constructed below —
// makeCaptureHandlers needs captureManager.waitForTunnelReady, and
// captureManager needs this registry. Registration happens before any capture
// can start (the API router only handles requests after startup completes).

const proxyRotator = new ProxyRotator(db);
const bridgeManager = new PythonBridgeManager(db);
const compiler = new AutomationCompiler();
const webhookUrl = `http://localhost:${PORT}/v1/traffic/ingest`;
const mitmproxyManager = new MitmproxyManager(proxyRotator, webhookUrl, undefined, db);

// Server-side TLS-spoofing proxy pool. Lazy-spawned: no mitmproxy is
// started until the first automation calls http.setTlsProfile(...).
// One instance per profile (chrome, okhttp), shared across all
// automations using that profile.
import { ServerMitmproxyPool, setServerMitmproxyPool } from './services/server-mitmproxy-pool';
setServerMitmproxyPool(new ServerMitmproxyPool());
const runner = new AutomationRunner(db, bridgeManager, compiler, mitmproxyManager, deviceManager, trafficHookRegistry);
const scheduler = new AutomationScheduler(db, runner, deviceManager);
const iosDeviceManager = new IosDeviceManager(db);
const captureManager = new CaptureSessionManager(db, mitmproxyManager, deviceManager, runner, trafficHookRegistry);
captureManager.setIosDeviceManager(iosDeviceManager);
captureManager.setCaptureModeRegistry(captureModeRegistry);
captureManager.setProviderRegistry(providerRegistry);

// Register the three built-in capture-mode handlers. This must run after
// captureManager exists (waitForTunnelReady dep) and before any capture starts.
const captureHandlers = makeCaptureHandlers({
  mitmproxyManager,
  deviceManager,
  spawnContainerHttpForwarder,
  getActiveDockerClient,
  // Running-first + recency selection so a stale adb-device row sharing the
  // serial can't shadow the live emulator (mirrors resolveCaptureMode's H3 fix).
  lookupRuntimeId: (serial) => deviceInstancesRepo?.findRuntimeIdBySerial(serial),
  waitForTunnelReady: (serial) => captureManager.waitForTunnelReady(serial),
  ensureConfigs,
});
captureModeRegistry.register('wireguard', captureHandlers.wireguard);
captureModeRegistry.register('emu-http-proxy', captureHandlers['emu-http-proxy']);
captureModeRegistry.register('ios-bridge', captureHandlers['ios-bridge']);
runner.setNotificationService(notificationService);
runner.setIosDeviceManager(iosDeviceManager);


// pluginManager is initialized in the async startup IIFE but referenced in
// shutdown() which lives at module scope — hoist the declaration here.
let pluginManager: PluginManager | null = null;
// dispatcherApi likewise: constructed during startup, closed during shutdown.
let dispatcherApi: ReturnType<typeof createDispatcherApi> | null = null;
// deviceInstancesRepo likewise: constructed during startup, read during shutdown
// to stop darkride-spawned emulator instances (M1).
let deviceInstancesRepo: DeviceInstancesRepo | null = null;

// Initialize saved traffic store and wire to hook registry
const savedTrafficStore = new SavedTrafficStore(db);
trafficHookRegistry.setSavedTrafficStore(savedTrafficStore);

// Sync blocklist and hiddenlist files on startup
syncBlocklistFile(db);
syncHiddenlistFile(db);

// Cloud storage (before endpoint registration so fileSync can be passed to routes)
const cloudStorage = new CloudStorageService();
const fileSync = new FileStorageService(db, cloudStorage, DATABASE_PATH, SCREENSHOT_PATH);
mountFileServing(app, fileSync);

// Default analysis prompt (used by both settings endpoint and AI agent factory)
const DEFAULT_ANALYSIS_PROMPT = `You are analysing an APK to surface its API surface, behavioural patterns, and noteworthy findings for a reverse-engineering team.

PLAN FIRST: Before calling any tools, decide the exact sequence of tool calls you need. Aim for under 30 tool calls total.

STEP 1 — Overview (1 tool call, then write)
- Call get_apk_overview to get manifest + finding counts.
- Immediately call patch_analysis_section for "Overview" with: app name, version, purpose, framework, key finding stats.

STEP 2 — API Endpoints (3–6 tool calls, then write)
- Call get_apk_strings with excludeNoise=true to find API URLs and domains.
- Call search_apk_code for "wait" or "queue" with includePaths targeting the app's main package. Limit 10.
- If found: note the API domain, path, auth mechanism. Call patch_analysis_section for "Wait Times".
- Call search_apk_code for "schedule" or "hours" or "opening" with same filters. Limit 10.
- If same API as wait times, note briefly. Call patch_analysis_section for "Opening Hours".
- STOP searching after 2 failed attempts per topic.

STEP 3 — Maps (2–3 tool calls, then write)
- Call search_apk_code for "tile" or "mapbox" or "maptiler" or "/{z}/{x}" with includePaths. Limit 10.
- If no result: call list_apk_assets to check for embedded map tiles.
- Call patch_analysis_section for "Maps" — either the tile URL pattern or "No interactive map found".

STEP 4 — Other (1 tool call, then write)
- Call get_apk_findings_summary for a severity/category breakdown.
- Call patch_analysis_section for "Other Findings" — notable auth flows, SDKs, critical security findings.

Rules:
- Write each section via patch_analysis_section IMMEDIATELY after researching it.
- Never call search_apk_findings to paginate individual findings — use get_apk_findings_summary instead.
- Skip library code: androidx, com.google, retrofit, okhttp, kotlin, rx, flutter engine.
- Bullet points preferred. No large code blocks.`;

// Register API endpoints
registerAuthEndpoints(db, sessionManager, claimManager);
registerApiKeyEndpoints(db, apiKeyManager);
registerProfileEndpoints(db, sessionManager);
registerOAuthGrantsRoutes(app, db);
registerAdminUserEndpoints(db, claimManager, sessionManager);
registerProxyEndpoints(db);
registerDeviceEndpoints(deviceManager, db, iosDeviceManager);
registerTrafficEndpoints(db, trafficHookRegistry);
registerAutomationEndpoints(db, runner, compiler, scheduler, captureManager, fileSync);
registerManagedAutomationEndpoints(db, scheduler);
registerAutomationTemplateEndpoints();
registerCaptureEndpoints(captureManager);
registerBlocklistEndpoints(db);
registerHiddenlistEndpoints(db);
registerCredentialsEndpoints(db);
// Settings registration is deferred until after diff engine is set up (needs DEFAULT_DIFF_PROMPT)
registerAiCompleteEndpoints(db);
registerAiChatApiEndpoints(db, getClaudeCliProvider);
registerUtilsEndpoints(DATABASE_PATH, db);
registerSavedTrafficEndpoints(savedTrafficStore, db);
registerApiCatalogueEndpoints(db);
registerChangelogEndpoints();
refreshPatternCache(db);

function configureCloudFromDb() {
  const getVal = (key: string) => {
    const row = db.select().from(settings).where(eq(settings.key, key)).all()[0];
    return row?.value ?? '';
  };
  cloudStorage.configure({
    endpoint: getVal('cloud_endpoint'),
    region: getVal('cloud_region'),
    bucket: getVal('cloud_bucket'),
    accessKey: getVal('cloud_access_key'),
    secretKey: getVal('cloud_secret_key'),
    provider: getVal('cloud_provider'),
  });
}
configureCloudFromDb();
registerCloudEndpoints(fileSync, cloudStorage, configureCloudFromDb);

// AI Chat agent setup
const aiToolRegistry = new AiToolRegistry();
// registerAllTools is called once at boot. Some services (systemStateService,
// captureManager) are constructed below, so we defer the call to after they
// exist — see the second call site further down in this file.
// (Intentionally not invoked here — kept for grep discoverability.)

// Mount MCP SSE server — exposes all tools via MCP protocol at /mcp/sse
mountMcpSseServer(app, aiToolRegistry, db);

// SKILL.md — auto-generated AI agent skill document
import { generateSkillDoc } from './api/skill-doc';
app.get('/SKILL.md', (_req, res) => {
  const baseUrl = `http://${_req.headers.host || `localhost:${PORT}`}`;
  res.type('text/markdown').send(generateSkillDoc(aiToolRegistry, baseUrl));
});

// OpenAPI spec — auto-generated from endpoint registry
import { generateOpenApiSpec } from './api/openapi';
app.get('/openapi.json', (_req, res) => {
  const baseUrl = `http://${_req.headers.host || `localhost:${PORT}`}`;
  res.json(generateOpenApiSpec(baseUrl));
});

// Revoke any internal (ephemeral) API keys that were not cleaned up during
// the previous run (e.g. after a crash or SIGKILL).
const orphanCount = apiKeyManager.revokeInternalOrphans();
if (orphanCount > 0) {
  log(`revoked ${orphanCount} orphaned internal api keys from prior run`);
}

// Ensure the __system__ user row exists for audit-log continuity.
ensureSystemUser(db);

// Claude CLI Provider — spawns `claude` as a subprocess connected to MCP
const mcpConfigPath = writeMcpConfig(PORT);
let claudeCliProvider: ClaudeCliProvider | null = null;

ClaudeCliProvider.isAvailable().then((available) => {
  if (available) {
    claudeCliProvider = new ClaudeCliProvider(mcpConfigPath, undefined, db, apiKeyManager, PORT);
    log('Claude CLI provider available — ai:claude-message endpoint enabled');
  } else {
    log('Claude CLI not found in PATH — ai:claude-message endpoint disabled');
  }
});

function getClaudeCliProvider(): ClaudeCliProvider | null {
  return claudeCliProvider;
}

// Run legacy settings → aiModels migration, then ai_models → ai_providers migration
migrateAiSettingsToModels(db);
migrateAiProviders(db);

// AI Provider endpoints
registerAiProviderEndpoints(db);

// AI Tier endpoints
const aiTierStore = new AiTierStore(db);
registerAiTiersRoutes({ tierStore: aiTierStore, db });

// AI Model Router (multi-model with rate limit fallback)
const rateLimitCache = new RateLimitCache();
const aiModelRouter = new AiModelRouter(db, rateLimitCache);
registerAiModelEndpoints(db, aiModelRouter, rateLimitCache);

// Router-based provider facade: delegates createStreamingRequest to the router.
// When `tier` is provided, the facade injects it into every createStreamingRequest
// call so the router picks models from the correct tier (not the default 'High').
function getAiProvider(tier?: string): AiProvider | null {
  const models = aiModelRouter.getEnabledModels();
  if (models.length === 0) return null;

  return {
    name: 'router',
    buildHeaders: () => ({}),
    formatTools: (tools) => tools,
    createStreamingRequest: (messages, systemPrompt, tools, options) =>
      aiModelRouter.createStreamingRequest(messages, systemPrompt, tools, { ...options, tier: tier ?? options?.tier }),
  };
}

function getAiAgent(options?: { tier?: string }): AiAgentInterface | null {
  try {
    const models = aiModelRouter.getModelsForTier(options?.tier ?? 'High');
    if (models.length === 0) return null;

    const topModel = models[0];
    if (topModel.provider === 'claude-cli') {
      const cli = claudeCliProvider;
      if (!cli) { log('claude-cli model configured but CLI not available'); return null; }
      if (topModel.providerId) {
        const provider = db.select().from(aiProviders).where(eq(aiProviders.id, topModel.providerId)).get();
        cli.setOauthToken(provider?.apiKey || undefined);
      } else {
        cli.setOauthToken(undefined);
      }
      return new ClaudeCliAgent(db, cli, topModel.model || 'sonnet');
    }

    const provider = getAiProvider(options?.tier);
    if (!provider) return null;
    return new AiAgent(db, aiToolRegistry, provider);
  } catch {
    return null;
  }
}

function getTierConfig(writeToolNames: string[]): TierConfig | null {
  const researchTier = db.select().from(settings)
    .where(eq(settings.key, 'analysis_tier_research')).all()[0]?.value ?? 'Low';
  const writeTier = db.select().from(settings)
    .where(eq(settings.key, 'analysis_tier_write')).all()[0]?.value ?? 'High';

  try {
    const researchModels = aiModelRouter.getModelsForTier(researchTier);
    const writeModels = aiModelRouter.getModelsForTier(writeTier);
    if (researchModels.length === 0 || writeModels.length === 0) return null;

    const researchModel = researchModels[0];
    const writeModel = writeModels[0];

    // TierConfig is not supported for claude-cli models (inherits prior behaviour).
    if (researchModel.provider === 'claude-cli' || writeModel.provider === 'claude-cli') return null;

    return {
      researchProvider: aiModelRouter.createProviderForModelId(researchModel.id),
      writeProvider: aiModelRouter.createProviderForModelId(writeModel.id),
      writeToolNames,
    };
  } catch {
    return null;
  }
}

const apkTracker = new ApkTracker(db, deviceManager);
const apkAnalyzer = new ApkAnalyzerService(db);
apkTracker.setApkAnalyzer(apkAnalyzer);
apkTracker.setFileSync(fileSync);
const sourceRegistry = createSourceRegistry(db);
apkTracker.setSourceRegistry(sourceRegistry);
apkTracker.setNotificationService(notificationService);
registerAppEndpoints(deviceManager, db, apkTracker, apkAnalyzer, fileSync, iosDeviceManager, sourceRegistry);
registerAppsUploadEndpoint(db, apkAnalyzer);
registerAnalysisEndpoints(db, apkAnalyzer, deviceManager, captureManager, fileSync);
const fridaReleaseManager = new FridaReleaseManager(db);
deviceManager.setFridaReleaseManager(fridaReleaseManager);
registerFridaEndpoints(db, fridaReleaseManager, bridgeManager, deviceManager);
seedFridaScriptLibrary(db);
const gadgetInjector = new GadgetInjector(db, bridgeManager, fridaReleaseManager);
registerFridaGadgetEndpoints(gadgetInjector);
const toolManager = new ToolManager();
apkAnalyzer.setToolManager(toolManager);
apkAnalyzer.setFileSync(fileSync);

// Wire up AI config (prompt/autorun/tier) for post-analysis review
apkAnalyzer.setAiConfig(
  () => {
    const row = db.select().from(settings).where(eq(settings.key, 'analysis_ai_prompt')).all()[0];
    return row?.value || DEFAULT_ANALYSIS_PROMPT;
  },
  () => {
    const row = db.select().from(settings).where(eq(settings.key, 'analysis_ai_autorun')).all()[0];
    return row?.value !== 'false'; // default true
  },
  () => getTierConfig(['patch_analysis_section', 'write_analysis_notes']),
);
// Note: apkAnalyzer.setAiFactory(aiFactory) is called after aiFactory is constructed below.

// Wire up APK diff engine
const apkDiffEngine = new ApkDiffEngine(db);
apkDiffEngine.setFileSync(fileSync);
apkDiffEngine.setAiConfig(
  () => {
    const row = db.select().from(settings).where(eq(settings.key, 'diff_ai_prompt')).all()[0];
    return row?.value || DEFAULT_DIFF_PROMPT;
  },
  () => {
    const row = db.select().from(settings).where(eq(settings.key, 'diff_ai_autorun')).all()[0];
    return row?.value !== 'false'; // default true
  },
  () => getTierConfig(['write_diff_summary']),
);
// Note: apkDiffEngine.setAiFactory(aiFactory) is called after aiFactory is constructed below.
apkAnalyzer.setDiffEngine(apkDiffEngine);
registerApkDiffEndpoints(db, apkDiffEngine);

registerSettingsEndpoints(db, { analysis_ai_prompt: DEFAULT_ANALYSIS_PROMPT, diff_ai_prompt: DEFAULT_DIFF_PROMPT });

// APK availability + restore endpoints
const apkRestoreService = new ApkRestoreService({ db, fileSync, apkAnalyzer });
registerApkAvailabilityEndpoints(db, apkRestoreService);
registerNotificationEndpoints(db, notificationService);

// System state service — tracks restart-required flag and exposes /v1/system/status
const systemStateService = new SystemStateService(db, broadcastToAll);
systemStateService.clearRestartRequired();
registerSystemEndpoints(systemStateService);

// Register the core AI tools. Deferred from where aiToolRegistry was created
// above because some service handles (systemStateService, captureManager,
// pluginStateManager) are constructed earlier in this file but registerAllTools
// reads them all in one go via the services bag. MCP request handlers read
// the registry per-request, so registering after mount is safe.
registerAllTools(aiToolRegistry, db, {
  bridgeManager,
  deviceManager,
  runner,
  scheduler,
  compiler,
  captureManager,
  pluginStateManager,
  systemStateService,
  apkAnalyzer,
  apkTracker,
  sourceRegistry,
});

// Disk space endpoint
registerEndpoint('GET', '/v1/system/disk-space', async (_req, res) => {
  try {
    const { statfs } = await import('fs/promises');
    const stats = await statfs('.');
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    const thresholdRow = db.select().from(settings).where(eq(settings.key, 'disk_space_threshold')).all()[0];
    const threshold = parseInt(thresholdRow?.value || '10', 10);
    res.json({
      success: true,
      data: {
        totalBytes,
        freeBytes,
        usedBytes: totalBytes - freeBytes,
        freePercent: parseFloat((freeBytes / totalBytes * 100).toFixed(1)),
        usedPercent: parseFloat(((totalBytes - freeBytes) / totalBytes * 100).toFixed(1)),
        threshold,
      },
    });
  } catch (err: any) {
    console.error('Disk space check failed:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

registerToolEndpoints(toolManager);
const proxiedRequestService = new ProxiedRequestService(db, {
  maxConcurrency: 5,
  // Lets `captureSession` replays resolve a device's live egress (proxy + TLS
  // profile) so a resent request goes out looking like the app's own traffic.
  egressResolver: captureManager,
});
registerProxiedRequestEndpoints(db, proxiedRequestService);

// Job registry — unified view of all scheduled jobs
const jobRegistry = new JobRegistry(db);
jobRegistry.register({
  id: 'apk-version-check',
  name: 'APK Version Check',
  description: 'Scan tracked apps on connected devices and Play Store for new versions',
  category: 'sync',
  defaultSchedule: 'Every 30 minutes',
  canRunManually: true,
  run: () => apkTracker.checkForUpdates(),
  getLastRunAt: () => {
    const apps = db.select().from(trackedApps).all();
    if (apps.length === 0) return null;
    const latest = db.select().from(apkVersions).orderBy(desc(apkVersions.downloadedAt)).limit(1).all()[0];
    return latest?.downloadedAt ? new Date(latest.downloadedAt as any).getTime() : null;
  },
});
jobRegistry.register({
  id: 'frida-release-sync',
  name: 'Frida Release Sync',
  description: 'Check GitHub for new Frida server/gadget releases',
  category: 'sync',
  defaultSchedule: 'Every 24 hours',
  canRunManually: true,
  run: () => fridaReleaseManager.syncReleases(),
});
jobRegistry.register({
  id: 'database-prune',
  name: 'Database Pruning',
  description: `Delete sessions, traffic, screenshots older than ${PRUNE_DAYS} days`,
  category: 'maintenance',
  defaultSchedule: '0 3 * * *',
  canRunManually: true,
  run: () => pruneOldData(db, PRUNE_DAYS, SCREENSHOT_PATH, fileSync),
});
jobRegistry.register({
  id: 'stale-session-cleanup',
  name: 'Stale Session Cleanup',
  description: 'Mark crashed sessions still in "running" state as failed',
  category: 'maintenance',
  defaultSchedule: 'Every 10 minutes',
  canRunManually: true,
  run: async () => { cleanStaleSessions(db); },
});
jobRegistry.register({
  id: 'db-size-snapshot',
  name: 'Database Size Snapshot',
  description: 'Record current database file size, per-directory disk usage, and check disk space',
  category: 'maintenance',
  defaultSchedule: 'Every 60 minutes',
  canRunManually: true,
  run: async () => { captureDbSize(); await checkDiskSpace(); await captureDirSizes(); },
});
jobRegistry.register({
  id: 'cloud-backup',
  name: 'Cloud Backup',
  description: 'Back up the database to cloud storage (S3/B2/R2) and prune backups older than 7 days',
  category: 'maintenance',
  defaultSchedule: '0 0 * * *',
  canRunManually: true,
  run: () => fileSync.runBackupNow(),
});
jobRegistry.register({
  id: 'plugin-update-check',
  name: 'Plugin Update Check',
  description: 'Refresh marketplace + git plugin sources so the Plugin Manager surfaces available updates',
  category: 'sync',
  defaultSchedule: 'Every 6 hours',
  canRunManually: true,
  run: async () => { await pluginSourceManager.fetchAll(true); },
});
// Warm the marketplace cache on boot so the Plugin Manager surfaces
// updateAvailable flags within seconds of startup, not after the first
// scheduled fire of the job above (up to 6h later).
pluginSourceManager.fetchAll(true).catch(err => {
  error(`Initial plugin source fetch failed (will retry on schedule): ${err.message}`);
});
registerJobEndpoints(jobRegistry);
registerInterceptRuleEndpoints(db, (msg) => broadcastToAll(msg));
// Interactive intercept ("breakpoints") — separate from the rule-based feature above.
registerInterceptLiveEndpoints((msg) => broadcastToAll(msg), (config) => writeHoldConfig(config));
// Reflect the (disarmed by default) armed state to the addon-visible file on boot,
// so a stale file from a prior run never leaves interception silently armed.
writeHoldConfig(getArmed());
registerClientCertEndpoints(db, (msg) => broadcastToAll(msg));

// Attach WebSocket server to HTTP server
setupWebSocket(httpServer, sessionManager, db);

// Register WebSocket-only endpoints
registerLiveStreamEndpoints(deviceManager, iosDeviceManager);
deviceManager.setViewerCheck(hasActiveViewers);
registerAutomationWebsocketEndpoints(compiler);
registerLiveLogEndpoints();
registerAdbShellEndpoints();
registerHostShellEndpoints();
registerIosSyslogHandlers(iosDeviceManager);
// AiAgentFactory — constructed once at boot, shared across all call sites.
// Tasks 15+ will call aiFactory.registerCoreIdentity(...) to wire service accounts.
const aiCallLogger = new AiCallLogger(db);
const serviceUserManager = new ServiceUserManager(db);
const aiFactory = new AiAgentFactory({
  db,
  serviceUsers: serviceUserManager,
  apiKeys: apiKeyManager,
  providerFactory: getAiAgent,
  logger: aiCallLogger,
});

registerAiChatEndpoints({
  getRegistry: () => aiToolRegistry,
  aiFactory,
});

// Register core service identities and wire factories.
// registerCoreIdentity MUST happen before setAiFactory so the first auto-trigger
// doesn't race ahead before the identity is provisioned.
aiFactory.registerCoreIdentity('apk-analyzer', {
  aiScopes: ['core.apk:read', 'core.apk:manage', 'mcp'],
});
apkAnalyzer.setAiFactory(aiFactory);

aiFactory.registerCoreIdentity('apk-diff-engine', {
  aiScopes: ['core.apk:read', 'core.apk:manage', 'mcp'],
});
apkDiffEngine.setAiFactory(aiFactory);

// Wire notification service to broadcast events not handled by direct service hooks
onBroadcast((msg) => {
  if (msg.type === 'apk:analysis-update' && (msg.status === 'completed' || msg.status === 'failed')) {
    // Look up trackedAppId for the deep link
    const version = db.select().from(apkVersions).where(eq(apkVersions.id, msg.apkVersionId)).all()[0];
    notificationService.emit({
      type: 'apk:analysis-complete',
      title: msg.status === 'completed'
        ? `APK analysis complete: ${msg.packageName}`
        : `APK analysis failed: ${msg.packageName}`,
      body: msg.error || '',
      sourceType: 'apk',
      sourceId: String(msg.apkVersionId),
      url: version ? `/ui/apps/${version.trackedAppId}/analysis/${msg.apkVersionId}` : '/ui/apks',
    });
  }

  if (msg.type === 'apk:diff-update' && (msg.status === 'completed' || msg.status === 'failed')) {
    // Look up versionId from the diff report for the deep link
    const report = db.select().from(apkDiffReports).where(eq(apkDiffReports.id, msg.reportId)).all()[0];
    const version = report
      ? db.select().from(apkVersions).where(eq(apkVersions.id, report.apkVersionId)).all()[0]
      : undefined;
    notificationService.emit({
      type: 'apk:diff-complete',
      title: msg.status === 'completed'
        ? `APK diff complete (report #${msg.reportId})`
        : `APK diff failed (report #${msg.reportId})`,
      body: msg.error || '',
      sourceType: 'apk',
      sourceId: String(msg.reportId),
      url: version ? `/ui/apps/${version.trackedAppId}/analysis/${report!.apkVersionId}` : '/ui/apks',
    });
  }

  if (msg.type === 'capture-status' && msg.status === 'error') {
    notificationService.emit({
      type: 'capture:error',
      title: `Capture error on device ${msg.deviceId}`,
      body: msg.error || 'Unknown capture error',
      sourceType: 'capture',
      sourceId: msg.deviceId,
      url: `/ui/devices/${msg.deviceId}`,
    });
  }

  if (msg.type === 'device-status' && msg.status === 'offline') {
    const device = db.select().from(devices).where(eq(devices.id, msg.deviceId)).all()[0];
    notificationService.emit({
      type: 'device:disconnected',
      title: `Device disconnected: ${device?.name || msg.deviceId}`,
      body: 'USB connection lost',
      sourceType: 'device',
      sourceId: msg.deviceId,
      url: `/ui/devices/${msg.deviceId}`,
    });
  }

  if (msg.type === 'api:regression') {
    notificationService.emit({
      type: 'api:regression',
      title: `API regression: ${msg.method} ${msg.hostname}${msg.pathPattern}`,
      body: `Status code changed from ${msg.previousStatus} to ${msg.currentStatus}`,
      sourceType: 'api',
      sourceId: String(msg.endpointId),
      url: `/ui/api-catalogue/${msg.endpointId}`,
    });
  }
});

// Clean up ALL running sessions on startup — nothing can legitimately be running
// when the server just started, so these are leftovers from a crash or restart
const staleOnStartup = cleanStaleSessions(db, 0);
if (staleOnStartup > 0) {
  log(`Cleaned ${staleOnStartup} stale running session(s) from previous run`);
}

// Start listening EARLY so the frontend can connect and see startup progress.
// Slow operations (Python venv, service starts) happen async below.
httpServer.listen(PORT, HOST, () => {
  log(`DarkRide server running on http://${HOST}:${PORT}`);
  log(`Database: ${DATABASE_PATH}`);
  log(`Screenshot path: ${SCREENSHOT_PATH}`);
  log(`Prune days: ${PRUNE_DAYS}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    log('⚠  Server bound to all interfaces. Auth is enabled — confirm before exposing:');
    log('⚠    - first-boot admin claim is complete (unclaimed bootstrap = open door)');
    log('⚠    - strong admin password (argon2id helps; weak passwords still crack)');
    log('⚠    - secrets at rest (credentials, AI keys) are unencrypted in the DB');
    log('⚠  See SECURITY.md for the full hardening checklist.');
  }
  checkBootstrap(db, HOST, PORT).catch(err => {
    error(`Bootstrap check failed: ${err.message}`);
  });
});

// Async startup: non-blocking operations that broadcast progress to connected clients
(async () => {
  // Rehydrate any stored Pro license from the DB. Cheap (one row + one
  // JWS verify) so it can run before the slower phases below.
  await licenseService.init();

  // docker-android — only register if the Docker daemon is reachable. The
  // provider's isAvailable() check is async, so we do it here at boot time
  // once rather than on every wizard load. Result is cached implicitly by
  // the registration outcome — if Docker isn't running when DarkRide boots,
  // the provider isn't available; user restarts DarkRide after starting
  // Docker.
  const dockerClient = createDockerClient();
  const dockerAndroidProvider = createDockerAndroidProvider(dockerClient);
  const dockerAvailability = await dockerAndroidProvider.isAvailable();
  if (dockerAvailability.available) {
    providerRegistry.register(dockerAndroidProvider);
    // Expose the client to non-provider services (CaptureSessionManager's
    // emu-http-proxy path execs a TCP forwarder inside the container).
    setActiveDockerClient(dockerClient);
    log(`docker-android provider registered (Docker daemon detected)`);
  } else {
    log(`docker-android provider NOT registered: ${dockerAvailability.reason ?? 'daemon unreachable'}`);
  }

  // avd — only register if emulator + avdmanager are on PATH (Google Android SDK).
  const avdProvider = createAvdProvider();
  const avdAvailability = await avdProvider.isAvailable();
  if (avdAvailability.available) {
    providerRegistry.register(avdProvider);
    log(`avd provider registered (emulator + avdmanager detected)`);
  } else {
    log(`avd provider NOT registered: ${avdAvailability.reason ?? 'cmdline-tools missing'}`);
  }

  // Reconcile DB device_instances against what each provider currently reports.
  // Runs before plugins load so DB state is accurate before any plugin queries it.
  deviceInstancesRepo = new DeviceInstancesRepo(db);
  await reconcileWithProviders(providerRegistry, deviceInstancesRepo);
  registerDevicesProvidersEndpoints(providerRegistry, deviceInstancesRepo, db);
  registerVideoTransportEndpoint(deviceInstancesRepo, providerRegistry);
  // grpc-web ⇄ gRPC bridge for the emulator WebRTC video path (Phase 2).
  registerEmulatorGrpcBridge(deviceInstancesRepo, providerRegistry);

  // Phase 1: Python environment
  setStartupPhase('preparing_python', 'Preparing Python environment...');
  try {
    await ensureVenvAsync((msg) => {
      setStartupPhase('preparing_python', msg);
    });
  } catch (err: any) {
    error(`Python venv setup failed: ${err.message}`);
  }

  // --- Plugin System ---
  setStartupPhase('starting_services', 'Loading plugins...');
  pluginManager = new PluginManager();
  const discovered = await discoverPlugins();

  // Replay any managed installs whose disk state has been wiped.
  // (`npm ci` on a fresh deploy doesn't touch data/, but a redeployed box
  //  with empty data/ would.)
  const { replayMissingInstalls } = await import('./services/replay-missing-installs');
  const managedRoot = pathJoin(getDataRoot(), 'installed-plugins');
  const managedNodeModules = pathJoin(managedRoot, 'node_modules');
  await replayMissingInstalls({
    installsRepo: pluginInstallsRepo,
    installer: pluginInstaller,
    sourceManager: pluginSourceManager ?? null,
    managedNodeModules,
    log,
    logError: error,
  });

  const npmDiscovered = await discoverNpmPlugins();
  const managedDiscovered = await discoverNpmPlugins(managedNodeModules, 'managed');

  // Reconcile state BEFORE the migration filter. Otherwise newly-discovered
  // plugins (state row not yet inserted) fall through pluginStateManager.isEnabled
  // and get silently skipped by the migration step — their tables don't get
  // created until a second restart, by which point the state row exists.
  // reconcile() is idempotent and only needs the discovery list, so it's safe
  // to call here before any filter.
  // Prefer package.json#version over definition.version — the in-source
  // string drifts behind tarball releases (publish bumps package.json,
  // authors rarely bump the duplicated definition.version), and the
  // marketplace's "update available" check compares the published version,
  // not the in-source one.
  const allDiscovered = [
    ...discovered.map(d => ({
      name: d.definition.name,
      version: d.packageVersion ?? d.definition.version ?? 'unknown',
      source: (d.source ?? 'workspace') as 'workspace' | 'npm' | 'managed',
      npmPackage: d.npmPackage,
    })),
    ...npmDiscovered.map(d => ({
      name: d.definition.name,
      version: d.packageVersion ?? d.definition.version ?? 'unknown',
      source: 'npm' as const,
      npmPackage: d.npmPackage,
    })),
    ...managedDiscovered.map(d => ({
      name: d.definition.name,
      version: d.packageVersion ?? d.definition.version ?? 'unknown',
      source: 'managed' as const,
      npmPackage: d.npmPackage,
    })),
  ];
  pluginStateManager.reconcile(allDiscovered);
  log(`Plugin discovery: ${discovered.length} workspace, ${npmDiscovered.length} npm, ${managedDiscovered.length} managed`);

  // Apply plugin migrations BEFORE plugins load. Each plugin's migrations live
  // at <pluginDir>/migrations/*.sql. Core migrations have already run from
  // initDatabase(). Plugin migrations are tracked in `plugin_migrations`
  // (separate from core's __drizzle_migrations) — see plugin-migrator.ts.
  let allDiscoveredCombined = [...discovered, ...npmDiscovered, ...managedDiscovered]
    .filter((p) => pluginStateManager.isEnabled(p.definition.name));

  allDiscoveredCombined = applyPluginFilter(
    allDiscoveredCombined,
    process.env.DARKRIDE_PLUGINS,
    log,
  );

  const loadOrderForMigrations = computeLoadOrder(
    allDiscoveredCombined.map(p => ({ name: p.definition.name, definition: p.definition })),
  );

  // First-wins dedup: matches the load loop below so the plugin whose
  // migrations are applied is the same plugin whose code will run. The
  // Map constructor's last-wins semantics would otherwise pick the
  // managed-installed copy of a name-collision while the load loop
  // picks the workspace copy, leaving the running code with a foreign
  // schema. See plugins.ts identity-collision gate for the install-side
  // prevention.
  const byNameForMigrations = new Map<string, typeof allDiscoveredCombined[number]>();
  const collisions: Array<{ name: string; chosen: string; rejected: string }> = [];
  for (const p of allDiscoveredCombined) {
    const existing = byNameForMigrations.get(p.definition.name);
    if (existing) {
      collisions.push({
        name: p.definition.name,
        chosen: existing.source ?? 'npm',
        rejected: p.source ?? 'npm',
      });
      continue;
    }
    byNameForMigrations.set(p.definition.name, p);
  }
  for (const c of collisions) {
    // Disable the losing managed install (if any) + record a structured
    // error so the user can find it in the plugin manager UI. Workspace
    // and npm wins are not auto-disabled — they're the dev source of
    // truth and you'd be fighting `rm -rf` for npm.
    if (c.rejected === 'managed') {
      log(`WARNING: managed plugin "${c.name}" collides with ${c.chosen} install — disabling managed copy`);
      try {
        pluginStateManager.setEnabled(c.name, false);
        pluginStateManager.setLastError(
          c.name,
          `Name collides with an existing ${c.chosen} plugin. Uninstall the ${c.chosen} copy or rename this plugin to load both.`,
        );
      } catch (e: any) {
        error(`Failed to record collision state for "${c.name}": ${e?.message ?? e}`);
      }
    } else {
      log(`WARNING: plugin "${c.name}" present from both ${c.chosen} and ${c.rejected} — using ${c.chosen}`);
    }
  }
  const pluginsForMigration = loadOrderForMigrations
    .map(name => byNameForMigrations.get(name))
    .filter((p): p is NonNullable<typeof p> => p !== undefined)
    .map(p => ({ name: p.definition.name, path: p.path }));

  // Track plugins whose migrations failed so we skip loading them below
  // (a half-migrated schema is a foot-gun). The set is empty unless
  // applyPluginMigrations reports failures.
  const migrationFailedPlugins = new Set<string>();
  if (pluginsForMigration.length > 0) {
    const sqlite = (db as any).$client;
    const { applyPluginMigrations, backfillPluginMigrationsFromJournal } = await import('./db/plugin-migrator');
    backfillPluginMigrationsFromJournal(sqlite, pluginsForMigration);
    const result = applyPluginMigrations(sqlite, pluginsForMigration);
    log(`Plugin migrations: ${result.applied} applied (${result.total} total tracked) across ${pluginsForMigration.length} plugin(s)`);

    // Failure isolation: disable any plugin whose migration failed and
    // record the error so the UI can surface it. Without this a bad
    // migration would crash the whole boot — no UI recovery path.
    for (const failure of result.failures) {
      error(`Auto-disabling plugin "${failure.plugin}" — migration failure (${failure.filename}): ${failure.error}`);
      try {
        pluginStateManager.setEnabled(failure.plugin, false);
        pluginStateManager.setLastError(failure.plugin, failure.error);
      } catch (e: any) {
        error(`Failed to record migration failure for "${failure.plugin}": ${e?.message ?? e}`);
      }
      migrationFailedPlugins.add(failure.plugin);
    }
  }

  // Surface 'plugin disabled but has migrations on disk' — a class of silent-skip bug.
  const onDiskWithMigrations = [...discovered, ...npmDiscovered, ...managedDiscovered]
    .filter(p => existsSync(pathJoin(p.path, 'migrations'))).length;
  if (onDiskWithMigrations > pluginsForMigration.length) {
    log(`WARNING: ${onDiskWithMigrations} plugin(s) have migrations/ on disk, but only ${pluginsForMigration.length} are eligible to run them. Check plugin enable state and DARKRIDE_PLUGINS env.`);
  }

  // C3: dedupe by name so a workspace+npm collision doesn't crash boot.
  // Workspace plugins win — they're the dev-active source of truth.
  const seen = new Set<string>();
  for (const { definition, source, packageVersion, path: pluginDir } of [...discovered, ...npmDiscovered, ...managedDiscovered]) {
    if (seen.has(definition.name)) {
      log(`Skipping duplicate plugin "${definition.name}" from ${source ?? 'npm'} (already loaded from earlier source)`);
      continue;
    }
    if (migrationFailedPlugins.has(definition.name)) {
      // Already logged + disabled above. Skip loading to avoid running
      // against a half-applied schema.
      continue;
    }
    if (!pluginStateManager.isEnabled(definition.name)) {
      log(`Skipping disabled plugin: ${definition.name}`);
      continue;
    }
    try {
      pluginManager.loadPlugin(definition, packageVersion, pluginDir);
      seen.add(definition.name);
    } catch (err: any) {
      // Surface as fatal — better to refuse to boot than to half-load and
      // leave the operator confused about why their plugin is missing.
      throw new Error(`Failed to load plugin "${definition.name}": ${err?.message ?? err}`, { cause: err });
    }
  }

  // Validate no table name collisions between plugins or with core schema
  pluginManager.validateTableNames(schema);

  // Wire file storage into each plugin context
  pluginManager.wireFiles(fileSync);

  // Wire the core database into every plugin context so ctx.db(schema) works.
  pluginManager.wireDb(db);

  // Wire core services (cloudStorage, notify, runner, raw fileSync) into each
  // plugin context. Plugins access these via ctx.cloudStorage, ctx.notify(...),
  // ctx.runner, ctx.fileSync from start() onwards. Replaces the per-plugin
  // wiring.ts singleton pattern.
  dispatcherApi = createDispatcherApi();
  pluginManager.wireCoreServices({
    cloudStorage,
    notify: (event) => notificationService.emit(event),
    runner,
    fileSync,
    settings: createSettingsApi(db),
    cloudFiles: createCloudFilesApi(db),
    automations: createAutomationsApi(db),
    websocket: createWebsocketApi({
      broadcastToAll,
      registerFilteredChannel,
    }),
    apks: createApkApi({
      // Adapt host signatures (sync, take db; multi-arg) to the SDK shape
      // (async, single ApkHandle/versionId). One DB query per call is the
      // accepted cost — change the API later if it becomes a perf issue.
      lookupVersionMeta: async (versionId: number) => {
        const meta = lookupVersionMeta(db, versionId);
        if (!meta) return null;
        return {
          versionId,
          packageName: meta.packageName,
          versionName: meta.versionName ?? '',
          versionCode: meta.versionCode,
        };
      },
      ensureApkLocal: async (handle) => {
        const meta = lookupVersionMeta(db, handle.versionId);
        if (!meta) {
          throw new Error(`No APK metadata for versionId=${handle.versionId}`);
        }
        const result = await ensureApkLocal(meta.packageName, meta.filename, fileSync, 'plugin-ctx');
        if ('error' in result) {
          throw new Error(`ensureApkLocal failed: ${result.error}`);
        }
        return result.resolution.apkPath;
      },
      analysisDbPath: (handle) => {
        const meta = lookupVersionMeta(db, handle.versionId);
        if (!meta) {
          throw new Error(`No APK metadata for versionId=${handle.versionId}`);
        }
        return analysisDbPath(meta.packageName, meta.versionCode);
      },
    }),
    paths: createPathsApi({ absoluteLocalPath }),
    dispatcher: dispatcherApi,
    documentStore: createDocStoreApi(db),
  });

  // Give the apk analyzer access to the plugin hook bus so it can emit
  // `apk:analyzed` events that plugins (e.g. maps) subscribe to.
  apkAnalyzer.setHookBus(pluginManager.getHookBus());
  apkTracker.setHookBus(pluginManager.getHookBus());
  deviceManager.setHookBus(pluginManager.getHookBus());
  captureManager.setHookBus(pluginManager.getHookBus());
  runner.setHookBus(pluginManager.getHookBus());

  // Wire AiAgentFactory into each plugin context (Task 14).
  // Tasks 15+ will call aiFactory.registerCoreIdentity for core services.
  pluginManager.wireAi(aiFactory);
  pluginManager.wireAiTierStore(aiTierStore);
  pluginManager.setServiceUserManager(serviceUserManager);
  pluginManager.wirePluginLoadedCheck();

  // Register plugin settings keys
  const pluginSettings = pluginManager.getAllSettings();
  if (pluginSettings.length > 0) {
    registerPluginSettings(pluginSettings);
  }

  // Register plugin notification event types
  const pluginEvents = pluginManager.getAllNotificationEvents();
  if (pluginEvents.length > 0) {
    registerPluginNotificationEvents(pluginEvents);
  }

  // Register plugin API routes
  for (const routeSetup of pluginManager.getAllRouteSetups()) {
    routeSetup(getApiRouter());
  }

  // Register plugin AI tools
  for (const tool of pluginManager.getAllAiTools()) {
    aiToolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      context: tool.context,
      execute: tool.execute,
    });
  }

  // Register unified plugin tools (new API — uses 'contexts' instead of 'context')
  for (const tool of pluginManager.getAllTools()) {
    aiToolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      context: tool.contexts,  // PluginTool uses 'contexts' (plural), AiToolRegistration uses 'context' (singular)
      execute: tool.execute,
    });
  }

  registerToolApiEndpoints(aiToolRegistry);

  // Wire tool registry into automation and trigger runners (after all tools are registered)
  runner.setToolRegistry(aiToolRegistry);

  // Register plugin jobs / tools / routes contributed during register()
  // (before startAll). Track IDs so the post-startAll passes can skip
  // duplicates without re-registering.
  const preStartJobIds = new Set<string>();
  for (const job of pluginManager.getAllJobs()) {
    jobRegistry.register({ canRunManually: false, ...job });
    preStartJobIds.add(job.id);
  }
  const preStartToolNames = new Set<string>(
    pluginManager.getAllTools().map((t) => t.name),
  );
  const preStartAiToolNames = new Set<string>(
    pluginManager.getAllAiTools().map((t) => t.name),
  );
  const preStartRouteSetups = new Set(pluginManager.getAllRouteSetups());

  // Wire the scheduler's managed-automations guard so its tryResolveEntry
  // can ask pluginManager whether the owning plugin is currently loaded.
  // Pre-fix the scheduler treated every plugin as loaded and would fire
  // managed rows even for stopped/uninstalled plugins.
  scheduler.setIsPluginLoaded((name) => pluginManager!.hasPlugin(name));

  // Reconcile managed automations BEFORE startAll(). Plugins register their
  // managed scripts in register(); the host stamps them onto the automations
  // table here so by the time start() (and the scheduler tick that follows
  // it) reads the table, every declared script has a row and any
  // previously-declared row that's gone has been orphaned or deleted.
  for (const { pluginName, defs } of pluginManager.getAllManagedAutomations()) {
    try {
      reconcileManagedAutomations(db, pluginName, defs);
    } catch (err: any) {
      // Reconcile failure for one plugin must not block the others or the
      // boot — surface it loudly and continue. The scheduler's plugin-loaded
      // guard (next commit) protects us against orphaned runs.
      error(`Failed to reconcile managed automations for plugin "${pluginName}": ${err?.message ?? err}`);
    }
  }

  // Uninstall sweep: any managed_by value in the automations table that
  // doesn't correspond to a currently-loaded plugin means the plugin was
  // uninstalled since last boot. Reconcile with an empty def list, which
  // routes each row through the orphan-or-delete branch in the state
  // machine (preserving operator overrides as ordinary disabled
  // automations, deleting clean rows). The scheduler's plugin-loaded
  // guard would also skip these at runtime, but we don't want them to
  // hang around indefinitely as zombie rows.
  //
  // IMPORTANT: compare against INSTALLED plugins (pluginStateManager.getAll),
  // not currently-LOADED plugins (pluginManager.getPluginNames). A
  // temporarily-disabled plugin is still installed and its managed rows
  // must survive the boot — otherwise toggling a plugin off & on would
  // delete every non-overridden managed automation it owns. Only truly
  // absent (uninstalled) plugins should be swept here.
  const installedPluginNames = new Set(pluginStateManager.getAll().map((p) => p.name));
  const managedByValues = db.selectDistinct({ name: schema.automations.managedBy })
    .from(schema.automations)
    .where(isNotNull(schema.automations.managedBy))
    .all()
    .map((r) => r.name)
    .filter((n): n is string => n != null);
  for (const pluginName of managedByValues) {
    if (installedPluginNames.has(pluginName)) continue;
    try {
      reconcileManagedAutomations(db, pluginName, []);
    } catch (err: any) {
      error(`Failed to clean up orphaned managed automations for missing plugin "${pluginName}": ${err?.message ?? err}`);
    }
  }

  // Run all migrated plugins' start() in topological order. Required-peer
  // failures (and timeouts) abort boot.
  await pluginManager.startAll();

  // Register jobs / tools / routes contributed by plugins during start()
  // (service-dependent registrations). Items registered during register()
  // are skipped to avoid double-registration.
  for (const job of pluginManager.getAllJobs()) {
    if (preStartJobIds.has(job.id)) continue;
    jobRegistry.register({ canRunManually: false, ...job });
  }
  for (const tool of pluginManager.getAllTools()) {
    if (preStartToolNames.has(tool.name)) continue;
    aiToolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      context: tool.contexts,
      execute: tool.execute,
    });
  }
  for (const tool of pluginManager.getAllAiTools()) {
    if (preStartAiToolNames.has(tool.name)) continue;
    aiToolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      context: tool.context,
      execute: tool.execute,
    });
  }
  for (const routeSetup of pluginManager.getAllRouteSetups()) {
    if (preStartRouteSetups.has(routeSetup)) continue;
    routeSetup(getApiRouter());
  }

  // Emit startup hook
  pluginManager.getHookBus().emit('app:startup');

  // Plugin metadata endpoint
  registerPluginEndpoints(pluginManager, pluginStateManager, pluginInstaller, pluginSourceManager, pluginVerifier, pluginInstallsRepo, (db as any).$client, systemStateService);
  registerPluginConsentEndpoints(db, pluginManager);

  log(`Loaded ${pluginManager.getPluginNames().length} plugin(s): ${pluginManager.getPluginNames().join(', ')}`);

  // Phase 2: Start services
  setStartupPhase('starting_services', 'Starting services...');
  deviceManager.start();
  iosDeviceManager.start();
  scheduler.start();
  proxiedRequestService.start();
  // Only start APK tracker's internal interval if the job is enabled
  if (jobRegistry.getConfig('apk-version-check').enabled) {
    apkTracker.start();
  } else {
    log('APK tracker skipped (job disabled)');
  }
  apkAnalyzer.resetRunningJobs();
  apkAnalyzer.start();
  fridaReleaseManager.start().catch(err => error('Frida release manager failed: ' + err.message));
  fileSync.start();
  jobRegistry.start();
  log('All services started');

  // Phase 3: Ready
  setStartupPhase('ready', 'Server ready');
})().catch((err) => {
  // C2: any failure inside the async startup IIFE — including plugin
  // loadPlugin / startAll failures — is fatal. Without this, an
  // unhandledRejection would be swallowed by the global handler at line 130
  // (which is intentionally non-fatal for plugin-script-level rejections),
  // leaving the server listening on the port in a half-started zombie state.
  // Boot failures must hard-exit so operators see the real cause.
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('[FATAL] Server startup failed:', detail);
  if (err instanceof Error && (err as { cause?: unknown }).cause) {
    console.error('[FATAL] Caused by:', (err as { cause?: unknown }).cause);
  }
  process.exit(1);
});

// Periodically clean stale running sessions (every 10 minutes)
const STALE_CHECK_INTERVAL = 10 * 60 * 1000;
const staleInterval = setInterval(() => {
  const cleaned = cleanStaleSessions(db);
  if (cleaned > 0) {
    log(`Cleaned ${cleaned} stale running session(s)`);
  }
}, STALE_CHECK_INTERVAL);

// Capture DB size snapshot
function captureDbSize() {
  try {
    const size = statSync(DATABASE_PATH).size;
    db.insert(dbSizeSnapshots).values({ sizeBytes: size, capturedAt: new Date() }).run();
  } catch (err: any) {
    error(`Failed to capture DB size: ${err.message}`);
  }
}

// Capture per-directory disk usage snapshot. Anchored on getDataRoot() — the
// canonical artifact root (apks/, plugins/, screenshots/, ...) — so the
// breakdown measures the directories that actually consume the volume.
async function captureDirSizes() {
  try {
    const usage = await measureDiskUsage(getDataRoot());
    db.insert(diskUsageSnapshots).values({
      capturedAt: new Date(),
      volumeTotalBytes: usage.volumeTotalBytes,
      volumeFreeBytes: usage.volumeFreeBytes,
      dirSizes: usage.dirSizes,
    }).run();
  } catch (err: any) {
    error(`Failed to capture disk usage: ${err.message}`);
  }
}

// Check disk space — warn if below threshold
let diskSpaceWarned = false;
async function checkDiskSpace() {
  try {
    const { statfs } = await import('fs/promises');
    const stats = await statfs('.');
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    const usedPercent = ((totalBytes - freeBytes) / totalBytes * 100).toFixed(1);
    const freePercent = (freeBytes / totalBytes * 100).toFixed(1);
    const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);

    const thresholdRow = db.select().from(settings).where(eq(settings.key, 'disk_space_threshold')).all()[0];
    const threshold = parseInt(thresholdRow?.value || '10', 10);

    if (parseFloat(freePercent) < threshold) {
      if (!diskSpaceWarned) {
        diskSpaceWarned = true;
        log(`Disk space low: ${freeGB} GB free (${freePercent}% — threshold: ${threshold}%)`);
        notificationService.emit({
          type: 'system:disk-space-low',
          title: 'Low disk space warning',
          body: `Only ${freeGB} GB free (${freePercent}%). Used: ${usedPercent}%. Threshold: ${threshold}%.`,
          sourceType: 'system',
        });
      }
    } else {
      if (diskSpaceWarned) {
        log(`Disk space recovered: ${freeGB} GB free (${freePercent}%)`);
      }
      diskSpaceWarned = false;
    }
  } catch (err: any) {
    // statfs might not be available on all platforms
    error(`Disk space check failed: ${err.message}`);
  }
}

// Capture once on startup for an immediate baseline after deploy. The recurring
// hourly run is owned solely by the 'db-size-snapshot' JobRegistry entry
// (canonical scheduler + manual trigger), so these snapshots run once per hour
// rather than twice.
captureDbSize();
checkDiskSpace();
captureDirSizes();

// Graceful shutdown
async function shutdown() {
  log('Shutting down...');
  clearInterval(staleInterval);
  claudeCliProvider?.killAll();

  // Stop capture sessions (deactivates WireGuard tunnels)
  try { await captureManager.stopAll(); } catch (err: any) { error(`Capture cleanup: ${err.message}`); }

  proxiedRequestService.stop();
  cloudStorage.shutdown();
  fileSync.stop();
  jobRegistry.stop();
  apkAnalyzer.stop();
  apkTracker.stop();
  fridaReleaseManager.stop();
  iosDeviceManager.stop();
  deviceManager.stop();
  scheduler.stop();
  bridgeManager.stopAll();

  // Stop mitmproxy processes
  try { await mitmproxyManager.stopAll(); } catch (err: any) { error(`Mitmproxy cleanup: ${err.message}`); }

  // Run all migrated plugins' stop() in reverse topological order.
  // All plugin teardown is handled by stopAll() per the new lifecycle.
  if (pluginManager) {
    pluginManager.getHookBus().emit('app:shutdown', undefined);
    try {
      await pluginManager.stopAll();
    } catch (err: any) {
      error(`pluginManager.stopAll error: ${err?.message ?? String(err)}`);
    }
  }

  // Drain any pooled outbound HTTP dispatchers after plugin teardown.
  // Plugin stop() handlers may still be flushing requests; closing
  // before stopAll() would prematurely abort them.
  if (dispatcherApi) {
    try {
      await dispatcherApi.closeAll();
    } catch (err: any) {
      error(`dispatcherApi.closeAll error: ${err?.message ?? String(err)}`);
    }
  }

  // Stop darkride-spawned emulator instances (M1) so they don't orphan a
  // container + KVM slot + in-container forwarder + stale adb-reverse. Only
  // spawnedByDarkride===true && state==='running' rows are stopped; BYOE/observed
  // devices are left alone. Bounded by an overall 15s race so a slow/hung
  // stopInstance can never block process exit (per-instance errors are logged
  // and swallowed inside stopSpawnedInstances).
  if (deviceInstancesRepo) {
    try {
      await Promise.race([
        stopSpawnedInstances(providerRegistry, deviceInstancesRepo),
        // .unref() so a fast resolve doesn't leave this timer holding the loop
        // open (mirrors the force-exit timer below).
        new Promise((resolve) => setTimeout(resolve, 15_000).unref()),
      ]);
    } catch (err: any) {
      error(`stopSpawnedInstances error: ${err?.message ?? String(err)}`);
    }
  }

  const wss = getWebSocketServer();
  if (wss) {
    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    wss.close();
  }

  httpServer.close(() => {
    log('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 15s (up from 5s — WireGuard deactivation needs ADB round-trips)
  setTimeout(() => {
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, httpServer, db };
