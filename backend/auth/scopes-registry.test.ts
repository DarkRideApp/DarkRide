import { describe, it, expect, beforeEach } from 'vitest';
import {
  listSupportedScopes, getScopeMetadata, isSupportedScope,
  registerPluginScopes, __resetPluginScopesForTests,
} from './scopes-registry';

describe('plugin-registered scopes', () => {
  beforeEach(() => __resetPluginScopesForTests());

  it('registerPluginScopes adds new keys to the registry', () => {
    registerPluginScopes('maps', [
      { key: 'plugin.maps:write', label: 'Write maps', description: 'Write map configs.', category: 'Maps' },
    ]);
    expect(isSupportedScope('plugin.maps:write')).toBe(true);
    expect(getScopeMetadata('plugin.maps:write')?.category).toBe('Maps');
    expect(listSupportedScopes().some(s => s.key === 'plugin.maps:write')).toBe(true);
  });

  it('rejects scopes that do not start with plugin.<name>', () => {
    expect(() =>
      registerPluginScopes('maps', [{ key: 'core.maps:write', label: 'x', description: 'x', category: 'x' }]),
    ).toThrow(/plugin\.maps/);
  });

  it('rejects scopes that start with plugin.<other>', () => {
    expect(() =>
      registerPluginScopes('maps', [{ key: 'plugin.other:write', label: 'x', description: 'x', category: 'x' }]),
    ).toThrow(/plugin\.maps/);
  });

  it('idempotent when called twice with identical metadata', () => {
    const entry = { key: 'plugin.maps:read', label: 'Read', description: 'Read.', category: 'Maps' };
    registerPluginScopes('maps', [entry]);
    expect(() => registerPluginScopes('maps', [entry])).not.toThrow();
  });

  it('throws when re-registered with different metadata', () => {
    registerPluginScopes('maps', [{ key: 'plugin.maps:read', label: 'A', description: 'A', category: 'Maps' }]);
    expect(() =>
      registerPluginScopes('maps', [{ key: 'plugin.maps:read', label: 'B', description: 'B', category: 'Maps' }]),
    ).toThrow(/already registered/);
  });

  it('core scopes remain supported alongside plugin scopes', () => {
    registerPluginScopes('maps', [{ key: 'plugin.maps:read', label: 'Read', description: 'Read.', category: 'Maps' }]);
    expect(isSupportedScope('core.apk:read')).toBe(true);
  });
});
