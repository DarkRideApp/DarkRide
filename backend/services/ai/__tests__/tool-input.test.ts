import { describe, it, expect } from 'vitest';
import { toolInput } from '../tool-input';

describe('toolInput', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a string', 'text'],
    ['a JSON object written as a string', '{"a":1}'],
    ['a boolean', true],
    ['an array', [1, 2]],
    ['an empty array', []],
  ])('%s becomes an empty object', (_label, value) => {
    expect(toolInput(value)).toEqual({});
  });

  it('keeps a plain object as it is, nested values included', () => {
    const value = { a: 1, b: { c: [1, 2], d: null } };
    expect(toolInput(value)).toBe(value);
  });

  it('keeps an empty object', () => {
    const value = {};
    expect(toolInput(value)).toBe(value);
  });

  it('returns a fresh object for each non-object input, so callers never share one', () => {
    expect(toolInput(null)).not.toBe(toolInput(null));
  });
});
