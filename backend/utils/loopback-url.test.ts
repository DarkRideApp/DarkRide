import { describe, it, expect } from 'vitest';
import { loopbackUrl } from './loopback-url';

describe('loopbackUrl', () => {
  it('uses the bound IPv4 address literally', () => {
    expect(loopbackUrl('127.0.0.1', 3000, '/v1/traffic/ingest')).toBe(
      'http://127.0.0.1:3000/v1/traffic/ingest',
    );
  });

  it('never emits "localhost"', () => {
    // Regression: `http://localhost:3000` made the Python bridge try ::1 first
    // against an IPv4-only listener. The failover cost ~2.1s per POST and the
    // bridge posts twice per flow — ~4.3s added to every proxied request.
    expect(loopbackUrl('localhost', 3000, '/x')).toBe('http://127.0.0.1:3000/x');
  });

  it('resolves an IPv4 wildcard bind to loopback', () => {
    expect(loopbackUrl('0.0.0.0', 3000, '/x')).toBe('http://127.0.0.1:3000/x');
  });

  it('resolves an IPv6 wildcard bind to bracketed IPv6 loopback', () => {
    expect(loopbackUrl('::', 3000, '/x')).toBe('http://[::1]:3000/x');
  });

  it('brackets an explicit IPv6 bind address', () => {
    expect(loopbackUrl('::1', 3000, '/x')).toBe('http://[::1]:3000/x');
    expect(loopbackUrl('[::1]', 3000, '/x')).toBe('http://[::1]:3000/x');
  });

  it('preserves a specific LAN bind address', () => {
    expect(loopbackUrl('192.168.1.160', 3000, '/x')).toBe('http://192.168.1.160:3000/x');
  });

  it('treats an empty host as loopback and allows an empty path', () => {
    expect(loopbackUrl('', 3000)).toBe('http://127.0.0.1:3000');
  });

  it('normalises a bracketed IPv6 wildcard and trims whitespace', () => {
    expect(loopbackUrl('[::]', 3000, '/x')).toBe('http://[::1]:3000/x');
    expect(loopbackUrl('  127.0.0.1  ', 3000, '/x')).toBe('http://127.0.0.1:3000/x');
  });

  it('normalises "localhost" case-insensitively', () => {
    expect(loopbackUrl('LOCALHOST', 3000, '/x')).toBe('http://127.0.0.1:3000/x');
  });

  it('passes any other hostname through unchanged', () => {
    // We can't know which address family the operator meant, so their explicit
    // choice wins — only "localhost" is normalised.
    expect(loopbackUrl('capture.internal', 3000, '/x')).toBe('http://capture.internal:3000/x');
  });

  it('accepts a string port', () => {
    expect(loopbackUrl('127.0.0.1', '3000', '/x')).toBe('http://127.0.0.1:3000/x');
  });
});

describe('webhook wiring', () => {
  it('the mitmproxy bridge webhook is built with loopbackUrl, not a hostname', async () => {
    // Guards the headline fix at the wiring level: the unit tests above all
    // stay green if index.ts reverts to a `http://localhost:${PORT}` template,
    // which is precisely the ~4.3s-per-request regression.
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/const webhookUrl = loopbackUrl\(/);
    expect(src).not.toMatch(/webhookUrl = `http:\/\/localhost:/);
  });
});
