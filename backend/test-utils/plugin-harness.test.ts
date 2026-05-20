import { describe, it, expect, afterEach } from 'vitest';
import { createPluginTestHarness, type PluginTestHarness } from './plugin-harness';
import { existsSync } from 'fs';
import request from 'supertest';

describe('createPluginTestHarness', () => {
  let harness: PluginTestHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it('creates a harness for kitchen-sink plugin', async () => {
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    expect(harness.app).toBeDefined();
    expect(harness.db).toBeDefined();
    expect(harness.sqlite).toBeDefined();
    expect(harness.pluginManager).toBeDefined();
    expect(harness.toolRegistry).toBeDefined();
  });

  it('runs migrations on in-memory DB — core tables exist', async () => {
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    const tables = harness.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('devices');
    expect(tables).toContain('settings');
    expect(tables).toContain('plugin_state');
    expect(tables).toContain('automations');
    expect(tables).toContain('automation_sessions');
  });

  it('loads the target plugin', async () => {
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    const metadata = harness.pluginManager.getPluginMetadata();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].name).toBe('kitchen-sink');
  });

  it('registers plugin routes on Express app (start: true picks up start()-phase routes)', async () => {
    // Kitchen-sink now registers /v1/kitchen-sink/items in start(), not
    // register(). The harness must run the full lifecycle to surface
    // start()-phase routes — verify that by asking with start: true.
    harness = await createPluginTestHarness({
      pluginDir: 'plugins/kitchen-sink',
      start: true,
    });
    const res = await request(harness.app).get('/v1/kitchen-sink/items');
    expect(res.status).not.toBe(404);
  });

  it('registers plugin tools in the AiToolRegistry', async () => {
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    const tools = harness.toolRegistry.getToolsForContext('kitchen-sink');
    expect(tools.length).toBeGreaterThan(0);
  });

  it('cleanup closes the database', async () => {
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    harness.cleanup();
    expect(() => harness!.sqlite.prepare('SELECT 1').get()).toThrow();
    harness = null; // prevent double cleanup in afterEach
  });

  it('supports seed function', async () => {
    harness = await createPluginTestHarness({
      pluginDir: 'plugins/kitchen-sink',
      seed: (db) => {
        db.prepare(
          "INSERT INTO devices (id, name, platform) VALUES ('test-dev', 'Test Device', 'android')",
        ).run();
      },
    });
    const devices = harness.sqlite.prepare('SELECT * FROM devices').all();
    expect(devices).toHaveLength(1);
    expect((devices[0] as any).id).toBe('test-dev');
  });

  it('accepts string shorthand for pluginDir', async () => {
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    const meta = harness.pluginManager.getPluginMetadata();
    expect(meta[0].name).toBe('kitchen-sink');
  });

  it('throws if plugin directory does not exist', async () => {
    await expect(
      createPluginTestHarness('plugins/does-not-exist'),
    ).rejects.toThrow();
  });

  it('applies the target plugin\'s migrations to the harness DB', async () => {
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    const row = harness.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'plugin_kitchen_sink__items'",
      )
      .get();
    expect(row).toBeDefined();
  });


  it('registers unified tools', async () => {
    // Kitchen-sink no longer registers via the deprecated aiTools API —
    // see the S8 cleanup. The legacy API is still in the SDK and covered
    // by backend/plugins/__tests__/plugin-context.test.ts; the reference
    // plugin demonstrates the canonical ctx.tools/ctx.toolContexts surface.
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    const unifiedTools = harness.toolRegistry.getToolsForContext('kitchen-sink');
    const greet = unifiedTools.find((t) => t.name === 'kitchen_sink_greet');
    expect(greet).toBeDefined();
  });

  it('tools are executable via the registry', async () => {
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    const result = await harness.toolRegistry.executeTool('kitchen_sink_greet', {
      name: 'World',
    });
    expect(result).toBeDefined();
    expect(result.message).toContain('World');
  });
});

describe('createPluginTestHarness — start:true lifecycle', () => {
  let harness: PluginTestHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it('runs through start() when start:true is provided', async () => {
    harness = await createPluginTestHarness({
      pluginDir: 'plugins/kitchen-sink',
      start: true,
    });
    // startAll() completed without throwing — plugin started successfully
    expect(harness.app).toBeDefined();
    expect(harness.pluginManager).toBeDefined();
  });

  it('routes registered in start() appear in the Express app', async () => {
    harness = await createPluginTestHarness({
      pluginDir: 'plugins/kitchen-sink',
      start: true,
    });
    // /v1/kitchen-sink/started is registered only in start()
    const res = await request(harness.app).get('/v1/kitchen-sink/started');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('started');
  });

  it('routes registered in register() still appear when start:true', async () => {
    harness = await createPluginTestHarness({
      pluginDir: 'plugins/kitchen-sink',
      start: true,
    });
    const res = await request(harness.app).get('/v1/kitchen-sink/items');
    expect(res.status).toBe(200);
  });

  it('user-provided coreServices.notify override receives events emitted in start()', async () => {
    const notifyEvents: any[] = [];
    const notifySpy = (event: any) => { notifyEvents.push(event); };

    harness = await createPluginTestHarness({
      pluginDir: 'plugins/kitchen-sink',
      start: true,
      coreServices: { notify: notifySpy },
    });

    // kitchen-sink's start() calls ctx.notify() with type 'kitchen-sink:test-event'
    expect(notifyEvents.length).toBeGreaterThan(0);
    expect(notifyEvents[0].type).toBe('kitchen-sink:test-event');
  });

  it('backward compat: existing call without start option still works', async () => {
    harness = await createPluginTestHarness('plugins/kitchen-sink');
    const meta = harness.pluginManager.getPluginMetadata();
    expect(meta[0].name).toBe('kitchen-sink');

    // start()-only route should NOT be present without start:true
    const res = await request(harness.app).get('/v1/kitchen-sink/started');
    expect(res.status).toBe(404);
  });

  it('cleanup with start:true returns a Promise and closes the database', async () => {
    harness = await createPluginTestHarness({
      pluginDir: 'plugins/kitchen-sink',
      start: true,
    });
    const result = harness.cleanup();
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(() => harness!.sqlite.prepare('SELECT 1').get()).toThrow();
    harness = null; // prevent double cleanup in afterEach
  });
});
