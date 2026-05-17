import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'crypto';
import * as schema from '../db/schema';
import { PluginVerifier } from './plugin-verifier';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE trusted_signing_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      label TEXT NOT NULL,
      built_in INTEGER NOT NULL DEFAULT 0,
      added_by INTEGER,
      created_at INTEGER
    );
  `);
  return drizzle(sqlite, { schema });
}

// Generate test keypair
const { publicKey: pubPem, privateKey: privPem } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const pubDer = createPublicKey(pubPem).export({ type: 'spki', format: 'der' }).toString('base64');
const privKey = createPrivateKey(privPem);

// Generate a second keypair for multi-key tests
const { publicKey: pubPem2, privateKey: privPem2 } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const pubDer2 = createPublicKey(pubPem2).export({ type: 'spki', format: 'der' }).toString('base64');
const privKey2 = createPrivateKey(privPem2);

const SIGNED_FIELDS = [
  'name', 'displayName', 'description', 'author', 'repo',
  'latestVersion', 'category', 'license', 'npmPackage', 'minDarkrideVersion',
  'npmShasum', 'gitRef',
];

function canonicalize(plugin: any): string {
  const obj: Record<string, any> = {};
  for (const key of SIGNED_FIELDS) {
    if (key in plugin && plugin[key] !== undefined) obj[key] = plugin[key];
  }
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function signPlugin(plugin: any): string {
  return sign(null, Buffer.from(canonicalize(plugin)), privKey).toString('base64');
}

function signPluginWith(plugin: any, key: Parameters<typeof sign>[2]): string {
  return sign(null, Buffer.from(canonicalize(plugin)), key).toString('base64');
}

const basePlugin = {
  name: 'test-plugin',
  displayName: 'Test Plugin',
  description: 'A test plugin',
  author: 'tester',
  repo: 'https://github.com/tester/test-plugin',
  latestVersion: '1.0.0',
  category: 'utility',
  license: 'MIT',
  npmPackage: '@tester/test-plugin',
};

describe('PluginVerifier', () => {
  let db: ReturnType<typeof createTestDb>;
  let verifier: PluginVerifier;

  beforeEach(() => {
    db = createTestDb();
    verifier = new PluginVerifier(db);

    // Register the test key as trusted
    db.insert(schema.trustedSigningKeys).values({
      id: 'test-key',
      publicKey: pubDer,
      label: 'Test Key',
      builtIn: false,
      addedBy: null,
      createdAt: new Date(),
    }).run();
  });

  it('verify returns verified for a valid signature from trusted key', () => {
    const sig = signPlugin(basePlugin);
    const plugin = { ...basePlugin, signature: sig, signedBy: 'test-key' };
    const result = verifier.verify(plugin);
    expect(result.status).toBe('verified');
    expect(result.signedBy).toBe('test-key');
    expect(result.keyLabel).toBe('Test Key');
  });

  it('verify returns unsigned when no signature present', () => {
    const result = verifier.verify(basePlugin);
    expect(result.status).toBe('unsigned');
  });

  it('verify returns untrusted for signature from unknown key', () => {
    // Sign with key2 but only key1 is trusted
    const sig = signPluginWith(basePlugin, privKey2);
    const plugin = { ...basePlugin, signature: sig };
    const result = verifier.verify(plugin);
    expect(result.status).toBe('untrusted');
  });

  it('verify returns untrusted for invalid/corrupted signature', () => {
    const plugin = { ...basePlugin, signature: 'aW52YWxpZHNpZ25hdHVyZQ==' };
    const result = verifier.verify(plugin);
    expect(result.status).toBe('untrusted');
  });

  it('canonicalize produces deterministic JSON', () => {
    const pluginA = { name: 'foo', description: 'bar', author: 'baz', signature: 'abc', signedBy: 'key' };
    const pluginB = { author: 'baz', signature: 'xyz', name: 'foo', description: 'bar', signedBy: 'other' };
    expect(verifier.canonicalize(pluginA)).toBe(verifier.canonicalize(pluginB));
  });

  it('canonicalize ignores runtime fields (source, installUrl, verification)', () => {
    const base = { name: 'foo', description: 'bar', author: 'baz' };
    const withRuntime = { ...base, source: 'DarkRide Official', installUrl: 'git+https://...', verification: { status: 'verified' } };
    expect(verifier.canonicalize(base)).toBe(verifier.canonicalize(withRuntime));
  });

  it('verifies a signed plugin even after runtime fields are added', () => {
    const plugin = { ...basePlugin, signature: signPlugin(basePlugin), signedBy: 'test-key' };
    // Simulate what fetchRegistry + marketplace endpoint do: add source field
    const withSource = { ...plugin, source: 'DarkRide Official' };
    const result = verifier.verify(withSource);
    expect(result.status).toBe('verified');
  });

  it('works with multiple trusted keys', () => {
    // Add a second trusted key
    db.insert(schema.trustedSigningKeys).values({
      id: 'test-key-2',
      publicKey: pubDer2,
      label: 'Test Key 2',
      builtIn: false,
      addedBy: null,
      createdAt: new Date(),
    }).run();

    // Sign with key2
    const sig = signPluginWith(basePlugin, privKey2);
    const plugin = { ...basePlugin, signature: sig };
    const result = verifier.verify(plugin);
    expect(result.status).toBe('verified');
    expect(result.signedBy).toBe('test-key-2');
    expect(result.keyLabel).toBe('Test Key 2');
  });

  it('checkInstallPermission returns allow for verified plugin', () => {
    const sig = signPlugin(basePlugin);
    const plugin = { ...basePlugin, signature: sig };
    expect(verifier.checkInstallPermission(plugin, false)).toBe('allow');
    expect(verifier.checkInstallPermission(plugin, true)).toBe('allow');
  });

  it('checkInstallPermission returns prompt for unsigned non-auth plugin', () => {
    expect(verifier.checkInstallPermission(basePlugin, false)).toBe('prompt');
  });

  it('checkInstallPermission returns block for unsigned auth plugin', () => {
    expect(verifier.checkInstallPermission(basePlugin, true)).toBe('block');
  });

  it('checkInstallPermission returns block for untrusted auth plugin', () => {
    const sig = signPluginWith(basePlugin, privKey2);
    const plugin = { ...basePlugin, signature: sig };
    expect(verifier.checkInstallPermission(plugin, true)).toBe('block');
  });

  it('addTrustedKey adds a new key', () => {
    verifier.addTrustedKey('new-key', pubDer2, 'New Key', 1);
    const keys = verifier.getTrustedKeys();
    expect(keys.some(k => k.id === 'new-key')).toBe(true);
    const newKey = keys.find(k => k.id === 'new-key');
    expect(newKey?.label).toBe('New Key');
    expect(newKey?.publicKey).toBe(pubDer2);
  });

  it('removeTrustedKey removes a non-built-in key', () => {
    verifier.removeTrustedKey('test-key');
    const keys = verifier.getTrustedKeys();
    expect(keys.some(k => k.id === 'test-key')).toBe(false);
  });

  // ── npmShasum / gitRef content pin ─────────────────────────────────────────

  it('canonicalize includes npmShasum when present', () => {
    const withShasum = { ...basePlugin, npmShasum: 'sha512-abc123' };
    expect(verifier.canonicalize(withShasum)).not.toBe(verifier.canonicalize(basePlugin));
    expect(verifier.canonicalize(withShasum)).toContain('npmShasum');
  });

  it('canonicalize includes gitRef when present', () => {
    const withRef = { ...basePlugin, gitRef: 'deadbeefcafe1234' };
    expect(verifier.canonicalize(withRef)).not.toBe(verifier.canonicalize(basePlugin));
    expect(verifier.canonicalize(withRef)).toContain('gitRef');
  });

  it('signed plugin with npmShasum still verifies (signature covers the new field)', () => {
    const signed = { ...basePlugin, npmShasum: 'sha512-correct' };
    const sig = signPlugin(signed);
    const plugin = { ...signed, signature: sig, signedBy: 'test-key' };
    expect(verifier.verify(plugin).status).toBe('verified');
  });

  it('tampering with npmShasum after signing invalidates the signature', () => {
    const signed = { ...basePlugin, npmShasum: 'sha512-correct' };
    const sig = signPlugin(signed);
    const tampered = { ...signed, npmShasum: 'sha512-attacker', signature: sig, signedBy: 'test-key' };
    expect(verifier.verify(tampered).status).toBe('untrusted');
  });

  it('verifyContents ok+pinned when signed shasum matches installed', () => {
    const result = verifier.verifyContents(
      { npmShasum: 'sha512-abc' },
      { npmShasum: 'sha512-abc' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pinned).toBe(true);
  });

  it('verifyContents fails when signed shasum differs from installed', () => {
    const result = verifier.verifyContents(
      { npmShasum: 'sha512-signed' },
      { npmShasum: 'sha512-different' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/shasum|integrity|content/i);
  });

  it('verifyContents fails when signed shasum present but installed has none', () => {
    const result = verifier.verifyContents(
      { npmShasum: 'sha512-signed' },
      {},
    );
    expect(result.ok).toBe(false);
  });

  it('verifyContents ok+pinned when signed gitRef matches installed', () => {
    const result = verifier.verifyContents(
      { gitRef: 'deadbeef1234' },
      { gitRef: 'deadbeef1234' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pinned).toBe(true);
  });

  it('verifyContents fails when signed gitRef differs from installed', () => {
    const result = verifier.verifyContents(
      { gitRef: 'deadbeef1234' },
      { gitRef: 'cafe5678abcd' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/git.*ref|content/i);
  });

  it('verifyContents ok+unpinned when signed has no shasum/gitRef (backward compat)', () => {
    const result = verifier.verifyContents(
      {},
      { npmShasum: 'sha512-whatever', gitRef: 'whatever' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pinned).toBe(false);
  });

  it('removeTrustedKey throws for built-in key', () => {
    // Add a built-in key
    db.insert(schema.trustedSigningKeys).values({
      id: 'darkride-official',
      publicKey: pubDer,
      label: 'DarkRide Official',
      builtIn: true,
      addedBy: null,
      createdAt: new Date(),
    }).run();

    expect(() => verifier.removeTrustedKey('darkride-official')).toThrow('Cannot remove built-in key');
  });
});
