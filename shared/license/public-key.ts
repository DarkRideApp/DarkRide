/**
 * Public ed25519 key used to verify DarkRide Pro licenses.
 *
 * The matching private key lives only in Cloudflare Worker secrets
 * (LICENSE_SIGNING_KEY) for the darkride-licenses Worker. Public keys are
 * not sensitive — committing this is safe.
 *
 * Embedded: production keypair (live since v1 launch, 2026-05-05).
 * Test licenses issued during smoke testing no longer verify against this
 * key — that's fine because no real customers had them.
 */
export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAAQCbNyUcPI8iG0ZUB7mEAJFXtOFDdiRRK2uymQrsqxs=
-----END PUBLIC KEY-----
`;

/**
 * Issuer string the JWS payload must declare. Matches the LICENSE_ISSUER
 * env var in the darkride-licenses Worker (env=production).
 */
export const LICENSE_ISSUER = 'https://licenses.darkride.app';
