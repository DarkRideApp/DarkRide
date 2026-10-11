import { constants, createHash, createPublicKey, publicDecrypt, timingSafeEqual, type KeyObject } from 'node:crypto';

export const KEY_BLOB_SIZE = 524;
const MODULUS_BYTES = 256;
const MODULUS_WORDS = 64;
const EXPONENT_OFFSET = 8 + 2 * MODULUS_BYTES;
const RSA_EXPONENT = 65537;
const MAX_COMMENT = 128;
const MAX_KEY_TEXT = 2048;
// ASN.1 DigestInfo header for SHA-1; adb signs the raw 20-byte token as if it were the digest.
const SHA1_DIGEST_INFO_PREFIX = Buffer.from('3021300906052b0e03021a05000414', 'hex');

export class AdbKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdbKeyError';
  }
}

export interface ParsedAdbKey {
  blob: Buffer;
  /** Canonical base64 of `blob`. */
  publicKey: string;
  comment: string;
  keyId: string;
  fingerprint: string;
  key: KeyObject;
}

/** The comment is attacker text shown on an approval screen: strip controls, line separators and format characters. */
export function sanitiseComment(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, '').trim();
  return Array.from(cleaned).slice(0, MAX_COMMENT).join('');
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  return BigInt('0x' + Buffer.from(bytes).reverse().toString('hex'));
}

function stripTrailingNuls(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0) end--;
  return text.slice(0, end);
}

export function keyIdOf(blob: Buffer): string {
  return createHash('sha256').update(blob).digest('hex');
}

export function fingerprintOf(blob: Buffer): string {
  return (createHash('md5').update(blob).digest('hex').toUpperCase().match(/../g) as string[]).join(':');
}

/** Parse the text adb sends in AUTH(RSAPUBLICKEY): base64 blob, optional `user@host`, optional NULs. */
export function parseAdbPublicKey(input: Buffer | string): ParsedAdbKey {
  // The raw length bounds the decoded length, so check it before doing any work on attacker bytes.
  if (input.length > MAX_KEY_TEXT) throw new AdbKeyError('oversize key');
  const text = stripTrailingNuls(typeof input === 'string' ? input : input.toString('utf8')).trim();
  if (text.length === 0) throw new AdbKeyError('empty key');
  const space = text.search(/\s/);
  const b64 = space === -1 ? text : text.slice(0, space);
  const comment = space === -1 ? '' : sanitiseComment(text.slice(space + 1));
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new AdbKeyError('key is not base64');
  const blob = Buffer.from(b64, 'base64');
  if (blob.length !== KEY_BLOB_SIZE) throw new AdbKeyError(`key blob is ${blob.length} bytes, expected ${KEY_BLOB_SIZE}`);
  if (blob.readUInt32LE(0) !== MODULUS_WORDS) throw new AdbKeyError('unsupported modulus size');
  if (blob.readUInt32LE(EXPONENT_OFFSET) !== RSA_EXPONENT) throw new AdbKeyError('unsupported exponent');
  const modulus = Buffer.from(blob.subarray(8, 8 + MODULUS_BYTES)).reverse();
  if ((modulus[0] & 0x80) === 0 || (modulus[modulus.length - 1] & 1) === 0) {
    throw new AdbKeyError('modulus is not an odd 2048-bit number');
  }
  // keyId hashes the whole blob, so n0inv and rr must be the values derived from the modulus or one key gets many ids.
  const n = BigInt('0x' + modulus.toString('hex'));
  const n0inv = Number((-modInverse(n & 0xffffffffn, 1n << 32n)) & 0xffffffffn) >>> 0;
  const rr = (1n << 4096n) % n;
  if (blob.readUInt32LE(4) !== n0inv || littleEndianToBigInt(blob.subarray(8 + MODULUS_BYTES, EXPONENT_OFFSET)) !== rr) {
    throw new AdbKeyError('key blob is not canonical');
  }
  const key = createPublicKey({
    key: { kty: 'RSA', n: modulus.toString('base64url'), e: Buffer.from([0x01, 0x00, 0x01]).toString('base64url') },
    format: 'jwk',
  });
  return { blob, publicKey: blob.toString('base64'), comment, keyId: keyIdOf(blob), fingerprint: fingerprintOf(blob), key };
}

/** adb signs the 20-byte token with RSA_sign(NID_sha1, ...): PKCS#1 v1.5 over a SHA-1 DigestInfo of the raw token. */
export function verifyAuthSignature(key: KeyObject, token: Buffer, signature: Buffer): boolean {
  if (token.length !== 20 || signature.length !== MODULUS_BYTES) return false;
  try {
    const decoded = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, signature);
    const expected = Buffer.concat([SHA1_DIGEST_INFO_PREFIX, token]);
    return decoded.length === expected.length && timingSafeEqual(decoded, expected);
  } catch {
    return false;
  }
}
