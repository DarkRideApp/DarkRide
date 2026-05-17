import { describe, it, expect } from 'vitest';
import { computeLoadOrder } from '../load-order';
import { definePlugin } from '@darkrideapp/plugin-sdk';
import type { LoadOrderEntry } from '../load-order';

function entry(name: string, deps: string[] = [], optDeps: string[] = []): LoadOrderEntry {
  return {
    name,
    definition: definePlugin({
      name,
      version: '1.0.0',
      dependencies: deps,
      optionalDependencies: optDeps,
      register() {},
    }),
  };
}

describe('computeLoadOrder', () => {
  it('single plugin with no dependencies returns that plugin', () => {
    const order = computeLoadOrder([entry('solo')]);
    expect(order).toEqual(['solo']);
  });

  it('B depends on A → returns [A, B]', () => {
    const order = computeLoadOrder([entry('b', ['a']), entry('a')]);
    expect(order).toEqual(['a', 'b']);
  });

  it('C depends on A and B (B depends on A) → returns [A, B, C]', () => {
    // C depends on [a, b], B depends on [a]
    const order = computeLoadOrder([
      entry('c', ['a', 'b']),
      entry('b', ['a']),
      entry('a'),
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('optional dependency present → followed (dep comes first)', () => {
    const order = computeLoadOrder([
      entry('consumer', [], ['optional-dep']),
      entry('optional-dep'),
    ]);
    expect(order.indexOf('optional-dep')).toBeLessThan(order.indexOf('consumer'));
  });

  it('optional dependency missing → ignored (no throw)', () => {
    expect(() =>
      computeLoadOrder([entry('solo', [], ['nonexistent'])]),
    ).not.toThrow();
    const order = computeLoadOrder([entry('solo', [], ['nonexistent'])]);
    expect(order).toEqual(['solo']);
  });

  it('missing required dependency → throws', () => {
    expect(() =>
      computeLoadOrder([entry('needs-missing', ['does-not-exist'])]),
    ).toThrow('Missing required dependency');
  });

  it('circular dependency → throws', () => {
    expect(() =>
      computeLoadOrder([
        entry('a', ['b']),
        entry('b', ['a']),
      ]),
    ).toThrow('Circular dependency');
  });

  it('diamond dependency → each plugin appears exactly once', () => {
    // D depends on [b, c], B depends on [a], C depends on [a]
    const order = computeLoadOrder([
      entry('d', ['b', 'c']),
      entry('b', ['a']),
      entry('c', ['a']),
      entry('a'),
    ]);
    // a must appear before b and c; b and c before d; a appears exactly once
    expect(order.filter(n => n === 'a')).toHaveLength(1);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('empty list returns empty list', () => {
    expect(computeLoadOrder([])).toEqual([]);
  });
});
