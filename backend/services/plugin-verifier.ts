import { eq } from 'drizzle-orm';
import { createPublicKey, verify } from 'crypto';
import { trustedSigningKeys } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const { log } = createLoggers('plugin-verifier');

/**
 * DarkRide official Ed25519 public key (base64 DER).
 * Hardcoded so verification works regardless of database state.
 * The DB may also contain this key + admin-added keys.
 */
const BUILT_IN_KEYS = [
  {
    id: 'darkride-official',
    publicKey: 'MCowBQYDK2VwAyEAhYfjgsV0gzpQbh/Jxr22CvOb01svQdbmdZ39zDze0qM=',
    label: 'DarkRide Official',
  },
];

export type VerificationStatus = 'verified' | 'unsigned' | 'invalid' | 'untrusted';

export interface VerificationResult {
  status: VerificationStatus;
  signedBy?: string;
  keyLabel?: string;
}

export interface SignablePlugin {
  name: string;
  displayName?: string;
  description?: string;
  author?: string;
  repo?: string;
  latestVersion?: string;
  category?: string;
  license?: string;
  npmPackage?: string;
  minDarkrideVersion?: string;
  /**
   * Pin the npm tarball integrity hash (typically `sha512-<base64>`) at sign
   * time so a re-publish of the same version with different contents fails
   * verification at install. Optional; absent for legacy signed plugins.
   */
  npmShasum?: string;
  /**
   * Pin the full git commit SHA for git-URL installs. Optional; absent for
   * registry-name installs.
   */
  gitRef?: string;
  signature?: string;
  signedBy?: string;
  [key: string]: any;
}

/**
 * Result of {@link PluginVerifier.verifyContents}.
 *
 * - `ok: true, pinned: true` — signature carried a content pin and the
 *   installed package matches.
 * - `ok: true, pinned: false` — signature carried no content pin (legacy);
 *   manifest is trusted but the actual bytes weren't pinned.
 * - `ok: false` — signature carried a content pin and the installed package
 *   does NOT match. Install must be rolled back.
 */
export type ContentVerificationResult =
  | { ok: true; pinned: boolean }
  | { ok: false; reason: string };

export class PluginVerifier {
  constructor(private db: AppDatabase) {}

  verify(plugin: SignablePlugin): VerificationResult {
    if (!plugin.signature) return { status: 'unsigned' };

    const trustedKeys = this.getTrustedKeys();
    const canonical = this.canonicalize(plugin);
    const signatureBuffer = Buffer.from(plugin.signature, 'base64');

    for (const key of trustedKeys) {
      try {
        const publicKey = createPublicKey({
          key: Buffer.from(key.publicKey, 'base64'),
          format: 'der',
          type: 'spki',
        });

        const isValid = verify(null, Buffer.from(canonical), publicKey, signatureBuffer);
        if (isValid) {
          return { status: 'verified', signedBy: key.id, keyLabel: key.label };
        }
      } catch {
        // Key parsing or verification error — try next key
      }
    }

    return { status: 'untrusted' };
  }

  checkInstallPermission(plugin: SignablePlugin, isAuthPlugin: boolean): 'allow' | 'prompt' | 'block' {
    const result = this.verify(plugin);
    if (result.status === 'verified') return 'allow';
    if (isAuthPlugin) return 'block';
    return 'prompt';
  }

  /**
   * Deterministic JSON for signature verification.
   * Only includes fields that are part of the signed manifest —
   * runtime fields (source, installUrl, verification) are excluded.
   */
  canonicalize(plugin: SignablePlugin): string {
    const SIGNED_FIELDS = [
      'name', 'displayName', 'description', 'author', 'repo',
      'latestVersion', 'category', 'license', 'npmPackage', 'minDarkrideVersion',
      'npmShasum', 'gitRef',
    ];
    const obj: Record<string, any> = {};
    for (const key of SIGNED_FIELDS) {
      if (key in plugin && plugin[key] !== undefined) {
        obj[key] = plugin[key];
      }
    }
    return JSON.stringify(obj, Object.keys(obj).sort());
  }

  /**
   * Verify that what was actually installed on disk matches the content pin
   * carried by the signed manifest. Called after a successful install, before
   * the install is recorded — a failure must trigger rollback.
   *
   * Backward compatible: if the signed manifest carries no pin (legacy
   * signatures), returns `{ ok: true, pinned: false }` so the caller can
   * surface a "verified by publisher — contents not pinned" badge.
   */
  verifyContents(
    signed: { npmShasum?: string; gitRef?: string },
    installed: { npmShasum?: string; gitRef?: string },
  ): ContentVerificationResult {
    const hasPin = Boolean(signed.npmShasum) || Boolean(signed.gitRef);
    if (!hasPin) return { ok: true, pinned: false };

    if (signed.npmShasum) {
      if (!installed.npmShasum) {
        return { ok: false, reason: 'signed manifest pins npmShasum but installed package has no integrity hash' };
      }
      if (installed.npmShasum !== signed.npmShasum) {
        return { ok: false, reason: `installed npm shasum (${installed.npmShasum}) does not match signed shasum (${signed.npmShasum}) — content tampering or unannounced re-publish` };
      }
    }

    if (signed.gitRef) {
      if (!installed.gitRef) {
        return { ok: false, reason: 'signed manifest pins gitRef but installed package has no resolved git ref' };
      }
      if (installed.gitRef !== signed.gitRef) {
        return { ok: false, reason: `installed git ref (${installed.gitRef}) does not match signed gitRef (${signed.gitRef}) — content tampering` };
      }
    }

    return { ok: true, pinned: true };
  }

  getTrustedKeys(): Array<{ id: string; publicKey: string; label: string; builtIn: boolean; createdAt: Date | null }> {
    // Merge hardcoded built-in keys with any admin-added keys from DB
    const dbKeys = (() => {
      try { return this.db.select().from(trustedSigningKeys).all(); }
      catch { return []; } // DB might not be ready
    })();

    // Deduplicate: DB keys take precedence (admin may have updated the label)
    const keyMap = new Map<string, { id: string; publicKey: string; label: string; builtIn: boolean; createdAt: Date | null }>();
    for (const key of BUILT_IN_KEYS) keyMap.set(key.id, { ...key, builtIn: true, createdAt: null });
    for (const key of dbKeys) keyMap.set(key.id, { id: key.id, publicKey: key.publicKey, label: key.label, builtIn: key.builtIn, createdAt: key.createdAt });
    return [...keyMap.values()];
  }

  addTrustedKey(id: string, publicKey: string, label: string, addedBy: number): void {
    this.db.insert(trustedSigningKeys).values({
      id, publicKey, label, builtIn: false, addedBy, createdAt: new Date(),
    }).run();
    log(`Added trusted key: ${id} (${label})`);
  }

  removeTrustedKey(id: string): void {
    const key = this.db.select().from(trustedSigningKeys).where(eq(trustedSigningKeys.id, id)).get();
    if (!key) throw new Error('Key not found');
    if (key.builtIn) throw new Error('Cannot remove built-in key');
    this.db.delete(trustedSigningKeys).where(eq(trustedSigningKeys.id, id)).run();
    log(`Removed trusted key: ${id}`);
  }
}
