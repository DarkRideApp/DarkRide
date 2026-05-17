import { describe, it, expect } from 'vitest';
import { PluginManager } from '../../../backend/plugins/plugin-manager';

describe('{{label}} Plugin', () => {
  it('loads and registers extension points', async () => {
    const module = await import('../darkride-plugin');
    const definition = module.default;

    expect(definition.name).toBe('{{slug}}');

    const manager = new PluginManager();
    manager.loadPlugin(definition);

    const metadata = manager.getPluginMetadata();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].nav).toHaveLength(1);
    expect(metadata[0].pages).toHaveLength(1);
  });

  it('does not collide with other plugin table names', async () => {
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);
    expect(() => manager.validateTableNames()).not.toThrow();
  });
});
