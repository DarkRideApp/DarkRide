import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  TLS13_CIPHERS,
  CHROME_TLS12_CIPHERS,
  OKHTTP_TLS12_CIPHERS,
  SHARED_GROUPS,
  SHARED_SIGALGS,
  SHARED_ALPN,
  TLS_PROFILES,
  getTlsProfile,
  tlsProfileToNodeOptions,
} from './tls-profiles';

// ---------------------------------------------------------------------------
// The TS constants are a hand-port of the Python cipher lists in
// python/mitmproxy_bridge.py. This suite reads that source and asserts the two
// stay byte-identical — so the server-side replay path poses the same cipher
// profile the capture session itself uses. Edit one side, this fails, and the
// other side is forced to move too.
// ---------------------------------------------------------------------------

/**
 * Extract a Python string constant from the mitmproxy bridge source. Handles
 * both single-line assignments and paren-wrapped multi-line implicit
 * concatenations, with an optional `b""` bytes prefix.
 */
function extractPyConst(source: string, name: string): string {
  const parenRe = new RegExp(`${name}\\s*=\\s*\\(([\\s\\S]*?)\\)`, 'm');
  const singleRe = new RegExp(`${name}\\s*=\\s*(b?"[^"]*")`, 'm');
  let body: string;
  const parenMatch = source.match(parenRe);
  if (parenMatch) {
    body = parenMatch[1];
  } else {
    const singleMatch = source.match(singleRe);
    if (!singleMatch) throw new Error(`Could not find Python constant ${name}`);
    body = singleMatch[1];
  }
  const segments = [...body.matchAll(/b?"([^"]*)"/g)].map((m) => m[1]);
  return segments.join('');
}

const PY_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'python', 'mitmproxy_bridge.py'),
  'utf-8',
);

describe('tls-profiles — parity with python/mitmproxy_bridge.py', () => {
  it('TLS 1.3 ciphersuites match the Python source', () => {
    expect(TLS13_CIPHERS).toBe(extractPyConst(PY_SOURCE, '_TLS13_CIPHERS'));
  });

  it('Chrome TLS 1.2 cipher list matches the Python source', () => {
    expect(CHROME_TLS12_CIPHERS).toBe(extractPyConst(PY_SOURCE, '_CHROME_TLS12_CIPHERS'));
  });

  it('OkHttp TLS 1.2 cipher list matches the Python source', () => {
    expect(OKHTTP_TLS12_CIPHERS).toBe(extractPyConst(PY_SOURCE, '_OKHTTP_TLS12_CIPHERS'));
  });

  it('shared curve groups match the Python source', () => {
    expect(SHARED_GROUPS).toBe(extractPyConst(PY_SOURCE, '_SHARED_GROUPS'));
  });

  it('shared signature algorithms match the Python source', () => {
    expect(SHARED_SIGALGS).toBe(extractPyConst(PY_SOURCE, '_SHARED_SIGALGS'));
  });
});

describe('tls-profiles — getTlsProfile', () => {
  it('returns null for undefined / null / "default"', () => {
    expect(getTlsProfile(undefined)).toBeNull();
    expect(getTlsProfile(null)).toBeNull();
    expect(getTlsProfile('default')).toBeNull();
  });

  it('returns null for an unknown profile name', () => {
    expect(getTlsProfile('safari')).toBeNull();
  });

  it('returns the chrome profile', () => {
    const p = getTlsProfile('chrome');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('chrome');
    expect(p!.tls12Ciphers).toBe(CHROME_TLS12_CIPHERS);
    expect(p!.tls13Ciphers).toBe(TLS13_CIPHERS);
    expect(p!.groups).toBe(SHARED_GROUPS);
    expect(p!.sigalgs).toBe(SHARED_SIGALGS);
    expect(p!.alpn).toEqual(SHARED_ALPN);
  });

  it('returns the okhttp profile with its narrower, modern-only cipher list', () => {
    const p = getTlsProfile('okhttp');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('okhttp');
    expect(p!.tls12Ciphers).toBe(OKHTTP_TLS12_CIPHERS);
    // OkHttp MODERN_TLS drops legacy SHA-1 CBC suites that Chrome keeps.
    expect(p!.tls12Ciphers).not.toContain('AES128-SHA');
  });
});

describe('tls-profiles — tlsProfileToNodeOptions', () => {
  it('maps a profile onto Node https/tls option names', () => {
    const opts = tlsProfileToNodeOptions(TLS_PROFILES.chrome);
    expect(opts.ciphers).toBe(CHROME_TLS12_CIPHERS);
    expect(opts.ecdhCurve).toBe(SHARED_GROUPS);
    expect(opts.sigalgs).toBe(SHARED_SIGALGS);
    expect(opts.ALPNProtocols).toEqual(SHARED_ALPN);
  });
});
