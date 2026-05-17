import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createPublicKey, verify } from 'crypto';
import { execSync } from 'child_process';

describe('darkride plugin sign', () => {
  const tempDir = join(tmpdir(), 'darkride-sign-test-' + Date.now());

  it('generates a valid Ed25519 keypair', () => {
    mkdirSync(tempDir, { recursive: true });
    execSync(`npx tsx bin/darkride.ts plugin sign --generate-key --output ${tempDir}`, {
      cwd: process.cwd(),
      timeout: 15000,
    });

    const privatePem = readFileSync(join(tempDir, 'signing-key.pem'), 'utf-8');
    const publicPem = readFileSync(join(tempDir, 'signing-key.pub'), 'utf-8');
    expect(privatePem).toContain('PRIVATE KEY');
    expect(publicPem).toContain('PUBLIC KEY');
  });

  it('signs all plugins in a registry file', () => {
    // Create a test registry
    const registryPath = join(tempDir, 'test-registry.json');
    writeFileSync(registryPath, JSON.stringify({
      plugins: [{
        name: 'test-plugin',
        displayName: 'Test Plugin',
        description: 'A test',
        author: 'Test',
        repo: 'test/test',
        latestVersion: '1.0.0',
        category: 'test',
        license: 'MIT',
        npmPackage: '@test/plugin-test',
      }],
    }));

    // Sign it
    const keyPath = join(tempDir, 'signing-key.pem');
    execSync(
      `npx tsx bin/darkride.ts plugin sign ${registryPath} --key ${keyPath} --key-id test-key`,
      { cwd: process.cwd(), timeout: 15000 },
    );

    // Verify the signature was added
    const signed = JSON.parse(readFileSync(registryPath, 'utf-8'));
    const plugin = signed.plugins[0];
    expect(plugin.signature).toBeDefined();
    expect(plugin.signedBy).toBe('test-key');

    // Verify the signature is cryptographically valid
    const { signature, signedBy, ...rest } = plugin;
    const canonical = JSON.stringify(rest, Object.keys(rest).sort());
    const pubPem = readFileSync(join(tempDir, 'signing-key.pub'), 'utf-8');
    const publicKey = createPublicKey(pubPem);
    const isValid = verify(null, Buffer.from(canonical), publicKey, Buffer.from(signature, 'base64'));
    expect(isValid).toBe(true);
  });

  it('signs npmShasum + gitRef when present (content pin in canonical form)', () => {
    const registryPath = join(tempDir, 'pinned-registry.json');
    writeFileSync(registryPath, JSON.stringify({
      plugins: [{
        name: 'pinned-plugin',
        displayName: 'Pinned Plugin',
        description: 'Has a content pin',
        author: 'Test',
        repo: 'test/test',
        latestVersion: '1.0.0',
        category: 'test',
        license: 'MIT',
        npmPackage: '@test/plugin-pinned',
        npmShasum: 'sha512-abc123def456',
        gitRef: 'deadbeef1234567890',
      }],
    }));

    const keyPath = join(tempDir, 'signing-key.pem');
    execSync(
      `npx tsx bin/darkride.ts plugin sign ${registryPath} --key ${keyPath} --key-id test-key`,
      { cwd: process.cwd(), timeout: 15000 },
    );

    const signed = JSON.parse(readFileSync(registryPath, 'utf-8'));
    const plugin = signed.plugins[0];
    const { signature, signedBy, ...rest } = plugin;
    // The canonical form must include both new pin fields.
    expect(rest.npmShasum).toBe('sha512-abc123def456');
    expect(rest.gitRef).toBe('deadbeef1234567890');
    const canonical = JSON.stringify(rest, Object.keys(rest).sort());
    expect(canonical).toContain('npmShasum');
    expect(canonical).toContain('gitRef');

    // And the signature must still verify against the canonical form.
    const pubPem = readFileSync(join(tempDir, 'signing-key.pub'), 'utf-8');
    const publicKey = createPublicKey(pubPem);
    const isValid = verify(null, Buffer.from(canonical), publicKey, Buffer.from(signature, 'base64'));
    expect(isValid).toBe(true);
  });

  // Cleanup
  it('cleanup', () => {
    try { rmSync(tempDir, { recursive: true }); } catch {}
  });
});
