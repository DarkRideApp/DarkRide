import fs from 'fs';
import path from 'path';
import { and, eq, or, like } from 'drizzle-orm';
import { apkVersions, cloudFiles, trackedApps } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { FileStorageService } from './file-storage';
import { getApkDir } from '../utils/apk-paths';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('apk-backfill');

/**
 * Directories inside `data/apks/` that are NOT per-package APK stores.
 * `wg-binaries/` ships with the install (WireGuard userspace libs).
 */
const SKIP_ENTRIES = new Set(['wg-binaries']);

/**
 * Register on-disk APKs in cloud_files so they can be cloud-synced and
 * managed by the LRU. Idempotent — skips files already tracked.
 *
 * Walks one tracked-app dir at a time, matching files against apk_versions
 * rows by filename (single) or by directory name (split APK).
 */
export function backfillApkCloudFiles(db: AppDatabase, fileSync: FileStorageService): void {
  const apkDir = getApkDir();
  if (!fs.existsSync(apkDir)) return;

  const apps = db.select({
    id: trackedApps.id,
    packageName: trackedApps.packageName,
  }).from(trackedApps).all();

  let registered = 0;
  let skipped = 0;

  for (const app of apps) {
    const pkgDir = path.join(apkDir, app.packageName);
    if (!fs.existsSync(pkgDir)) continue;

    const versions = db.select().from(apkVersions)
      .where(eq(apkVersions.trackedAppId, app.id))
      .all();
    const filenameToVersion = new Map(versions.map(v => [v.filename, v]));

    for (const entry of fs.readdirSync(pkgDir, { withFileTypes: true })) {
      if (entry.name === 'analysis' || SKIP_ENTRIES.has(entry.name)) continue;

      const match = filenameToVersion.get(entry.name);
      if (!match) continue; // on-disk file we don't have a DB row for — skip

      const entryPath = path.join(pkgDir, entry.name);
      if (entry.isDirectory()) {
        // Split APK — register each .apk child
        for (const child of fs.readdirSync(entryPath)) {
          if (!child.endsWith('.apk')) continue;
          const childPath = path.join(entryPath, child);
          const cloudKey = `apks/${app.packageName}/${entry.name}/${child}`;
          if (registerIfMissing(db, fileSync, childPath, cloudKey)) registered++; else skipped++;
        }
      } else if (entry.isFile() && entry.name.endsWith('.apk')) {
        const cloudKey = `apks/${app.packageName}/${entry.name}`;
        if (registerIfMissing(db, fileSync, entryPath, cloudKey)) registered++; else skipped++;
      }
    }
  }

  // Warn about top-level entries we deliberately ignored — useful for audits
  for (const entry of fs.readdirSync(apkDir, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    if (entry.isFile() && entry.name.endsWith('.apk')) {
      error(`Unexpected top-level APK in ${apkDir}: ${entry.name} — not tracked`);
    }
  }

  if (registered > 0 || skipped > 0) {
    log(`APK backfill complete — registered=${registered}, already-tracked=${skipped}`);
  }
}

function registerIfMissing(
  db: AppDatabase,
  fileSync: FileStorageService,
  localPath: string,
  cloudKey: string,
): boolean {
  const existing = db.select().from(cloudFiles).where(eq(cloudFiles.cloudKey, cloudKey)).all()[0];
  if (existing) return false;
  try {
    const size = fs.statSync(localPath).size;
    fileSync.trackFile(localPath, cloudKey, 'apk', size);
    return true;
  } catch (err: any) {
    error(`Failed to register ${localPath}: ${err.message}`);
    return false;
  }
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSizeBytes(p);
      else if (entry.isFile()) total += fs.statSync(p).size;
    }
  } catch { /* ignore */ }
  return total;
}

/**
 * Remove `data/apks/<pkg>/analysis/<versionCode>/` directories whose APK is
 * NOT currently on disk (cloud_only or missing). These are regeneratable on
 * demand via the auto-regenerate hook; keeping them locally just wastes space.
 *
 * Also removes analysis dirs that have no matching apk_versions row at all
 * (orphans from deleted DB entries).
 *
 * Notes are preserved in apk_notes — this function only removes disk-side
 * decompiled output.
 */
export function cleanupStaleAnalysisDirs(db: AppDatabase): void {
  const apkDir = getApkDir();
  if (!fs.existsSync(apkDir)) return;

  let removed = 0;
  let bytesFreed = 0;

  for (const pkg of fs.readdirSync(apkDir, { withFileTypes: true })) {
    if (!pkg.isDirectory() || SKIP_ENTRIES.has(pkg.name)) continue;
    const analysisRoot = path.join(apkDir, pkg.name, 'analysis');
    if (!fs.existsSync(analysisRoot)) continue;

    for (const vcEntry of fs.readdirSync(analysisRoot, { withFileTypes: true })) {
      if (!vcEntry.isDirectory()) continue;
      const versionCode = parseInt(vcEntry.name, 10);
      if (!Number.isFinite(versionCode)) continue;

      const version = db.select({ filename: apkVersions.filename })
        .from(apkVersions)
        .innerJoin(trackedApps, eq(apkVersions.trackedAppId, trackedApps.id))
        .where(and(
          eq(trackedApps.packageName, pkg.name),
          eq(apkVersions.versionCode, versionCode),
        ))
        .all()[0];

      let stale = false;
      if (!version) {
        // No apk_versions row at all — orphan from a deleted entry
        stale = true;
      } else {
        // APK row exists; keep analysis only if APK is synced locally.
        const key = `apks/${pkg.name}/${version.filename}`;
        const syncedLocal = db.select({ id: cloudFiles.id })
          .from(cloudFiles)
          .where(and(
            eq(cloudFiles.syncState, 'synced'),
            or(
              eq(cloudFiles.cloudKey, key),
              like(cloudFiles.cloudKey, `${key}/%`),
            ),
          ))
          .all().length > 0;
        stale = !syncedLocal;
      }

      if (!stale) continue;

      const dir = path.join(analysisRoot, vcEntry.name);
      const size = dirSizeBytes(dir);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
        bytesFreed += size;
      } catch (err: any) {
        error(`Failed to remove stale analysis dir ${dir}: ${err.message}`);
      }
    }
  }

  if (removed > 0) {
    log(`Stale analysis cleanup — removed ${removed} dirs, freed ${(bytesFreed / 1024 / 1024).toFixed(1)} MB`);
  }
}
