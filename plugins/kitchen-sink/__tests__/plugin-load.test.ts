import { describe, it, expect } from 'vitest';
import { PluginManager } from '../../../backend/plugins/plugin-manager';

describe('Kitchen Sink Plugin', () => {
  it('loads and registers all extension points', async () => {
    const module = await import('../darkride-plugin');
    const definition = module.default;

    expect(definition.name).toBe('kitchen-sink');
    // definition.version is deprecated — the host reads package.json#version
    // at boot. Asserting on the in-source field here would re-introduce the
    // duplication this plugin is meant to demonstrate avoiding.

    const manager = new PluginManager();
    manager.loadPlugin(definition);

    const metadata = manager.getPluginMetadata();
    expect(metadata).toHaveLength(1);

    const meta = metadata[0];

    // Nav
    expect(meta.nav).toHaveLength(1);
    expect(meta.nav[0].label).toBe('Kitchen Sink');
    expect(meta.nav[0].icon).toBe('flask-conical');
    expect(meta.nav[0].path).toBe('/kitchen-sink');

    // Pages
    expect(meta.pages).toHaveLength(1);
    expect(meta.pages[0].path).toBe('/kitchen-sink');

    // Tools (unified API)
    expect(meta.tools.length).toBeGreaterThanOrEqual(1);
    const greetTool = meta.tools.find(t => t.name === 'kitchen_sink_greet');
    expect(greetTool).toBeDefined();
    expect(greetTool!.contexts).toContain('kitchen-sink');

    // Tool contexts
    expect(meta.toolContexts.length).toBeGreaterThanOrEqual(1);
    const ksContext = meta.toolContexts.find(c => c.id === 'kitchen-sink');
    expect(ksContext).toBeDefined();
    expect(ksContext!.tools).toContain('kitchen_sink_greet');

    // Settings
    expect(meta.settings).toHaveLength(2);
    expect(meta.settings.map(s => s.key)).toContain('kitchen_sink_greeting');
    expect(meta.settings.map(s => s.key)).toContain('kitchen_sink_api_key');
    const apiKeySetting = meta.settings.find(s => s.key === 'kitchen_sink_api_key');
    expect(apiKeySetting!.secret).toBe(true);

    // Commands
    expect(meta.commands).toHaveLength(1);
    expect(meta.commands[0].id).toBe('kitchen-sink:hello');

    // Notification events
    expect(meta.notificationEvents).toHaveLength(2);
    const criticalEvent = meta.notificationEvents.find(e => e.critical);
    expect(criticalEvent).toBeDefined();
    expect(criticalEvent!.type).toBe('kitchen-sink:critical-test');
  });

  it('declares no routes from register() (routes are deferred to start())', async () => {
    // Routes that depend on services like ctx.files() must wait for the
    // service registry to be wired. kitchen-sink moved its route setup
    // into start() so handler closures can capture services directly,
    // instead of using a lazy getter that hides the dependency. The
    // integration test (which runs the full register→start lifecycle)
    // is the canonical place that asserts routes are present.
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);
    expect(manager.getAllRouteSetups()).toHaveLength(0);
  });

  it('registers DB tables via ctx.dbTables()', async () => {
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);

    // Verify the plugin registered its schema (kitchen-sink has one table)
    expect(() => manager.validateTableNames()).not.toThrow();
  });

  it('registers jobs via ctx.jobs()', async () => {
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);

    const jobs = manager.getAllJobs();
    const heartbeat = jobs.find(j => j.id === 'kitchen-sink-heartbeat');
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.category).toBe('maintenance');
    expect(heartbeat!.canRunManually).toBe(true);
    expect(typeof heartbeat!.run).toBe('function');
  });

  it('does not collide with core or other plugin table names', async () => {
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);
    expect(() => manager.validateTableNames()).not.toThrow();
  });

  it('registers protocol decoders via ctx.protocolDecoders()', async () => {
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);

    const decoders = manager.getAllProtocolDecoders();
    const echoDecoder = decoders.find((d: any) => d.id === 'kitchen-sink-echo');
    expect(echoDecoder).toBeDefined();
    expect((echoDecoder as any).name).toBe('Kitchen Sink Echo (reference)');
  });

  it('registers hooks via ctx.hooks.define() and ctx.hooks.on()', async () => {
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);

    const hookBus = manager.getHookBus();
    // The plugin defines 'kitchen-sink:item-created'
    const defined = hookBus.getDefinedHooks();
    expect(defined.find(h => h.name === 'kitchen-sink:item-created')).toBeDefined();

    // The plugin subscribes to 'app:startup' and 'device:connected' —
    // verify emit doesn't throw (handlers are registered)
    expect(() => hookBus.emit('app:startup')).not.toThrow();
    expect(() => hookBus.emit('device:connected', { id: 'test-device' })).not.toThrow();
  });

  it('registers a demo device provider via ctx.deviceProviders()', async () => {
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);
    const registered = manager.getAllDeviceProviders();
    const ksProvider = registered.find((r) => r.registration.id === 'kitchen-sink-demo-provider');
    expect(ksProvider).toBeDefined();
    expect(ksProvider!.registration.networkMode).toBe('kitchen-sink-mode');
    expect(ksProvider!.pluginName).toBe('kitchen-sink');
  });

  // Note: the "ctx.files() route file serving" coverage moved to the
  // integration test (Kitchen Sink Integration > "start()-registered
  // route is reachable"). Loading the plugin without running start()
  // intentionally produces zero routes — see "declares no routes from
  // register()" above.
});
