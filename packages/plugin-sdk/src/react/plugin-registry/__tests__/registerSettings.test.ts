import { describe, it, expect, beforeEach } from 'vitest';
import { pluginRegistry, __resetPluginRegistry } from '../index';

function NoopComponent() { return null; }

describe('pluginRegistry.registerSettings', () => {
  beforeEach(() => __resetPluginRegistry());

  it('registerSettings stores label and component', () => {
    pluginRegistry.registerSettings('foo', { label: 'Foo', component: NoopComponent });
    const entries = pluginRegistry.getSettings();
    expect(entries).toHaveLength(1);
    expect(entries[0].pluginName).toBe('foo');
    expect(entries[0].label).toBe('Foo');
    expect(entries[0].component).toBe(NoopComponent);
    expect(entries[0].order).toBe(0);
  });

  it('getSettings returns entries sorted by order, then label', () => {
    pluginRegistry.registerSettings('zeta', { label: 'Zeta', component: NoopComponent });
    pluginRegistry.registerSettings('alpha', { label: 'Alpha', component: NoopComponent });
    pluginRegistry.registerSettings('mid', { label: 'Mid', component: NoopComponent, order: -1 });
    const entries = pluginRegistry.getSettings();
    expect(entries.map(e => e.label)).toEqual(['Mid', 'Alpha', 'Zeta']);
  });

  it('registering same plugin twice replaces the previous entry', () => {
    pluginRegistry.registerSettings('foo', { label: 'Foo v1', component: NoopComponent });
    pluginRegistry.registerSettings('foo', { label: 'Foo v2', component: NoopComponent });
    const entries = pluginRegistry.getSettings();
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('Foo v2');
  });

  it('getSettings filters disabled plugins', () => {
    pluginRegistry.registerSettings('on', { label: 'On', component: NoopComponent });
    pluginRegistry.registerSettings('off', { label: 'Off', component: NoopComponent });
    pluginRegistry.setDisabledPlugins(['off']);
    const entries = pluginRegistry.getSettings();
    expect(entries.map(e => e.pluginName)).toEqual(['on']);
  });

  it('registerSettings notifies subscribers', () => {
    let notified = 0;
    pluginRegistry.subscribe(() => notified++);
    pluginRegistry.registerSettings('foo', { label: 'Foo', component: NoopComponent });
    expect(notified).toBeGreaterThan(0);
  });
});
