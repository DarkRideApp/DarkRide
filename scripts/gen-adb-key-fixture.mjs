#!/usr/bin/env node
// Regenerates backend/services/adb-proxy/__fixtures__/adb-key-fixture.json from a real adb key.
// Usage: ADB_BIN=/path/to/adb node scripts/gen-adb-key-fixture.mjs
// The private key is discarded; only the public key, a token and its signature are kept.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'backend/services/adb-proxy/__fixtures__/adb-key-fixture.json');
const adb = process.env.ADB_BIN || 'adb';
const dir = mkdtempSync(join(tmpdir(), 'adb-key-fixture-'));
try {
  execFileSync(adb, ['keygen', join(dir, 'adbkey')], { stdio: 'ignore' });
  const token = randomBytes(20);
  writeFileSync(join(dir, 'token.bin'), token);
  execFileSync('openssl', [
    'pkeyutl', '-sign', '-inkey', join(dir, 'adbkey'),
    '-pkeyopt', 'digest:sha1', '-in', join(dir, 'token.bin'), '-out', join(dir, 'sig.bin'),
  ]);
  // adb keygen appends the developer's user@host; the comment is outside the blob, so swap in a neutral one.
  const publicKeyText = `${readFileSync(join(dir, 'adbkey.pub'), 'utf8').trim().split(/\s+/)[0]} fixture@test`;
  const blob = Buffer.from(publicKeyText.split(/\s+/)[0], 'base64');
  const fingerprint = createHash('md5').update(blob).digest('hex').toUpperCase().match(/../g).join(':');
  const generatedWith = execFileSync(adb, ['version'], { encoding: 'utf8' }).split('\n')[1].trim();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    generatedWith,
    publicKeyText,
    tokenHex: token.toString('hex'),
    signatureHex: readFileSync(join(dir, 'sig.bin')).toString('hex'),
    keyId: createHash('sha256').update(blob).digest('hex'),
    fingerprint,
  }, null, 2) + '\n');
  console.log('wrote', out);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
