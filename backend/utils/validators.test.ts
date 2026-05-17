import { describe, it, expect } from 'vitest';
import { isValidPackageName, isValidCountryCode, isPrivateIp } from './validators';

describe('isValidPackageName', () => {
  it('accepts valid package names', () => {
    expect(isValidPackageName('com.example.app')).toBe(true);
    expect(isValidPackageName('com.android.vending')).toBe(true);
    expect(isValidPackageName('org.mozilla.firefox')).toBe(true);
    expect(isValidPackageName('A')).toBe(true); // single letter is fine
  });
  it('rejects injection attempts', () => {
    expect(isValidPackageName('foo; rm -rf /')).toBe(false);
    expect(isValidPackageName('foo`id`')).toBe(false);
    expect(isValidPackageName('foo$(whoami)')).toBe(false);
    expect(isValidPackageName('')).toBe(false);
    expect(isValidPackageName('123abc')).toBe(false); // must start with letter
    expect(isValidPackageName('foo bar')).toBe(false); // space not allowed
    expect(isValidPackageName("foo'bar")).toBe(false); // quote not allowed
  });
});

describe('isValidCountryCode', () => {
  it('accepts valid country codes', () => {
    expect(isValidCountryCode('us')).toBe(true);
    expect(isValidCountryCode('gb')).toBe(true);
    expect(isValidCountryCode('netherlands')).toBe(true); // NordVPN uses full names sometimes
  });
  it('rejects injection attempts', () => {
    expect(isValidCountryCode('us.evil.com')).toBe(false);
    expect(isValidCountryCode('')).toBe(false);
    expect(isValidCountryCode('US')).toBe(false); // uppercase not allowed
    expect(isValidCountryCode('a')).toBe(false); // too short
    expect(isValidCountryCode('x'.repeat(13))).toBe(false); // too long
  });
});

describe('isPrivateIp', () => {
  it('blocks RFC-1918 addresses', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });
  it('blocks loopback', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.0.0.2')).toBe(true);
  });
  it('blocks link-local', () => {
    expect(isPrivateIp('169.254.1.1')).toBe(true);
  });
  it('allows public IPs', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
  });
  it('blocks 172.16-31 but allows 172.15 and 172.32+', () => {
    expect(isPrivateIp('172.15.0.1')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
  });
  it('blocks IPv6 loopback and link-local', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
  });
  it('blocks IPv6 ULA', () => {
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12::1')).toBe(true);
  });
  it('blocks zero address', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });
});
