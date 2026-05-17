/**
 * Validates an Android package name. Package names contain only
 * letters, digits, underscores, and dots. Must start with a letter.
 */
export function isValidPackageName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_.]*$/.test(name);
}

/**
 * Validates a NordVPN country code. 2-12 lowercase letters only.
 * Accommodates both 2-letter ISO codes (e.g. "us") and full country names (e.g. "netherlands").
 */
export function isValidCountryCode(code: string): boolean {
  return /^[a-z]{2,12}$/.test(code);
}

/**
 * Returns true if the given IP address is private/internal (RFC-1918, loopback,
 * link-local, or IPv6 ULA/loopback). Used for SSRF protection.
 */
export function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip === '0.0.0.0') return true;
  if (ip === '::1') return true;
  if (ip.startsWith('fe80:')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}
