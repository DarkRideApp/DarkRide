import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerFilteredChannel,
  isFilteredChannel,
  getRequiredScopes,
  __resetChannelRegistryForTest,
} from './channel-registry';

describe('channel-registry', () => {
  beforeEach(() => { __resetChannelRegistryForTest(); });

  it('isFilteredChannel returns false for an unregistered channel', () => {
    expect(isFilteredChannel('unknown:channel')).toBe(false);
  });

  it('isFilteredChannel returns true after registration', () => {
    registerFilteredChannel('demo-plugin:change');
    expect(isFilteredChannel('demo-plugin:change')).toBe(true);
  });

  it('getRequiredScopes returns an empty array for a channel with no scope requirement', () => {
    registerFilteredChannel('demo-plugin:change');
    expect(getRequiredScopes('demo-plugin:change')).toEqual([]);
  });

  it('getRequiredScopes returns the registered scope list', () => {
    registerFilteredChannel('admin:event', { requires: ['admin:read'] });
    expect(getRequiredScopes('admin:event')).toEqual(['admin:read']);
  });

  it('getRequiredScopes returns an empty array for an unregistered channel', () => {
    expect(getRequiredScopes('unknown:channel')).toEqual([]);
  });

  it('registering the same channel twice replaces the prior registration', () => {
    registerFilteredChannel('foo', { requires: ['scope:a'] });
    registerFilteredChannel('foo', { requires: ['scope:b'] });
    expect(getRequiredScopes('foo')).toEqual(['scope:b']);
  });

  it('different channels with different scope requirements coexist', () => {
    registerFilteredChannel('a:event', { requires: ['a:read'] });
    registerFilteredChannel('b:event', { requires: ['b:read'] });
    expect(getRequiredScopes('a:event')).toEqual(['a:read']);
    expect(getRequiredScopes('b:event')).toEqual(['b:read']);
    expect(isFilteredChannel('a:event')).toBe(true);
    expect(isFilteredChannel('b:event')).toBe(true);
  });
});
