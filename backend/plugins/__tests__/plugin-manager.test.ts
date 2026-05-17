import { describe, it, expect } from 'vitest';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { PluginManager } from '../plugin-manager';
import { definePlugin } from '@darkrideapp/plugin-sdk';

describe('PluginManager', () => {
  it('loads a plugin definition and collects metadata', () => {
    const manager = new PluginManager();
    const plugin = definePlugin({
      name: 'test',
      version: '1.0.0',
      register(ctx) {
        ctx.nav([{ group: 'Tools', label: 'Test', path: '/test', icon: 'box' }]);
        ctx.settingsDefs([{ key: 'test_key', label: 'Key', type: 'string' }]);
      },
    });

    manager.loadPlugin(plugin);
    const metadata = manager.getPluginMetadata();

    expect(metadata).toHaveLength(1);
    expect(metadata[0].name).toBe('test');
    expect(metadata[0].nav).toHaveLength(1);
    expect(metadata[0].settings).toHaveLength(1);
  });

  it('resolves dependency order correctly', () => {
    const manager = new PluginManager();

    const pluginA = definePlugin({
      name: 'plugin-a',
      version: '1.0.0',
      dependencies: ['plugin-b'],
      register() {},
    });

    const pluginB = definePlugin({
      name: 'plugin-b',
      version: '1.0.0',
      register() {},
    });

    manager.loadPlugin(pluginA);
    manager.loadPlugin(pluginB);
    const ordered = manager.getLoadOrder();

    expect(ordered[0]).toBe('plugin-b');
    expect(ordered[1]).toBe('plugin-a');
  });

  it('rejects circular dependencies', () => {
    const manager = new PluginManager();

    manager.loadPlugin(definePlugin({
      name: 'a',
      version: '1.0.0',
      dependencies: ['b'],
      register() {},
    }));

    manager.loadPlugin(definePlugin({
      name: 'b',
      version: '1.0.0',
      dependencies: ['a'],
      register() {},
    }));

    expect(() => manager.getLoadOrder()).toThrow('Circular dependency');
  });

  it('warns on missing optional dependency without failing', () => {
    const manager = new PluginManager();

    manager.loadPlugin(definePlugin({
      name: 'test',
      version: '1.0.0',
      optionalDependencies: ['nonexistent'],
      register() {},
    }));

    expect(() => manager.getLoadOrder()).not.toThrow();
  });

  it('throws on missing required dependency', () => {
    const manager = new PluginManager();

    manager.loadPlugin(definePlugin({
      name: 'test',
      version: '1.0.0',
      dependencies: ['required-missing'],
      register() {},
    }));

    expect(() => manager.getLoadOrder()).toThrow('Missing required dependency');
  });

  it('collects all routes from all plugins', () => {
    const manager = new PluginManager();

    manager.loadPlugin(definePlugin({
      name: 'a',
      version: '1.0.0',
      register(ctx) {
        ctx.routes((router) => { router.get('/a/hello', (_req, res) => res.json({ ok: true })); });
      },
    }));

    manager.loadPlugin(definePlugin({
      name: 'b',
      version: '1.0.0',
      register(ctx) {
        ctx.routes((router) => { router.get('/b/hello', (_req, res) => res.json({ ok: true })); });
      },
    }));

    const allRoutes = manager.getAllRouteSetups();
    expect(allRoutes).toHaveLength(2);
  });

  it('detects table name collisions between plugins', () => {
    const manager = new PluginManager();
    const sharedTable = sqliteTable('my_items', {
      id: integer('id').primaryKey(),
    });

    manager.loadPlugin(definePlugin({
      name: 'alpha',
      version: '1.0.0',
      register(ctx) { ctx.dbTables({ sharedTable }); },
    }));

    manager.loadPlugin(definePlugin({
      name: 'beta',
      version: '1.0.0',
      register(ctx) { ctx.dbTables({ sharedTable }); },
    }));

    expect(() => manager.validateTableNames()).toThrow(
      'Table name collision: "my_items" is declared by both plugin "alpha" and plugin "beta"',
    );
  });

  it('detects table name collisions with core schema', () => {
    const manager = new PluginManager();
    const coreSchema = {
      devices: sqliteTable('devices', { id: text('id').primaryKey() }),
    };

    manager.loadPlugin(definePlugin({
      name: 'bad-plugin',
      version: '1.0.0',
      register(ctx) {
        ctx.dbTables({
          devices: sqliteTable('devices', { id: text('id').primaryKey() }),
        });
      },
    }));

    expect(() => manager.validateTableNames(coreSchema)).toThrow(
      'Table name collision: "devices" is declared by both (core) and plugin "bad-plugin"',
    );
  });

  it('passes validation when table names are unique', () => {
    const manager = new PluginManager();
    const coreSchema = {
      devices: sqliteTable('devices', { id: text('id').primaryKey() }),
    };

    manager.loadPlugin(definePlugin({
      name: 'alpha',
      version: '1.0.0',
      register(ctx) {
        ctx.dbTables({
          items: sqliteTable('plugin_alpha__items', { id: integer('id').primaryKey() }),
        });
      },
    }));

    expect(() => manager.validateTableNames(coreSchema)).not.toThrow();
  });

  it('collects tools from all plugins', () => {
    const manager = new PluginManager();
    manager.loadPlugin(definePlugin({
      name: 'a',
      version: '1.0.0',
      register(ctx) {
        ctx.tools([{
          name: 'a_tool',
          description: 'Tool A',
          inputSchema: {},
          contexts: ['a'],
          execute: async () => ({}),
        }]);
      },
    }));
    expect(manager.getAllTools()).toHaveLength(1);
    expect(manager.getAllTools()[0].name).toBe('a_tool');
  });
});
