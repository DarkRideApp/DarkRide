import { createHash, randomBytes } from 'crypto';

export function generateToken(prefix: string): string {
  return prefix + randomBytes(20).toString('hex');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function base64UrlEncode(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const hash = createHash('sha256').update(codeVerifier).digest();
  return base64UrlEncode(hash) === codeChallenge;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function matchesRedirectUri(registered: string[], provided: string): boolean {
  let providedUrl: URL;
  try { providedUrl = new URL(provided); } catch { return false; }

  for (const r of registered) {
    let regUrl: URL;
    try { regUrl = new URL(r); } catch { continue; }

    if (regUrl.protocol !== providedUrl.protocol) continue;
    if (regUrl.pathname !== providedUrl.pathname) continue;
    if (regUrl.hostname !== providedUrl.hostname) continue;

    // Loopback: any port is allowed as long as host + path + protocol match.
    if (isLoopbackHost(regUrl.hostname)) return true;

    // Non-loopback: port must also match
    if (regUrl.port === providedUrl.port) return true;
  }
  return false;
}

export function tokenPrefix(token: string): string {
  // Token format: "{typePrefix}_{randomHex}". The type prefix ends at the LAST
  // underscore (some prefixes like oauth_at_ contain their own underscore).
  // Return 12 chars of the random portion for display.
  const lastUnderscore = token.lastIndexOf('_');
  if (lastUnderscore < 0) return token.slice(0, 12);
  return token.slice(lastUnderscore + 1, lastUnderscore + 1 + 12);
}
