import { describe, it, expect } from 'vitest';
import { registerTransform, runTransform } from './transform';

describe('runTransform', () => {
  registerTransform('test/double', (input) => ({ n: (input.n as number) * 2 }));

  it('runs the registered function by name', () => {
    expect(runTransform({ fn: 'test/double' }, { n: 5 })).toEqual({ n: 10 });
  });

  it('throws on an unregistered function name', () => {
    expect(() => runTransform({ fn: 'test/nope' }, {})).toThrow(/Unknown transform "test\/nope"/);
  });
});
