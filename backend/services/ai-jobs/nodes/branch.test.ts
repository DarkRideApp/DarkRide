import { describe, it, expect } from 'vitest';
import { registerBranchPredicate, runBranch } from './branch';
import type { Envelope } from '../types';

describe('runBranch', () => {
  registerBranchPredicate('test/ok-or-fallback', (e: Envelope) => (e.status === 'ok' ? 'primary' : 'fallback'));

  it('routes to the edge the predicate returns for an ok envelope', () => {
    const edge = runBranch({ predicate: 'test/ok-or-fallback', edges: ['primary', 'fallback'] }, { status: 'ok', output: {} });
    expect(edge).toBe('primary');
  });

  it('routes to the edge the predicate returns for a failed envelope', () => {
    const edge = runBranch({ predicate: 'test/ok-or-fallback', edges: ['primary', 'fallback'] }, { status: 'failed', error: 'boom' });
    expect(edge).toBe('fallback');
  });

  it('throws if the predicate returns an edge not declared in config.edges', () => {
    registerBranchPredicate('test/bogus', () => 'not-declared');
    expect(() => runBranch({ predicate: 'test/bogus', edges: ['primary', 'fallback'] }, { status: 'ok', output: {} }))
      .toThrow(/not-declared/);
  });

  it('throws on an unregistered predicate name', () => {
    expect(() => runBranch({ predicate: 'test/nope', edges: ['a'] }, { status: 'ok', output: {} })).toThrow(/Unknown branch predicate/);
  });

  it('treats an inherited Object.prototype key as unregistered rather than resolving it', () => {
    expect(() => runBranch({ predicate: 'constructor', edges: ['a'] }, { status: 'ok', output: {} })).toThrow(/Unknown branch predicate "constructor"/);
  });
});

describe('core/field-equals', () => {
  const config = { predicate: 'core/field-equals', edges: ['yes', 'no'], args: { field: 'docId', value: 'someimportantdoc' } };

  it("routes to 'yes' when the named output field equals the configured value", () => {
    const edge = runBranch(config, { status: 'ok', output: { docId: 'someimportantdoc' } });
    expect(edge).toBe('yes');
  });

  it("routes to 'no' when the named output field does not equal the configured value", () => {
    const edge = runBranch(config, { status: 'ok', output: { docId: 'some-other-doc' } });
    expect(edge).toBe('no');
  });

  it("routes to 'no' when the named field is absent from the output", () => {
    const edge = runBranch(config, { status: 'ok', output: {} });
    expect(edge).toBe('no');
  });

  it("routes to 'no' for a non-ok envelope — there is no output to compare", () => {
    const edge = runBranch(config, { status: 'failed', error: 'boom' });
    expect(edge).toBe('no');
  });

  it('compares values as strings, so a number field matches a string-configured value', () => {
    const edge = runBranch(
      { predicate: 'core/field-equals', edges: ['yes', 'no'], args: { field: 'count', value: '3' } },
      { status: 'ok', output: { count: 3 } },
    );
    expect(edge).toBe('yes');
  });
});
