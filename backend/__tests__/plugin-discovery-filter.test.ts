import { describe, it, expect } from 'vitest';
import { applyPluginFilter } from '../plugins/discover';
import type { DiscoveredPlugin } from '../plugins/discover';
import type { PluginDefinition } from '@darkrideapp/plugin-sdk';

// ---------------------------------------------------------------------------
// Minimal stub helpers
// ---------------------------------------------------------------------------

function makePlugin(name: string, dependencies: string[] = []): DiscoveredPlugin {
  return {
    name,
    path: `/fake/plugins/${name}`,
    source: 'workspace',
    definition: {
      name,
      version: '0.0.1',
      dependencies,
      register: () => {},
    } as unknown as PluginDefinition,
  };
}

const noop = (_msg: string) => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyPluginFilter', () => {
  const alpha = makePlugin('alpha');
  const beta = makePlugin('beta');
  const gamma = makePlugin('gamma');
  const all = [alpha, beta, gamma];

  it('returns all plugins when filterEnv is undefined', () => {
    expect(applyPluginFilter(all, undefined, noop)).toEqual(all);
  });

  it('returns all plugins when filterEnv is an empty string', () => {
    expect(applyPluginFilter(all, '', noop)).toEqual(all);
  });

  it('returns all plugins when filterEnv is whitespace only', () => {
    expect(applyPluginFilter(all, '   ', noop)).toEqual(all);
  });

  it('filters to only the named plugin', () => {
    const result = applyPluginFilter(all, 'alpha', noop);
    expect(result.map(p => p.name)).toEqual(['alpha']);
  });

  it('handles comma-separated names', () => {
    const result = applyPluginFilter(all, 'alpha,gamma', noop);
    expect(result.map(p => p.name).sort()).toEqual(['alpha', 'gamma']);
  });

  it('tolerates whitespace around names', () => {
    const result = applyPluginFilter(all, ' alpha , gamma ', noop);
    expect(result.map(p => p.name).sort()).toEqual(['alpha', 'gamma']);
  });

  it('ignores empty segments from trailing/leading commas', () => {
    const result = applyPluginFilter(all, ',alpha,,', noop);
    expect(result.map(p => p.name)).toEqual(['alpha']);
  });

  it('auto-includes required dependencies', () => {
    const dep = makePlugin('dep');
    const main = makePlugin('main', ['dep']);
    const result = applyPluginFilter([dep, main], 'main', noop);
    expect(result.map(p => p.name).sort()).toEqual(['dep', 'main']);
  });

  it('auto-includes transitive required dependencies', () => {
    const base = makePlugin('base');
    const mid = makePlugin('mid', ['base']);
    const top = makePlugin('top', ['mid']);
    const result = applyPluginFilter([base, mid, top], 'top', noop);
    expect(result.map(p => p.name).sort()).toEqual(['base', 'mid', 'top']);
  });

  it('does NOT auto-include optional (non-declared) deps', () => {
    // 'extra' is present in the pool but not listed as a dep of alpha
    const extra = makePlugin('extra');
    const result = applyPluginFilter([alpha, extra], 'alpha', noop);
    expect(result.map(p => p.name)).toEqual(['alpha']);
  });

  it('logs a warning for unknown plugin names but does not throw', () => {
    const warnings: string[] = [];
    const result = applyPluginFilter(all, 'alpha,no-such-plugin', (msg) => warnings.push(msg));
    expect(result.map(p => p.name)).toEqual(['alpha']);
    expect(warnings.some(w => w.includes('no-such-plugin'))).toBe(true);
  });

  it('logs auto-include notice for deps not in the requested set', () => {
    const dep = makePlugin('dep');
    const main = makePlugin('main', ['dep']);
    const notices: string[] = [];
    applyPluginFilter([dep, main], 'main', (msg) => notices.push(msg));
    expect(notices.some(n => n.includes('Auto-including') && n.includes('dep'))).toBe(true);
  });

  it('does not log auto-include for a dep that was explicitly requested', () => {
    const dep = makePlugin('dep');
    const main = makePlugin('main', ['dep']);
    const notices: string[] = [];
    // Both explicitly requested — no auto-include notice expected
    applyPluginFilter([dep, main], 'main,dep', (msg) => notices.push(msg));
    expect(notices.some(n => n.includes('Auto-including'))).toBe(false);
  });

  it('handles circular dependencies without infinite recursion', () => {
    // Manually set up circular deps (not valid in practice but defensive test)
    const a = makePlugin('a', ['b']);
    const b = makePlugin('b', ['a']);
    expect(() => applyPluginFilter([a, b], 'a', noop)).not.toThrow();
  });

  it('env-var parsing: split / trim / filter empty — unit check', () => {
    // Verify the exact names that would be extracted from a messy env value
    const envValue = '  foo , bar ,, baz  ';
    const parsed = envValue.split(',').map(s => s.trim()).filter(Boolean);
    expect(parsed).toEqual(['foo', 'bar', 'baz']);
  });
});
