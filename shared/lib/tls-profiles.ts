// ---------------------------------------------------------------------------
// TLS client profiles — cipher-list parity with python/mitmproxy_bridge.py
//
// A capture session can pose its upstream TLS as Chrome 120 (Android) or
// OkHttp by swapping mitmproxy's cipher list / curves / sigalgs / ALPN (see
// _build_ssl_context in python/mitmproxy_bridge.py). When a request is
// *replayed* server-side (backend/services/proxied-request-service.ts) we want
// it to egress with the SAME profile, otherwise the replay's JA3 differs from
// what the app actually sent and anti-bot systems treat it differently.
//
// This module is the single source of truth for the profile strings on the TS
// side. shared/lib/tls-profiles.test.ts reads the Python source and asserts the
// two stay byte-identical, so the two implementations can't silently drift.
//
// IMPORTANT — this is cipher-list parity, NOT byte-exact JA3. Node/OpenSSL does
// not let us control TLS extension ordering or GREASE values, and Node exposes
// no per-request TLS 1.3 ciphersuite option. This is the same limitation the
// capture session itself has (mitmproxy's spoof is also cipher-list-level), so
// the replay matches the fidelity capture achieves — no more, no less.
// ---------------------------------------------------------------------------

export type TlsProfileName = 'chrome' | 'okhttp' | 'default';

// Shared TLS 1.3 ciphersuites (same for chrome and okhttp).
export const TLS13_CIPHERS =
  'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';

// Chrome 120 Android TLS 1.2 cipher list (12 ciphers, includes legacy SHA-1).
export const CHROME_TLS12_CIPHERS =
  'ECDHE-ECDSA-AES128-GCM-SHA256:' +
  'ECDHE-RSA-AES128-GCM-SHA256:' +
  'ECDHE-ECDSA-AES256-GCM-SHA384:' +
  'ECDHE-RSA-AES256-GCM-SHA384:' +
  'ECDHE-ECDSA-CHACHA20-POLY1305:' +
  'ECDHE-RSA-CHACHA20-POLY1305:' +
  'ECDHE-RSA-AES128-SHA:' +
  'ECDHE-RSA-AES256-SHA:' +
  'AES128-GCM-SHA256:' +
  'AES256-GCM-SHA384:' +
  'AES128-SHA:' +
  'AES256-SHA';

// OkHttp 4.x ConnectionSpec.MODERN_TLS — TLS 1.2 ciphers (6, modern-only, no SHA-1).
export const OKHTTP_TLS12_CIPHERS =
  'ECDHE-ECDSA-AES128-GCM-SHA256:' +
  'ECDHE-RSA-AES128-GCM-SHA256:' +
  'ECDHE-ECDSA-AES256-GCM-SHA384:' +
  'ECDHE-RSA-AES256-GCM-SHA384:' +
  'ECDHE-ECDSA-CHACHA20-POLY1305:' +
  'ECDHE-RSA-CHACHA20-POLY1305';

// Elliptic-curve groups (Node `ecdhCurve`) — shared across profiles.
export const SHARED_GROUPS = 'x25519:P-256:P-384';

// Signature algorithms (Node `sigalgs`) — shared across profiles.
export const SHARED_SIGALGS =
  'ECDSA+SHA256:RSA-PSS+SHA256:RSA+SHA256:' +
  'ECDSA+SHA384:RSA-PSS+SHA384:RSA+SHA384:' +
  'RSA-PSS+SHA512:RSA+SHA512';

// ALPN — h2, http/1.1 (Node `ALPNProtocols`).
export const SHARED_ALPN = ['h2', 'http/1.1'];

export interface TlsProfile {
  name: 'chrome' | 'okhttp';
  /** TLS 1.2 (and below) cipher list — OpenSSL cipher-string form. */
  tls12Ciphers: string;
  /** TLS 1.3 ciphersuites — documented for parity; Node has no per-request setter. */
  tls13Ciphers: string;
  /** Curve groups → Node `ecdhCurve`. */
  groups: string;
  /** Signature algorithms → Node `sigalgs`. */
  sigalgs: string;
  /** ALPN protocols → Node `ALPNProtocols`. */
  alpn: string[];
}

export const TLS_PROFILES: Record<'chrome' | 'okhttp', TlsProfile> = {
  chrome: {
    name: 'chrome',
    tls12Ciphers: CHROME_TLS12_CIPHERS,
    tls13Ciphers: TLS13_CIPHERS,
    groups: SHARED_GROUPS,
    sigalgs: SHARED_SIGALGS,
    alpn: SHARED_ALPN,
  },
  okhttp: {
    name: 'okhttp',
    tls12Ciphers: OKHTTP_TLS12_CIPHERS,
    tls13Ciphers: TLS13_CIPHERS,
    groups: SHARED_GROUPS,
    sigalgs: SHARED_SIGALGS,
    alpn: SHARED_ALPN,
  },
};

/**
 * Resolve a profile name to its definition. Returns null for the sentinel
 * 'default' (no spoofing), for nullish input, and for any unknown name — the
 * caller treats null as "use Node's stock TLS".
 */
export function getTlsProfile(name?: string | null): TlsProfile | null {
  if (!name || name === 'default') return null;
  return TLS_PROFILES[name as 'chrome' | 'okhttp'] ?? null;
}

export interface TlsProfileNodeOptions {
  ciphers: string;
  ecdhCurve: string;
  sigalgs: string;
  ALPNProtocols: string[];
}

/**
 * Map a profile onto the subset of Node `https.request` / `tls.connect`
 * options we can actually control. TLS 1.3 ciphersuites are intentionally
 * omitted — Node exposes no per-request option for them (see module header).
 */
export function tlsProfileToNodeOptions(profile: TlsProfile): TlsProfileNodeOptions {
  return {
    ciphers: profile.tls12Ciphers,
    ecdhCurve: profile.groups,
    sigalgs: profile.sigalgs,
    ALPNProtocols: profile.alpn,
  };
}
