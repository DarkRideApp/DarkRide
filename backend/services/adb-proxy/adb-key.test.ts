import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdbKeyError, KEY_BLOB_SIZE, fingerprintOf, keyIdOf, parseAdbPublicKey, sanitiseComment, verifyAuthSignature,
} from './adb-key';
import { makeTestAdbKey } from './testing/test-keys';

const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__/adb-key-fixture.json'), 'utf8'));
const fixtureB64 = fixture.publicKeyText.split(/\s+/)[0] as string;

describe('parseAdbPublicKey with a key from the real adb', () => {
  it('parses the blob, comment, key id and fingerprint', () => {
    const parsed = parseAdbPublicKey(fixture.publicKeyText);
    expect(parsed.blob.length).toBe(KEY_BLOB_SIZE);
    expect(parsed.keyId).toBe(fixture.keyId);
    expect(parsed.fingerprint).toBe(fixture.fingerprint);
    expect(parsed.comment).toBe(fixture.publicKeyText.slice(fixtureB64.length + 1));
    expect(parsed.publicKey).toBe(fixtureB64);
  });

  it('accepts a Buffer with a trailing NUL, as sent on the wire', () => {
    const parsed = parseAdbPublicKey(Buffer.from(fixture.publicKeyText + '\0'));
    expect(parsed.keyId).toBe(fixture.keyId);
  });
});

describe('verifyAuthSignature', () => {
  const parsed = parseAdbPublicKey(fixture.publicKeyText);
  const token = Buffer.from(fixture.tokenHex, 'hex');
  const signature = Buffer.from(fixture.signatureHex, 'hex');

  it('accepts a signature made by the real key over the token', () => {
    expect(verifyAuthSignature(parsed.key, token, signature)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const bad = Buffer.from(signature);
    bad[10] ^= 0x01;
    expect(verifyAuthSignature(parsed.key, token, bad)).toBe(false);
  });

  it('rejects the signature for a different token', () => {
    expect(verifyAuthSignature(parsed.key, randomBytes(20), signature)).toBe(false);
  });

  it('rejects a wrong-length signature and a wrong-length token', () => {
    expect(verifyAuthSignature(parsed.key, token, signature.subarray(0, 255))).toBe(false);
    expect(verifyAuthSignature(parsed.key, token.subarray(0, 19), signature)).toBe(false);
  });

  it('rejects a signature made by a different key', () => {
    const other = makeTestAdbKey();
    expect(verifyAuthSignature(parsed.key, token, other.sign(token))).toBe(false);
  });
});

describe('round trip with the generated test key', () => {
  it('parses what the test helper produces and verifies its signatures', () => {
    const k = makeTestAdbKey('ci@runner');
    const parsed = parseAdbPublicKey(k.publicKeyText);
    expect(parsed.keyId).toBe(k.keyId);
    expect(parsed.comment).toBe('ci@runner');
    const token = randomBytes(20);
    expect(verifyAuthSignature(parsed.key, token, k.sign(token))).toBe(true);
  });
});

describe('parseAdbPublicKey rejects malformed input', () => {
  const good = Buffer.from(fixtureB64, 'base64');
  const asText = (blob: Buffer) => `${blob.toString('base64')} x@y`;

  it('rejects empty, oversize and non-base64 text', () => {
    expect(() => parseAdbPublicKey('')).toThrow(AdbKeyError);
    expect(() => parseAdbPublicKey('A'.repeat(3000))).toThrow(AdbKeyError);
    expect(() => parseAdbPublicKey('not base64 !!!')).toThrow(AdbKeyError);
  });

  it('rejects a blob of the wrong size', () => {
    expect(() => parseAdbPublicKey(asText(good.subarray(0, 100)))).toThrow(AdbKeyError);
  });

  it('rejects a wrong word count', () => {
    const bad = Buffer.from(good);
    bad.writeUInt32LE(32, 0);
    expect(() => parseAdbPublicKey(asText(bad))).toThrow(AdbKeyError);
  });

  it('rejects an exponent other than 65537', () => {
    const bad = Buffer.from(good);
    bad.writeUInt32LE(3, 520);
    expect(() => parseAdbPublicKey(asText(bad))).toThrow(AdbKeyError);
  });

  it('rejects an even modulus and a modulus without the top bit set', () => {
    const even = Buffer.from(good);
    even[8] &= 0xfe;
    expect(() => parseAdbPublicKey(asText(even))).toThrow(AdbKeyError);
    const small = Buffer.from(good);
    small[8 + 255] &= 0x7f;
    expect(() => parseAdbPublicKey(asText(small))).toThrow(AdbKeyError);
  });
});

describe('comment handling', () => {
  it('strips control characters and caps the length at 128', () => {
    const cleaned = sanitiseComment('a\u0000b\nc\u0007d' + 'x'.repeat(200));
    expect(cleaned).toMatch(/^abcd/);
    expect(cleaned.length).toBe(128);
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(cleaned)).toBe(false);
  });

  it('keeps markup as plain text for the UI to escape', () => {
    expect(sanitiseComment('<img src=x onerror=alert(1)>@host')).toBe('<img src=x onerror=alert(1)>@host');
  });

  it('applies the same cleaning when parsing a key whose comment contains a newline', () => {
    const parsed = parseAdbPublicKey(`${fixtureB64} evil\nname`);
    expect(parsed.comment).toBe('evilname');
  });
});

describe('identity helpers', () => {
  it('formats the fingerprint as 16 uppercase hex pairs separated by colons', () => {
    expect(fingerprintOf(Buffer.alloc(524, 1))).toMatch(/^([0-9A-F]{2}:){15}[0-9A-F]{2}$/);
  });

  it('derives a stable 64-character key id', () => {
    expect(keyIdOf(Buffer.alloc(524, 1))).toMatch(/^[0-9a-f]{64}$/);
    expect(keyIdOf(Buffer.alloc(524, 1))).toBe(keyIdOf(Buffer.alloc(524, 1)));
    expect(keyIdOf(Buffer.alloc(524, 1))).not.toBe(keyIdOf(Buffer.alloc(524, 2)));
  });
});
