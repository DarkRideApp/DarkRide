/**
 * Build the URL that host-side helper processes (the mitmproxy bridge, Python
 * bridges) use to call back into the DarkRide server.
 *
 * Why not just "localhost": on Windows `localhost` resolves to `::1` before
 * `127.0.0.1`. The server binds a single address — `127.0.0.1` by default — so
 * an IPv6-first client connects to `[::1]:PORT`, finds nothing listening, and
 * only then falls back to IPv4. Measured on a real capture, that failover cost
 * ~2.1s on EVERY POST. The bridge makes two blocking intercept POSTs per flow
 * (request phase + response phase), so every single request through the proxy
 * paid ~4.3s. Using the bound address literally removes the ambiguity: measured
 * end-to-end on a physical device, 4.31s -> 0.28s time-to-first-byte, with
 * nothing else changed (mitmproxy's own upstream ttfb: 2151ms -> 134ms).
 *
 * Wildcard binds have no single literal address, so they resolve to loopback.
 *
 * A `HOST` that is some OTHER hostname is passed through unchanged: we can't
 * know which address family the operator meant, and silently rewriting their
 * chosen name would be worse than leaving it. Only `localhost` — where the
 * intent is unambiguous and the dual-stack hazard is real — is normalised.
 */
export function loopbackUrl(host: string, port: number | string, path = ''): string {
  const literal = toLiteralHost(host);
  // Bracket IPv6 literals for URL syntax (`http://[::1]:3000`).
  const authority = literal.includes(':') ? `[${literal}]` : literal;
  return `http://${authority}:${port}${path}`;
}

function toLiteralHost(host: string): string {
  const h = (host || '').trim();
  // Wildcard binds: reach the server over loopback rather than guessing an
  // external address.
  if (h === '' || h === '0.0.0.0') return '127.0.0.1';
  if (h === '::' || h === '[::]') return '::1';
  // "localhost" is the ambiguity this module exists to remove. Any other
  // hostname is the operator's explicit choice — see the note above.
  if (h.toLowerCase() === 'localhost') return '127.0.0.1';
  return h.replace(/^\[|\]$/g, '');
}
