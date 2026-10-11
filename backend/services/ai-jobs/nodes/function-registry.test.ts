import { describe, it, expect } from 'vitest';
import { createFunctionRegistry } from './function-registry';

describe('createFunctionRegistry', () => {
  it('registers a function and returns it from get()', () => {
    const registry = createFunctionRegistry<() => number>();
    registry.register('answer', () => 42, 'Returns 42.');
    expect(registry.get('answer')?.()).toBe(42);
  });

  it('get() returns undefined for an unregistered name', () => {
    const registry = createFunctionRegistry<() => number>();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('list() returns name, description and schema, never the function itself', () => {
    const registry = createFunctionRegistry<() => number>();
    registry.register('answer', () => 42, 'Returns 42.', {
      outputSchema: [{ field: 'value', type: 'number', description: 'The answer' }],
    });
    const [entry] = registry.list();
    expect(entry).toEqual({
      name: 'answer', description: 'Returns 42.',
      inputSchema: undefined,
      outputSchema: [{ field: 'value', type: 'number', description: 'The answer' }],
    });
    expect('fn' in entry).toBe(false);
  });

  it('registering twice with the same name overwrites — last write wins, no throw (matches today\'s hand-rolled registries)', () => {
    const registry = createFunctionRegistry<() => string>();
    registry.register('x', () => 'first', 'first desc');
    registry.register('x', () => 'second', 'second desc');
    expect(registry.get('x')?.()).toBe('second');
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].description).toBe('second desc');
  });

  it('does not resolve an inherited Object.prototype key as a registered function', () => {
    const registry = createFunctionRegistry<() => number>();
    expect(registry.get('constructor')).toBeUndefined();
  });

  it('two independent registries never share state', () => {
    const a = createFunctionRegistry<() => number>();
    const b = createFunctionRegistry<() => number>();
    a.register('x', () => 1, 'a');
    expect(b.get('x')).toBeUndefined();
  });
});
