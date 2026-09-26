import { describe, it, expect } from 'vitest';
import { parseScopeParam, scopeToParam, scopeToTrafficParams } from './NetworkScopeContext';

describe('network scope helpers', () => {
  it('parses device and session params', () => {
    expect(parseScopeParam('device:abc')).toEqual({ kind: 'device', deviceId: 'abc' });
    expect(parseScopeParam('device:')).toEqual({ kind: 'device', deviceId: '' });
    expect(parseScopeParam('session:5')).toEqual({ kind: 'session', sessionId: 5 });
  });

  it('defaults to all for null / "all" / garbage', () => {
    expect(parseScopeParam(null)).toEqual({ kind: 'all' });
    expect(parseScopeParam('all')).toEqual({ kind: 'all' });
    expect(parseScopeParam('session:notanumber')).toEqual({ kind: 'all' });
    expect(parseScopeParam('nonsense')).toEqual({ kind: 'all' });
  });

  it('round-trips scope to param', () => {
    expect(scopeToParam({ kind: 'all' })).toBeUndefined();
    expect(scopeToParam({ kind: 'device', deviceId: 'abc' })).toBe('device:abc');
    expect(scopeToParam({ kind: 'session', sessionId: 5 })).toBe('session:5');
  });

  it('derives traffic query params from scope', () => {
    expect(scopeToTrafficParams({ kind: 'all' })).toEqual({});
    expect(scopeToTrafficParams({ kind: 'device', deviceId: 'abc' })).toEqual({ deviceId: 'abc' });
    expect(scopeToTrafficParams({ kind: 'session', sessionId: 5 })).toEqual({ sessionId: 5 });
  });
});
