import { compactVerify, importSPKI } from 'jose';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';
import { settings } from '../db/schema';
import { LICENSE_PUBLIC_KEY, LICENSE_ISSUER } from '../../shared/license/public-key';
import { createLoggers } from '../logs';

const { log, error: logError } = createLoggers('license');

const SETTINGS_KEY = 'license.jws';
const ALG = 'EdDSA';

export interface LicenseInfo {
  email: string;
  plan: 'pro';
  expiresAt: Date;
  issuedAt: Date;
  subscriptionId: string;
  licenseId: number;
}

interface JwsPayload {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  plan: 'pro';
  subscription_id: string;
  license_id: number;
}

export type SetLicenseResult =
  | { ok: true; info: LicenseInfo }
  | { ok: false; reason: string };

/**
 * Verifies and stores DarkRide Pro license JWS strings.
 *
 * - Public key is embedded in the build (shared/license/public-key.ts).
 * - JWS is stored verbatim in the existing `settings` table under
 *   key 'license.jws'. The parsed payload is cached in memory for hot
 *   `isPro()` calls.
 * - All verification is local. No phone-home in v1.
 */
export class LicenseService {
  private cached: LicenseInfo | null = null;

  constructor(private readonly db: AppDatabase) {}

  /** Load any stored license at startup. Idempotent if already initialised. */
  async init(): Promise<void> {
    const row = this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).all()[0];
    if (!row) return;
    const result = await this.verifyJws(row.value);
    if (result.ok) {
      this.cached = result.info;
      log(`Pro license active: ${result.info.email}, expires ${result.info.expiresAt.toISOString()}`);
    } else {
      logError(`Stored license is invalid: ${result.reason} — clearing`);
      this.db.delete(settings).where(eq(settings.key, SETTINGS_KEY)).run();
    }
  }

  async setLicense(jws: string): Promise<SetLicenseResult> {
    const trimmed = jws.trim();
    const result = await this.verifyJws(trimmed);
    if (!result.ok) return result;

    this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: trimmed })
      .onConflictDoUpdate({ target: settings.key, set: { value: trimmed } })
      .run();
    this.cached = result.info;
    log(`Pro license set: ${result.info.email}`);
    return result;
  }

  async getLicense(): Promise<LicenseInfo | null> {
    if (this.cached) {
      if (this.cached.expiresAt.getTime() <= Date.now()) {
        this.cached = null;
        return null;
      }
      return this.cached;
    }
    // Also re-check against DB in case the cache was missed (e.g. before init()).
    const row = this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).all()[0];
    if (!row) return null;
    const result = await this.verifyJws(row.value);
    if (!result.ok) return null;
    this.cached = result.info;
    return result.info;
  }

  async removeLicense(): Promise<void> {
    this.db.delete(settings).where(eq(settings.key, SETTINGS_KEY)).run();
    this.cached = null;
    log('Pro license removed');
  }

  isPro(): boolean {
    if (!this.cached) return false;
    return this.cached.expiresAt.getTime() > Date.now();
  }

  hasFeature(feature: string): boolean {
    return this.isPro() && (feature === 'pro' || feature === 'team');
  }

  private async verifyJws(jws: string): Promise<SetLicenseResult> {
    if (!jws || jws.split('.').length !== 3) {
      return { ok: false, reason: 'Invalid format: expected a JWS compact-form string (three dot-separated segments)' };
    }
    let payload: JwsPayload;
    try {
      const key = await importSPKI(LICENSE_PUBLIC_KEY, ALG);
      const verified = await compactVerify(jws, key, { algorithms: [ALG] });
      payload = JSON.parse(new TextDecoder().decode(verified.payload)) as JwsPayload;
    } catch (err: any) {
      return { ok: false, reason: `Invalid signature: ${err.message ?? String(err)}` };
    }
    if (payload.iss !== LICENSE_ISSUER) {
      return { ok: false, reason: `Issuer mismatch: expected ${LICENSE_ISSUER}, got ${payload.iss}` };
    }
    if (payload.exp * 1000 <= Date.now()) {
      return { ok: false, reason: `License expired on ${new Date(payload.exp * 1000).toISOString()}` };
    }
    return {
      ok: true,
      info: {
        email: payload.sub,
        plan: payload.plan,
        expiresAt: new Date(payload.exp * 1000),
        issuedAt: new Date(payload.iat * 1000),
        subscriptionId: payload.subscription_id,
        licenseId: payload.license_id,
      },
    };
  }
}
