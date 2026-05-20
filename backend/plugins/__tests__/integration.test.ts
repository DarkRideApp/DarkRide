import { describe, it, expect, vi } from 'vitest';
import { PluginManager } from '../plugin-manager';
import { definePlugin } from '@darkrideapp/plugin-sdk';

describe('Plugin System Integration', () => {
  it('full lifecycle: load, register, collect metadata, emit hooks', () => {
    const manager = new PluginManager();
    const hookHandler = vi.fn();

    // Plugin A defines a hook and registers various extension points
    const pluginA = definePlugin({
      name: 'alpha',
      version: '1.0.0',
      register(ctx) {
        ctx.nav([{ group: 'Tools', label: 'Alpha', path: '/alpha', icon: 'star' }]);
        ctx.settingsDefs([{ key: 'alpha_key', label: 'Alpha Key', type: 'string' }]);
        ctx.aiTools([{
          name: 'alpha_tool',
          description: 'Test tool',
          inputSchema: {},
          context: ['alpha'],
          execute: async () => ({ ok: true }),
        }]);
        ctx.jobs([{
          id: 'alpha-job',
          name: 'Alpha Job',
          description: 'Test job',
          category: 'maintenance',
          defaultSchedule: 'Every 1h',
          run: async () => {},
        }]);
        ctx.notificationEvents([{ type: 'alpha:done', label: 'Alpha Done' }]);
        ctx.commands([{ id: 'alpha:run', label: 'Run Alpha' }]);
        ctx.hooks.define('alpha:data-ready', { id: 'number' });
        ctx.hooks.on('app:startup', hookHandler);
      },
    });

    // Plugin B depends on A and subscribes to its hook
    const betaHookHandler = vi.fn();
    const pluginB = definePlugin({
      name: 'beta',
      version: '1.0.0',
      dependencies: ['alpha'],
      register(ctx) {
        ctx.nav([{ group: 'Tools', label: 'Beta', path: '/beta', icon: 'zap' }]);
        ctx.hooks.on('alpha:data-ready', betaHookHandler);
      },
    });

    // Load in reverse dependency order to test resolution
    manager.loadPlugin(pluginB);
    manager.loadPlugin(pluginA);

    // Verify dependency resolution
    const order = manager.getLoadOrder();
    expect(order).toEqual(['alpha', 'beta']);

    // Verify metadata collection
    const metadata = manager.getPluginMetadata();
    expect(metadata).toHaveLength(2);

    const alphaMeta = metadata.find((m) => m.name === 'alpha')!;
    expect(alphaMeta.nav).toHaveLength(1);
    expect(alphaMeta.settings).toHaveLength(1);
    expect(alphaMeta.commands).toHaveLength(1);
    expect(alphaMeta.notificationEvents).toHaveLength(1);

    // Verify collected contributions
    expect(manager.getAllAiTools()).toHaveLength(1);
    expect(manager.getAllJobs()).toHaveLength(1);
    expect(manager.getAllSettings()).toHaveLength(1);
    expect(manager.getAllRouteSetups()).toHaveLength(0);

    // Verify hook bus works across plugins
    manager.getHookBus().emit('app:startup');
    expect(hookHandler).toHaveBeenCalled();

    manager.getHookBus().emit('alpha:data-ready', { id: 42 });
    expect(betaHookHandler).toHaveBeenCalledWith({ id: 42 });
  });

  it('loads kitchen sink plugin definition successfully', async () => {
    const module = await import('../../../plugins/kitchen-sink/darkride-plugin');
    const definition = module.default;

    expect(definition.name).toBe('kitchen-sink');
    // definition.version is deprecated — package.json#version is authoritative.

    const manager = new PluginManager();
    manager.loadPlugin(definition);

    const metadata = manager.getPluginMetadata();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].nav).toHaveLength(1);
    expect(metadata[0].nav[0].label).toBe('Kitchen Sink');
    expect(metadata[0].settings).toHaveLength(2);
    expect(metadata[0].commands).toHaveLength(1);
    expect(metadata[0].notificationEvents).toHaveLength(2);

    // Kitchen-sink no longer registers via the deprecated aiTools API —
    // it uses the unified ctx.tools/ctx.toolContexts surface only. The
    // legacy aiTools/aiContexts API stays in the SDK with @deprecated for
    // any external code still on it; coverage moved to scope-level tests.
    expect(manager.getAllAiTools()).toHaveLength(0);
    expect(manager.getAllJobs()).toHaveLength(1);
    expect(manager.getAllJobs()[0].id).toBe('kitchen-sink-heartbeat');
    expect(manager.getAllRouteSetups()).toHaveLength(1);

    expect(manager.getAllTools()).toHaveLength(1);
    expect(manager.getAllTools()[0].name).toBe('kitchen_sink_greet');
    expect(manager.getAllToolContexts()).toHaveLength(1);
  });

  it('preserves urlPattern and contextIdParam on tool contexts', () => {
    const plugin = definePlugin({
      name: 'test-url-patterns',
      version: '1.0.0',
      register(ctx) {
        ctx.toolContexts([
          {
            id: 'test-ctx',
            label: 'Test',
            tools: ['tool1'],
            urlPattern: '/test/:id/sub/:subId',
            contextIdParam: 'subId',
          },
        ]);
      },
    });

    const manager = new PluginManager();
    manager.loadPlugin(plugin);

    const contexts = manager.getAllToolContexts();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].urlPattern).toBe('/test/:id/sub/:subId');
    expect(contexts[0].contextIdParam).toBe('subId');

    const metadata = manager.getPluginMetadata();
    expect(metadata[0].toolContexts).toHaveLength(1);
    expect(metadata[0].toolContexts[0].urlPattern).toBe('/test/:id/sub/:subId');
    expect(metadata[0].toolContexts[0].contextIdParam).toBe('subId');
  });

  it('preserves description and critical on notification events', () => {
    const plugin = definePlugin({
      name: 'test-notification-fields',
      version: '1.0.0',
      register(ctx) {
        ctx.notificationEvents([
          { type: 'test:event', label: 'Test Event', description: 'A test event', critical: true },
          { type: 'test:plain', label: 'Plain Event' },
        ]);
      },
    });

    const manager = new PluginManager();
    manager.loadPlugin(plugin);

    const metadata = manager.getPluginMetadata();
    expect(metadata[0].notificationEvents).toHaveLength(2);
    expect(metadata[0].notificationEvents[0].description).toBe('A test event');
    expect(metadata[0].notificationEvents[0].critical).toBe(true);
    expect(metadata[0].notificationEvents[1].description).toBeUndefined();
    expect(metadata[0].notificationEvents[1].critical).toBeUndefined();
  });
});
