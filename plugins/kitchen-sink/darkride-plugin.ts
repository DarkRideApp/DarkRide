import { definePlugin } from '@darkrideapp/plugin-sdk';
import { setupRoutes } from './backend/routes';
import * as schema from './backend/schema';

export default definePlugin({
  name: 'kitchen-sink',
  // version is read from package.json#version at boot — see PluginDefinition.

  register(ctx) {
    // --- Extension Point: DB Tables ---
    // register() is the right place for declarative contributions like
    // schema, nav, pages — no services available yet, but none needed.
    ctx.dbTables(schema);

    // --- Extension Point: Nav ---
    ctx.nav([
      { group: 'Tools', label: 'Kitchen Sink', path: '/kitchen-sink', icon: 'flask-conical' },
    ]);

    // --- Extension Point: Pages ---
    ctx.pages([
      { path: '/kitchen-sink' },
    ]);

    // --- Extension Point: Unified Tools ---
    ctx.tools([
      {
        name: 'kitchen_sink_greet',
        description: 'A test unified tool. Returns a greeting via all 5 consumers.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name to greet' },
          },
          required: ['name'],
        },
        contexts: ['kitchen-sink'],
        execute: async (params: { name: string }) => {
          return { message: `Greetings, ${params.name}! Sent via unified tools.` };
        },
      },
    ]);

    ctx.toolContexts([
      { id: 'kitchen-sink', label: 'Kitchen Sink', tools: ['kitchen_sink_greet'] },
    ]);

    // --- Extension Point: Jobs ---
    ctx.jobs([
      {
        id: 'kitchen-sink-heartbeat',
        name: 'Kitchen Sink Heartbeat',
        description: 'Test job — logs a heartbeat message every interval',
        category: 'maintenance',
        defaultSchedule: 'Every 1h',
        canRunManually: true,
        run: async () => {
          ctx.logger().log('[KitchenSink] Heartbeat job ran at', new Date().toISOString());
        },
      },
    ]);

    // --- Extension Point: Settings ---
    ctx.settingsDefs([
      { key: 'kitchen_sink_greeting', label: 'Greeting Message', type: 'string', defaultValue: 'Hello from Kitchen Sink!' },
      { key: 'kitchen_sink_api_key', label: 'Test API Key', type: 'string', secret: true },
    ]);

    // --- Extension Point: Commands ---
    ctx.commands([
      { id: 'kitchen-sink:hello', label: 'Kitchen Sink: Say Hello', keywords: ['test', 'greeting'], icon: 'flask-conical' },
    ]);

    // --- Extension Point: Notification Events ---
    ctx.notificationEvents([
      { type: 'kitchen-sink:test-event', label: 'Kitchen Sink Test Event' },
      { type: 'kitchen-sink:critical-test', label: 'Kitchen Sink Critical Test', critical: true },
    ]);

    // --- Extension Point: Protocol Decoders (backend registration) ---
    // Note: the actual decoder logic lives in frontend/plugin.ts via
    // pluginRegistry.registerDecoders(). This backend call demonstrates the
    // ctx.protocolDecoders() extension point and keeps this plugin as a
    // complete reference — but the backend decoders collection is not yet
    // wired through to the frontend (see the decoder registry in
    // frontend/lib/protocol-decoders/). For now the frontend side is the
    // source of truth for decoder registration.
    ctx.protocolDecoders([
      {
        id: 'kitchen-sink-echo',
        name: 'Kitchen Sink Echo (reference)',
      },
    ]);

    // --- Extension Point: UI Slots ---
    ctx.uiSlots([
      {
        id: 'kitchen-sink:demo:extra',
        kind: 'container',
        description: 'Demo slot on the kitchen-sink demo page. Shows off cross-plugin slot contributions — even if only the same plugin contributes.',
      },
    ]);

    ctx.uiContributions([
      { slot: 'kitchen-sink:demo:extra', id: 'kitchen-sink:demo-extra', component: 'DemoExtra' },
    ]);

    // --- Extension Point: Hooks (define + subscribe) ---
    ctx.hooks.define('kitchen-sink:item-created', { id: 'number', title: 'string' });

    const logger = ctx.logger();

    ctx.hooks.on('app:startup', () => {
      logger.log('[KitchenSink] Plugin received app:startup hook');
    });

    ctx.hooks.on('device:connected', (device: any) => {
      logger.log(`[KitchenSink] Device connected: ${device?.id ?? 'unknown'}`);
    });
  },

  async start(ctx) {
    const logger = ctx.logger();

    // --- Extension Point: Routes ---
    // Register routes here (not in register()) so handlers can close over
    // services constructed at start time. Capturing `ctx.files()` once
    // and passing it via a closure beats the older "lazy getter inside
    // the handler" pattern — it makes the lifecycle dependency obvious
    // and removes the runtime try/catch dance.
    const files = ctx.files();
    ctx.routes((router) => {
      setupRoutes(router, () => files);
    });

    // ─── Extension Point: ctx.settings (read/write KV at runtime) ───────
    // Plugins access the host's settings table via ctx.settings — works
    // identically whether the plugin is in-tree or installed via the
    // marketplace. Reads return null when unset; writes are async.
    const greeting = await ctx.settings.get('kitchen_sink_greeting');
    logger.log(`[KitchenSink] greeting setting on boot: ${greeting ?? '(unset)'}`);

    // ─── Extension Point: ctx.websocket (channels + broadcast) ─────────
    // Register a filtered channel so subsequent broadcasts on this type
    // only deliver to clients that subscribed to "kitchen-sink:demo".
    ctx.websocket.registerChannel('kitchen-sink:demo');
    ctx.websocket.broadcast({
      type: 'kitchen-sink:demo',
      hello: 'Kitchen Sink came online',
      at: Date.now(),
    });

    // ─── Extension Point: ctx.paths (DATA_ROOT-relative path resolution) ─
    // Use when an external process (sidecar binary, child Python script,
    // etc.) needs an absolute path. For plugin-scoped storage prefer
    // ctx.files() — ctx.paths is the escape hatch.
    const exportPath = ctx.paths.fileStorage('exports/kitchen-sink/');
    logger.log(`[KitchenSink] exports path: ${exportPath}`);

    // ─── Extension Point: ctx.cloudFiles (sync-state management) ───────
    // Read-only demo: list any cloud files registered under this plugin's
    // namespace. New plugins typically don't need to touch cloudFiles
    // directly — the file-sync runner manages state for them.
    const cloudFiles = await ctx.cloudFiles.listByNamespace('kitchen-sink');
    logger.log(`[KitchenSink] cloudFiles count: ${cloudFiles.length}`);

    // ─── Extension Point: ctx.automations (read-only listing) ──────────
    // Demonstrates the read-only listing surface; most plugins never need
    // to enumerate automations directly. Surface it here so the kitchen-
    // sink stays a complete reference.
    const automations = await ctx.automations.list();
    logger.log(`[KitchenSink] automations count: ${automations.length}`);

    // ─── Extension Point: ctx.dispatcher (pooled outbound HTTP) ────────
    // Construct a dispatcher with placeholder credentials and immediately
    // discard the reference — the host's pool de-duplicates by spec, so
    // this is a no-op against any other plugin that asks for the same
    // upstream. NEVER actually fetch through this in the demo; we only
    // want to exercise the wiring + the singleton-per-spec guarantee.
    const demoDispatcher = ctx.dispatcher({
      type: 'socks5',
      host: 'demo.example.invalid',
      port: 1080,
      connections: 1,
    });
    logger.log(`[KitchenSink] dispatcher constructed: ${demoDispatcher.constructor.name}`);

    // ─── Extension Point: ctx.apks (read-only) ─────────────────────────
    // Look up a sentinel version that does not exist; the API answers
    // null cleanly rather than throwing. Plugins that work with APKs use
    // lookupVersion to find a handle, then ensureLocal to materialize.
    const apkLookup = await ctx.apks.lookupVersion(-1);
    logger.log(`[KitchenSink] apks.lookupVersion(-1) → ${apkLookup === null ? 'null (expected)' : 'unexpected hit'}`);

    // Register a route that is only available after start() — used to verify
    // that the harness picks up start()-phase contributions.
    ctx.routes((router) => {
      router.get('/v1/kitchen-sink/started', (_req, res) => {
        res.json({ success: true, status: 'started' });
      });
    });

    // Emit a startup notification so harness tests can verify notify wiring.
    ctx.notify({
      type: 'kitchen-sink:test-event',
      title: 'Kitchen Sink started',
      body: 'Plugin start() lifecycle ran successfully.',
      sourceType: 'plugin',
      sourceId: 'kitchen-sink',
    });
  },
});
