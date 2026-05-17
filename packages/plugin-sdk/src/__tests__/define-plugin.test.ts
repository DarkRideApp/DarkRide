import { describe, it, expect } from 'vitest';
import { definePlugin } from '../define-plugin';

describe('definePlugin lifecycle fields', () => {
  it('passes through start/stop/startTimeoutMs', () => {
    const start = async () => {};
    const stop = async () => {};
    const def = definePlugin({
      name: 'lifecycle-test',
      version: '0.1.0',
      register: () => {},
      start,
      stop,
      startTimeoutMs: 5000,
    });
    expect(def.start).toBe(start);
    expect(def.stop).toBe(stop);
    expect(def.startTimeoutMs).toBe(5000);
  });

  it('start/stop/startTimeoutMs are optional', () => {
    const def = definePlugin({
      name: 'no-lifecycle',
      version: '0.1.0',
      register: () => {},
    });
    expect(def.start).toBeUndefined();
    expect(def.stop).toBeUndefined();
    expect(def.startTimeoutMs).toBeUndefined();
  });
});

describe('definePlugin', () => {
  it('returns a valid plugin definition with all required fields', () => {
    const plugin = definePlugin({
      name: 'test-plugin',
      version: '1.0.0',
      register: () => {},
    });
    expect(plugin.name).toBe('test-plugin');
    expect(plugin.version).toBe('1.0.0');
    expect(typeof plugin.register).toBe('function');
    expect(plugin.dependencies).toEqual([]);
    expect(plugin.optionalDependencies).toEqual([]);
  });

  it('rejects invalid plugin names', () => {
    expect(() => definePlugin({
      name: 'Invalid Name!',
      version: '1.0.0',
      register: () => {},
    })).toThrow('Plugin name must be lowercase alphanumeric with hyphens');
  });

  it('rejects names with trailing hyphens', () => {
    expect(() => definePlugin({ name: 'plugin-', version: '1.0.0', register: () => {} }))
      .toThrow('Plugin name must be lowercase alphanumeric with hyphens');
  });

  it('rejects names with consecutive hyphens', () => {
    expect(() => definePlugin({ name: 'my--plugin', version: '1.0.0', register: () => {} }))
      .toThrow('Plugin name must be lowercase alphanumeric with hyphens');
  });

  it('preserves optional fields when provided', () => {
    const plugin = definePlugin({
      name: 'my-plugin',
      version: '2.0.0',
      darkride: '>=2.0.0',
      dependencies: ['other-plugin'],
      optionalDependencies: ['maybe-plugin'],
      register: () => {},
    });
    expect(plugin.darkride).toBe('>=2.0.0');
    expect(plugin.dependencies).toEqual(['other-plugin']);
    expect(plugin.optionalDependencies).toEqual(['maybe-plugin']);
  });
});

describe('definePlugin aiScopes', () => {
  it('defaults aiScopes to empty array when absent', () => {
    const p = definePlugin({ name: 'no-ai', version: '1.0.0', register: () => {} });
    expect(p.aiScopes).toEqual([]);
  });

  it('carries declared aiScopes through', () => {
    const p = definePlugin({
      name: 'uses-ai',
      version: '1.0.0',
      aiScopes: ['core.apk:read'],
      register: () => {},
    });
    expect(p.aiScopes).toEqual(['core.apk:read']);
  });

  it('rejects non-array aiScopes at definition time', () => {
    expect(() => definePlugin({
      name: 'bad',
      version: '1.0.0',
      aiScopes: 'core.apk:read' as any,
      register: () => {},
    })).toThrow(/aiScopes.*array/i);
  });
});
