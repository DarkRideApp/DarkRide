import path from 'path';
import fs from 'fs';
import { and, eq } from 'drizzle-orm';
import { apkVersions, trackedApps } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { FileStorageService } from '../services/file-storage';
import { getDataRoot } from '../config/paths';
import { safeJoinInside } from './safe-path';

// ── Tier 1: Constants + Pure Path Construction (no I/O) ──────────────

/**
 * Sanitise a versionName for safe use inside a filename / cloud key.
 *
 * versionName can originate from an untrusted source (a remote store's JSON,
 * an APK manifest) and flows into on-disk filenames, the cloud key, and the
 * persisted `apk_versions.filename`. We strip everything outside a strict
 * filename-safe set so it can never introduce a path separator or `..`
 * traversal. The display value stored in `apk_versions.versionName` keeps the
 * original string — only the *filename* component is sanitised.
 */
export function sanitizeVersionName(versionName: string | null | undefined): string {
  const cleaned = String(versionName ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Absolute path to the APK storage directory (resolved at import time).
 * APK_DIR kept as a backward-compat eager constant. For code that needs
 * rename/chdir-aware behaviour (tests, tools), use getApkDir().
 */
export const APK_DIR = path.join(getDataRoot(), 'apks');

/**
 * Resolve the APK base directory relative to DATA_ROOT.
 * Use this instead of APK_DIR when the caller may run under a different CWD
 * (e.g. test environments that process.chdir to a temp dir).
 */
export function getApkDir(): string {
  return path.join(getDataRoot(), 'apks');
}

/**
 * Per-package directory under APK_DIR (`data/apks/<packageName>/`).
 * Throws if `packageName` would escape APK_DIR.
 */
export function packageDir(packageName: string): string {
  return safeJoinInside(getApkDir(), packageName);
}

/**
 * Full local path to an APK file (or split-APK directory).
 *
 * Defence-in-depth: throws if `packageName` or `filename` would escape
 * APK_DIR (`..`, absolute paths). packageName is regex-validated upstream
 * at API boundaries, but the containment check protects against a future
 * validator regression and any path the function gets through plugin or
 * automation code that bypassed the API layer.
 */
export function apkFilePath(packageName: string, filename: string): string {
  return safeJoinInside(getApkDir(), packageName, filename);
}

/** Directory containing analysis output for a specific version. */
export function analysisDir(packageName: string, versionCode: number): string {
  return safeJoinInside(getApkDir(), packageName, 'analysis', String(versionCode));
}

/** Path to the per-version analysis SQLite DB. */
export function analysisDbPath(packageName: string, versionCode: number): string {
  return path.join(analysisDir(packageName, versionCode), 'source.db');
}

/** Path to the per-version notes file. */
export function analysisNotesPath(packageName: string, versionCode: number): string {
  return path.join(analysisDir(packageName, versionCode), 'notes.md');
}

/** Cloud storage key for an APK file. */
export function apkCloudKey(packageName: string, filename: string): string {
  return `apks/${packageName}/${filename}`;
}

/**
 * When an APK's cloud_files row is evicted, the matching on-disk analysis
 * directory becomes stale decompiled output we can regenerate. Removes
 * `data/apks/<pkg>/analysis/<versionCode>/` if we can identify the version
 * from the cloud key.
 *
 * Safe to call with keys that don't match an APK (returns early).
 * Notes in apk_notes are intentionally preserved — only the regenerable
 * decompiled output is removed.
 */
export function cleanupEvictedApkAnalysisDir(db: AppDatabase, cloudKey: string): void {
  // cloudKey forms we handle:
  //   apks/<pkg>/<filename>           (single APK)
  //   apks/<pkg>/<filename>/<child>   (split APK sub-file) — use top-level filename
  if (!cloudKey.startsWith('apks/')) return;
  const parts = cloudKey.split('/');
  if (parts.length < 3) return;
  const packageName = parts[1];
  const filename = parts[2];

  const app = db.select({ id: trackedApps.id })
    .from(trackedApps)
    .where(eq(trackedApps.packageName, packageName))
    .all()[0];
  if (!app) return;

  const version = db.select({ versionCode: apkVersions.versionCode })
    .from(apkVersions)
    .where(and(
      eq(apkVersions.trackedAppId, app.id),
      eq(apkVersions.filename, filename),
    ))
    .all()[0];
  if (!version) return;

  const dir = analysisDir(packageName, version.versionCode);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Cloud storage key for an analysis source.db. */
export function analysisDbCloudKey(packageName: string, versionCode: number): string {
  return `apks/${packageName}/analysis/${versionCode}/source.db`;
}

// ── Tier 2: Filesystem Resolution (does I/O) ────────────────────────

export interface ApkResolution {
  /** Full path to the file or directory. */
  apkPath: string;
  /** True if the path is a directory containing split APKs. */
  isSplit: boolean;
  /** Path to base.apk if split, otherwise same as apkPath. */
  baseApkPath: string;
  /** All .apk file paths (single-element for non-split). */
  allApkPaths: string[];
}

/**
 * Resolve an APK on the local filesystem.
 * Returns null if the path doesn't exist.
 */
export function resolveApkLocal(packageName: string, filename: string): ApkResolution | null {
  const fullPath = apkFilePath(packageName, filename);
  if (!fs.existsSync(fullPath)) return null;

  const stat = fs.statSync(fullPath);

  if (stat.isDirectory()) {
    // Split APK directory
    const apkFiles = fs.readdirSync(fullPath)
      .filter(f => f.endsWith('.apk'))
      .map(f => path.join(fullPath, f));

    // Empty directory (e.g. .apk files evicted by FileStorageService) → treat as not found
    if (apkFiles.length === 0) return null;

    const baseApk = apkFiles.find(f => path.basename(f) === 'base.apk') ?? apkFiles[0];

    return {
      apkPath: fullPath,
      isSplit: true,
      baseApkPath: baseApk,
      allApkPaths: apkFiles,
    };
  }

  // Single APK file
  return {
    apkPath: fullPath,
    isSplit: false,
    baseApkPath: fullPath,
    allApkPaths: [fullPath],
  };
}

// ── Tier 3: DB-Backed Resolution ─────────────────────────────────────

export interface VersionMeta {
  packageName: string;
  appName: string | null;
  versionCode: number;
  versionName: string | null;
  filename: string;
  trackedAppId: number;
}

/**
 * Look up version + app metadata from a versionId.
 * Returns null if the version or its tracked app doesn't exist.
 */
export function lookupVersionMeta(db: AppDatabase, versionId: number): VersionMeta | null {
  const version = db.select().from(apkVersions).where(eq(apkVersions.id, versionId)).all()[0];
  if (!version) return null;
  const app = db.select().from(trackedApps).where(eq(trackedApps.id, version.trackedAppId)).all()[0];
  if (!app) return null;
  return {
    packageName: app.packageName,
    appName: app.appName ?? null,
    versionCode: version.versionCode,
    versionName: version.versionName ?? null,
    filename: version.filename,
    trackedAppId: app.id,
  };
}

/**
 * Resolve a version's APK on the local filesystem, combining DB lookup + filesystem check.
 * Returns null if the version doesn't exist in the DB.
 */
export function resolveApkVersion(db: AppDatabase, versionId: number): { meta: VersionMeta; local: ApkResolution | null } | null {
  const meta = lookupVersionMeta(db, versionId);
  if (!meta) return null;
  const local = resolveApkLocal(meta.packageName, meta.filename);
  return { meta, local };
}

// ── Tier 4: Cloud-Aware Ensure ───────────────────────────────────────

export interface ApkHandle {
  resolution: ApkResolution;
  /** No-op, retained for API compatibility. */
  release(): void;
}

/**
 * Ensure an APK is available locally, fetching from cloud if needed.
 * Handles both single-file APKs and split APKs (tracked as individual sub-files in cloud).
 * Returns an ApkHandle with a `release()` method, or an error object.
 */
export async function ensureApkLocal(
  packageName: string,
  filename: string,
  fileSync: FileStorageService | null,
  holder: string,
): Promise<ApkHandle | { error: string }> {
  // Check local first
  const local = resolveApkLocal(packageName, filename);
  if (local) {
    return { resolution: local, release() {} };
  }

  // Try cloud fetch
  if (!fileSync) {
    return { error: 'APK not found locally and no cloud sync available' };
  }

  const localPath = apkFilePath(packageName, filename);
  const cloudKey = apkCloudKey(packageName, filename);

  // Try single-file cloud fetch first
  const acquired = await fileSync.acquireLocal(cloudKey, holder, localPath);

  if (acquired.error) {
    // Single-key fetch failed — try split APK recovery (individual sub-files tracked separately)
    const splitPrefix = cloudKey + '/';
    const splitResult = await fileSync.acquireLocalByPrefix(splitPrefix, holder);
    if (splitResult.error) {
      // Prefer the split error when single-key failed with "File not found"
      // but the split fallback gave a more specific reason. Callers see one
      // concrete explanation rather than the vaguer parent-key message.
      const reason = acquired.error.startsWith('File not found')
        ? splitResult.error
        : acquired.error;
      return { error: `APK not available: ${reason}` };
    }
  }

  // Re-resolve after cloud download
  const resolved = resolveApkLocal(packageName, filename);
  if (!resolved) {
    return { error: 'APK not available after cloud download — file did not land on disk' };
  }

  return {
    resolution: resolved,
    release() { /* no-op */ },
  };
}

/**
 * Ensure an APK version is available locally by versionId, combining DB lookup + cloud fetch.
 * Returns handle with version metadata, or an error object.
 */
export async function ensureApkVersionLocal(
  db: AppDatabase,
  versionId: number,
  fileSync: FileStorageService | null,
  holder: string,
): Promise<(ApkHandle & { meta: VersionMeta }) | { error: string }> {
  const meta = lookupVersionMeta(db, versionId);
  if (!meta) return { error: 'APK version not found' };

  const result = await ensureApkLocal(meta.packageName, meta.filename, fileSync, holder);
  if ('error' in result) return result;

  return { ...result, meta };
}
