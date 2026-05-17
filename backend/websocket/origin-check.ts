/**
 * WebSocket Origin allowlist check.
 *
 * Browsers automatically send `Origin` on the WebSocket upgrade request and
 * auto-attach session cookies regardless of the document origin. Without an
 * Origin check, a hostile page loaded in another tab can open a WS to a
 * cookie-authenticated user's DarkRide and act as them (CSWSH — cross-site
 * WebSocket hijacking). Same threat shape as classic CSRF but the CSRF
 * middleware doesn't cover the WS path.
 *
 * The strategy here is allowlist-based: a connection passes if its Origin
 * matches one of the configured entries, OR if the Origin header is absent
 * entirely. The absence carve-out exists because:
 *
 *   - Browsers always set Origin on WS upgrades; absence means a non-browser
 *     caller (curl, node-ws, Python websocket-client, etc.).
 *   - Non-browser callers don't auto-attach cookies — they can't be tricked
 *     by CSWSH because there's no ambient credential to steal.
 *
 * Operators who want to disable the check (e.g. behind a corporate proxy
 * that strips Origin) can pass an empty allowlist; the function then accepts
 * everything.
 */

export function verifyOrigin(origin: string | undefined | null, allowedOrigins: string[]): boolean {
  // Empty allowlist = origin check disabled (explicit operator opt-out).
  if (allowedOrigins.length === 0) return true;

  // No Origin header = non-browser caller (see preamble).
  if (!origin) return true;

  // Normalise + parse. Case-insensitive on scheme/host (per RFC 6454),
  // strict on port. Malformed origins fail closed.
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const normalised = `${parsed.protocol}//${parsed.host}`.toLowerCase();
  const allowList = allowedOrigins.map(o => o.toLowerCase());
  return allowList.includes(normalised);
}

/**
 * Build the default allowlist from the bind host + port. Covers:
 *   - same-origin in production (browser visiting the bound host directly)
 *   - dev mode (Vite dev server proxies /ws — Origin passes through as the
 *     dev origin, typically localhost:5173)
 *   - the loopback alias of the bound host
 *
 * `0.0.0.0` and `::` aren't valid browser origins, so they're expanded into
 * `localhost` and `127.0.0.1`. Custom hostnames are used verbatim.
 */
export function buildDefaultAllowedOrigins(host: string, port: number): string[] {
  const hosts = (host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === 'localhost')
    ? ['localhost', '127.0.0.1']
    : [host];

  const ports = [String(port), '5173']; // backend + standard Vite dev port

  const origins: string[] = [];
  for (const h of hosts) {
    for (const p of ports) {
      origins.push(`http://${h}:${p}`);
      origins.push(`https://${h}:${p}`);
    }
  }
  return origins;
}

/**
 * Parse the `WEBSOCKET_ALLOWED_ORIGINS` env var (comma-separated) into an
 * array. Empty/missing returns []. Trims whitespace; ignores empty entries.
 */
export function parseAllowedOriginsEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
