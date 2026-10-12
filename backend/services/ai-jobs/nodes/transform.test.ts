import { describe, it, expect } from 'vitest';
import { registerTransform, runTransform, TRANSFORM_DESCRIPTIONS, TRANSFORM_SCHEMAS } from './transform';

describe('runTransform', () => {
  registerTransform('test/double', (input) => ({ n: (input.n as number) * 2 }),
    'Doubles a numeric field.',
    { inputSchema: [{ field: 'n', type: 'number', description: 'Input number' }],
      outputSchema: [{ field: 'n', type: 'number', description: 'Doubled result' }] });

  it('runs the registered function by name', () => {
    expect(runTransform({ fn: 'test/double' }, { n: 5 })).toEqual({ n: 10 });
  });

  it('throws on an unregistered function name', () => {
    expect(() => runTransform({ fn: 'test/nope' }, {})).toThrow(/Unknown transform "test\/nope"/);
  });

  it('treats an inherited Object.prototype key as unregistered rather than resolving it', () => {
    expect(() => runTransform({ fn: 'constructor' }, {})).toThrow(/Unknown transform "constructor"/);
  });

  it('describes every registered transform function', () => {
    expect(TRANSFORM_DESCRIPTIONS['test/double']).toBe('Doubles a numeric field.');
  });

  it('declares a schema for a registered transform function', () => {
    expect(TRANSFORM_SCHEMAS['test/double']).toEqual({
      inputSchema: [{ field: 'n', type: 'number', description: 'Input number' }],
      outputSchema: [{ field: 'n', type: 'number', description: 'Doubled result' }],
    });
  });
});
