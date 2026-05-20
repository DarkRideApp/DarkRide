import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPluginTestHarness,
  type PluginTestHarness,
} from '../../../backend/test-utils/plugin-harness';
import request from 'supertest';

describe('Kitchen Sink Integration', () => {
  let harness: PluginTestHarness;

  beforeAll(async () => {
    // start: true so kitchen-sink's start() runs and the exercised
    // ctx-extension demos (settings/websocket/dispatcher/etc.) are
    // covered by this integration test.
    harness = await createPluginTestHarness({
      pluginDir: 'plugins/kitchen-sink',
      start: true,
    });
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  // -- Metadata --

  it('plugin metadata includes all extension points', () => {
    const meta = harness.pluginManager.getPluginMetadata();
    expect(meta).toHaveLength(1);
    const ks = meta[0];
    expect(ks.name).toBe('kitchen-sink');
    expect(ks.nav.length).toBeGreaterThan(0);
    expect(ks.pages.length).toBeGreaterThan(0);
    expect(ks.tools.length).toBeGreaterThan(0);
    expect(ks.settings.length).toBeGreaterThan(0);
  });

  // -- HTTP Routes --

  it('GET /v1/kitchen-sink/items returns items array', async () => {
    const res = await request(harness.app).get('/v1/kitchen-sink/items');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('POST /v1/kitchen-sink/echo echoes body', async () => {
    const body = { hello: 'world' };
    const res = await request(harness.app)
      .post('/v1/kitchen-sink/echo')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(body);
  });

  it('GET /v1/kitchen-sink/health returns healthy status', async () => {
    const res = await request(harness.app).get('/v1/kitchen-sink/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('healthy');
    expect(res.body.plugin).toBe('kitchen-sink');
  });

  it('unknown routes return 404', async () => {
    const res = await request(harness.app).get('/v1/kitchen-sink/nonexistent');
    expect(res.status).toBe(404);
  });

  it('start()-registered route is reachable (confirms full lifecycle ran)', async () => {
    // /v1/kitchen-sink/started is registered inside start(), not register().
    // If this route 404s, the harness didn't actually run startAll() — that
    // would mean the ctx-extension demos in start() weren't exercised either.
    const res = await request(harness.app).get('/v1/kitchen-sink/started');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('started');
  });

  // -- Tools --

  it('unified tools are registered and executable', async () => {
    const tools = harness.toolRegistry.getToolsForContext('kitchen-sink');
    const greetTool = tools.find((t) => t.name === 'kitchen_sink_greet');
    expect(greetTool).toBeDefined();

    const result = await harness.toolRegistry.executeTool('kitchen_sink_greet', {
      name: 'Tester',
    });
    expect(result).toBeDefined();
    expect(result.message).toContain('Tester');
  });

  // -- Hooks --

  it('hooks are registered', () => {
    const hookBus = harness.pluginManager.getHookBus();
    const defined = hookBus.getDefinedHooks();
    expect(
      defined.find((h: any) => h.name === 'kitchen-sink:item-created'),
    ).toBeDefined();
  });

  // -- Settings --

  it('settings are registered', () => {
    const meta = harness.pluginManager.getPluginMetadata()[0];
    const keys = meta.settings.map((s) => s.key);
    expect(keys).toContain('kitchen_sink_greeting');
    expect(keys).toContain('kitchen_sink_api_key');
  });

  // -- DB --

  it('can query core tables through the harness DB', () => {
    // The in-memory DB should have all core tables from migrations
    const result = harness.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'")
      .get() as any;
    expect(result).toBeDefined();
    expect(result.name).toBe('devices');
  });
});
