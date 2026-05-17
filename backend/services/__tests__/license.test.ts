import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { CompactSign, generateKeyPair, exportSPKI, exportPKCS8 } from 'jose';
import * as schema from '../../db/schema';

// Mutable state read by the mocked public-key module. Populated in beforeAll
// (jose generateKeyPair is async, so it can't run inside the vi.mock factory).
const publicKeyState = {
  LICENSE_PUBLIC_KEY: '',
  LICENSE_ISSUER: 'https://licenses-test.darkride.app',
};

// ES module exports are read-only via `import * as`, so monkey-patching the
// real module fails with "has only a getter". Mock the module instead and
// expose mutable getters so beforeEach can swap values per test.
vi.mock('../../../shared/license/public-key', () => ({
  get LICENSE_PUBLIC_KEY() { return publicKeyState.LICENSE_PUBLIC_KEY; },
  get LICENSE_ISSUER() { return publicKeyState.LICENSE_ISSUER; },
}));

import { LicenseService } from '../license';

let testPrivateKeyPem: string;
let testPublicKeyPem: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  testPrivateKeyPem = await exportPKCS8(privateKey);
  testPublicKeyPem = await exportSPKI(publicKey);
});

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

async function makeJws(payload: Record<string, any>, privateKeyPem: string): Promise<string> {
  const { importPKCS8 } = await import('jose');
  const key = await importPKCS8(privateKeyPem, 'EdDSA');
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .sign(key);
}

describe('LicenseService', () => {
  beforeEach(() => {
    // Override the mocked public key + issuer for the duration of the test
    publicKeyState.LICENSE_PUBLIC_KEY = testPublicKeyPem;
    publicKeyState.LICENSE_ISSUER = 'https://licenses-test.darkride.app';
  });

  it('isPro returns false when no license is set', () => {
    const db = makeDb();
    const svc = new LicenseService(db as any);
    expect(svc.isPro()).toBe(false);
    expect(svc.hasFeature('pro')).toBe(false);
  });

  it('setLicense rejects garbage input', async () => {
    const db = makeDb();
    const svc = new LicenseService(db as any);
    const result = await svc.setLicense('this-is-not-a-jws');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid|signature|format/i);
    }
  });

  it('setLicense rejects a license signed with the wrong key', async () => {
    const { privateKey: otherPrivate } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const otherPem = await exportPKCS8(otherPrivate);
    const jws = await makeJws({
      iss: 'https://licenses-test.darkride.app',
      sub: 'user@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      plan: 'pro',
      subscription_id: 'sub_x',
      license_id: 1,
    }, otherPem);

    const db = makeDb();
    const svc = new LicenseService(db as any);
    const result = await svc.setLicense(jws);
    expect(result.ok).toBe(false);
  });

  it('setLicense rejects an issuer mismatch', async () => {
    const jws = await makeJws({
      iss: 'https://attacker.example.com',
      sub: 'user@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      plan: 'pro',
      subscription_id: 'sub_x',
      license_id: 1,
    }, testPrivateKeyPem);

    const db = makeDb();
    const svc = new LicenseService(db as any);
    const result = await svc.setLicense(jws);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/issuer/i);
  });

  it('setLicense accepts a valid license + isPro returns true', async () => {
    const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
    const jws = await makeJws({
      iss: 'https://licenses-test.darkride.app',
      sub: 'cube@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp,
      plan: 'pro',
      subscription_id: 'sub_x',
      license_id: 1,
    }, testPrivateKeyPem);

    const db = makeDb();
    const svc = new LicenseService(db as any);
    const result = await svc.setLicense(jws);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.email).toBe('cube@example.com');
      expect(result.info.plan).toBe('pro');
      expect(Math.floor(result.info.expiresAt.getTime() / 1000)).toBe(exp);
    }
    expect(svc.isPro()).toBe(true);
    expect(svc.hasFeature('pro')).toBe(true);
  });

  it('isPro returns false for an expired license', async () => {
    const jws = await makeJws({
      iss: 'https://licenses-test.darkride.app',
      sub: 'cube@example.com',
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600, // expired one hour ago
      plan: 'pro',
      subscription_id: 'sub_x',
      license_id: 1,
    }, testPrivateKeyPem);

    const db = makeDb();
    const svc = new LicenseService(db as any);
    const result = await svc.setLicense(jws);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/i);
    expect(svc.isPro()).toBe(false);
  });

  it('getLicense returns the stored license info or null', async () => {
    const db = makeDb();
    const svc = new LicenseService(db as any);
    expect(await svc.getLicense()).toBeNull();

    const jws = await makeJws({
      iss: 'https://licenses-test.darkride.app',
      sub: 'cube@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      plan: 'pro',
      subscription_id: 'sub_x',
      license_id: 1,
    }, testPrivateKeyPem);
    await svc.setLicense(jws);

    const info = await svc.getLicense();
    expect(info).not.toBeNull();
    expect(info!.email).toBe('cube@example.com');
  });

  it('removeLicense clears the stored license', async () => {
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const jws = await makeJws({
      iss: 'https://licenses-test.darkride.app',
      sub: 'cube@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp,
      plan: 'pro',
      subscription_id: 'sub_x',
      license_id: 1,
    }, testPrivateKeyPem);

    const db = makeDb();
    const svc = new LicenseService(db as any);
    await svc.setLicense(jws);
    expect(svc.isPro()).toBe(true);

    await svc.removeLicense();
    expect(svc.isPro()).toBe(false);
    expect(await svc.getLicense()).toBeNull();
  });

  it('rehydrates state from DB on construction (returning user)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const jws = await makeJws({
      iss: 'https://licenses-test.darkride.app',
      sub: 'cube@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp,
      plan: 'pro',
      subscription_id: 'sub_x',
      license_id: 1,
    }, testPrivateKeyPem);

    const db = makeDb();
    const svc1 = new LicenseService(db as any);
    await svc1.setLicense(jws);

    // Simulate process restart by constructing a new service against the same db.
    const svc2 = new LicenseService(db as any);
    await svc2.init();
    expect(svc2.isPro()).toBe(true);
    expect((await svc2.getLicense())!.email).toBe('cube@example.com');
  });

  it('getLicense returns null and clears the cache once the cached license expires mid-process', async () => {
    // Use vi.useFakeTimers so we can advance past the expiry without sleeping.
    vi.useFakeTimers();
    const realNow = Date.now();
    vi.setSystemTime(realNow);

    const exp = Math.floor(realNow / 1000) + 60; // expires in 60 seconds
    const jws = await makeJws({
      iss: 'https://licenses-test.darkride.app',
      sub: 'cube@example.com',
      iat: Math.floor(realNow / 1000),
      exp,
      plan: 'pro',
      subscription_id: 'sub_x',
      license_id: 1,
    }, testPrivateKeyPem);

    const db = makeDb();
    const svc = new LicenseService(db as any);
    await svc.setLicense(jws);
    expect(await svc.getLicense()).not.toBeNull();
    expect(svc.isPro()).toBe(true);

    // Advance past expiry
    vi.setSystemTime(realNow + 120_000);

    expect(await svc.getLicense()).toBeNull();
    expect(svc.isPro()).toBe(false);

    vi.useRealTimers();
  });
});
