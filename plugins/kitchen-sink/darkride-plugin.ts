import { definePlugin } from '@darkrideapp/plugin-sdk';
import { setupRoutes } from './backend/routes';
import * as schema from './backend/schema';

export default definePlugin({
  name: 'kitchen-sink',
  version: '0.1.0',

  register(ctx) {
    // --- Extension Point: Routes ---
    // Routes need ctx.files(), which is wired after register().
    // We pass a getter that resolves lazily at request time.
    ctx.routes((router) => {
      const getFiles = () => { try { return ctx.files(); } catch { return undefined; } };
      setupRoutes(router, getFiles);
    });

    // --- Extension Point: DB Tables ---
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
