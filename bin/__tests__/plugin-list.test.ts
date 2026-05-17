import { describe, it, expect } from 'vitest';
import { formatPluginTable } from '../commands/plugin-list';

describe('plugin list', () => {
  it('formats plugin table with name, version, description', () => {
    const plugins = [
      { name: 'maps', version: '1.0.0', description: 'Map tiles' },
      { name: 'demo-plugin', version: '1.0.0', description: 'Demo plugin' },
    ];
    const output = formatPluginTable(plugins);
    expect(output).toContain('maps');
    expect(output).toContain('1.0.0');
    expect(output).toContain('Map tiles');
    expect(output).toContain('demo-plugin');
    expect(output).toContain('2 plugins installed');
  });

  it('shows message when no plugins found', () => {
    const output = formatPluginTable([]);
    expect(output).toContain('No plugins installed');
  });

  it('handles missing description', () => {
    const plugins = [{ name: 'test', version: '0.1.0', description: undefined }];
    const output = formatPluginTable(plugins as any);
    expect(output).toContain('test');
    expect(output).toContain('0.1.0');
  });
});
