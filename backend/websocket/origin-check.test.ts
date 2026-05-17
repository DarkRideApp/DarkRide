import { describe, it, expect } from 'vitest';
import { verifyOrigin, buildDefaultAllowedOrigins } from './origin-check';

describe('verifyOrigin', () => {
  const allow = ['http://localhost:3000', 'http://localhost:5173'];

  it('accepts an allow-listed origin', () => {
    expect(verifyOrigin('http://localhost:3000', allow)).toBe(true);
    expect(verifyOrigin('http://localhost:5173', allow)).toBe(true);
  });

  it('rejects a non-allow-listed origin', () => {
    expect(verifyOrigin('http://evil.example', allow)).toBe(false);
    expect(verifyOrigin('https://localhost:3000', allow)).toBe(false); // scheme mismatch
    expect(verifyOrigin('http://localhost:4000', allow)).toBe(false);  // port mismatch
  });

  it('accepts an absent Origin header (non-browser caller)', () => {
    // Browsers always send Origin on WS upgrades; absence means curl/node-ws/
    // hostile non-browser caller, which can't be tricked into CSWSH because
    // there's no cookie auto-attach in that context.
    expect(verifyOrigin(undefined, allow)).toBe(true);
    expect(verifyOrigin('', allow)).toBe(true);
  });

  it('accepts when the allowlist is empty (origin check disabled)', () => {
    // Operator opt-out: explicitly allow everything by passing []. Useful for
    // ad-hoc lan setups where you want any browser on the LAN to connect.
    expect(verifyOrigin('http://anywhere.com', [])).toBe(true);
  });

  it('is case-insensitive in scheme + host but exact in port', () => {
    expect(verifyOrigin('HTTP://LOCALHOST:3000', allow)).toBe(true);
    expect(verifyOrigin('http://localhost:3001', allow)).toBe(false);
  });

  it('rejects malformed Origin headers without throwing', () => {
    expect(verifyOrigin('not a url', allow)).toBe(false);
    expect(verifyOrigin('ftp://localhost:3000', allow)).toBe(false);
  });
});

describe('buildDefaultAllowedOrigins', () => {
  it('includes backend host + port (http and https) and 127.0.0.1 mirror', () => {
    const origins = buildDefaultAllowedOrigins('127.0.0.1', 3000);
    expect(origins).toContain('http://127.0.0.1:3000');
    expect(origins).toContain('http://localhost:3000');
    expect(origins).toContain('http://localhost:5173');
    expect(origins).toContain('http://127.0.0.1:5173');
  });

  it('expands 0.0.0.0 to both localhost and 127.0.0.1 (bound-everywhere case)', () => {
    const origins = buildDefaultAllowedOrigins('0.0.0.0', 3000);
    expect(origins).toContain('http://localhost:3000');
    expect(origins).toContain('http://127.0.0.1:3000');
    // does NOT add a wildcard or 0.0.0.0 origin — those aren't valid browser origins
    expect(origins).not.toContain('http://0.0.0.0:3000');
  });

  it('uses the configured host verbatim when not 0.0.0.0 / localhost', () => {
    const origins = buildDefaultAllowedOrigins('darkride.lan', 3000);
    expect(origins).toContain('http://darkride.lan:3000');
    expect(origins).toContain('https://darkride.lan:3000');
  });
});
