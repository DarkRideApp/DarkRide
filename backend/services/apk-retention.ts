import { eq, like, inArray } from 'drizzle-orm';
import { apkVersions, cloudFiles, settings, trackedApps } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const { log } = createLoggers('apk-retention');

/**
 * Setting key for "how many newest APK versions per tracked app to pin locally".
 * Older versions remain in cloud storage and are fetched on demand.
 */
export const APK_LOCAL_RETENTION_SETTING = 'apk_local_retention_count';
export const DEFAULT_APK_LOCAL_RETENTION = 3;
export const APK_RETENTION_FLOOR = 2;

export function getLocalRetentionCount(db: AppDatabase): number {
  const row = db.select().from(settings).where(eq(settings.key, APK_LOCAL_RETENTION_SETTING)).all()[0];
  const parsed = row?.value ? parseInt(row.value, 10) : NaN;
  const effective = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_APK_LOCAL_RETENTION;
  return Math.max(effective, APK_RETENTION_FLOOR);
}

/**
 * Recompute `retain` flags on cloud_files for one tracked app's APKs.
 * The newest `retentionCount` versions by versionCode get retain=true;
 * everything else is evictable by the LRU.
 *
 * Handles split APKs by matching cloud_key prefix `apks/<pkg>/<filename>/`.
 */
export function applyRetentionForApp(
  db: AppDatabase,
  trackedAppId: number,
  packageName: string,
  retentionCount: number = getLocalRetentionCount(db),
): void {
  const versions = db.select().from(apkVersions)
    .where(eq(apkVersions.trackedAppId, trackedAppId))
    .all()
    .sort((a, b) => b.versionCode - a.versionCode);

  if (versions.length === 0) return;

  const retainedVersions = versions.slice(0, retentionCount);
  const retainedFilenames = new Set(retainedVersions.map(v => v.filename));

  // Build the set of analysis cloud keys that must be pinned (source.db + metadata.json per retained version)
  const retainedAnalysisKeys = new Set<string>();
  for (const v of retainedVersions) {
    retainedAnalysisKeys.add(`apks/${packageName}/analysis/${v.versionCode}/source.db`);
    retainedAnalysisKeys.add(`apks/${packageName}/analysis/${v.versionCode}/metadata.json`);
  }

  // For each version, the cloud keys that belong to it are either:
  //   apks/<pkg>/<filename>           (single APK)
  //   apks/<pkg>/<filename>/<child>   (split APK sub-files)
  //   apks/<pkg>/analysis/<vc>/source.db
  //   apks/<pkg>/analysis/<vc>/metadata.json
  const allKeyPrefix = `apks/${packageName}/`;
  const rows = db.select().from(cloudFiles)
    .where(like(cloudFiles.cloudKey, `${allKeyPrefix}%`))
    .all();

  const toRetain: number[] = [];
  const toRelease: number[] = [];

  for (const row of rows) {
    const rel = row.cloudKey.slice(allKeyPrefix.length); // "<filename>", "<filename>/<child>", or "analysis/<vc>/..."
    const firstSegment = rel.split('/')[0];
    // APK files (single or split): first segment is the filename
    // Analysis artifacts: first segment is "analysis" — matched by explicit key set
    const shouldRetain = retainedFilenames.has(firstSegment) || retainedAnalysisKeys.has(row.cloudKey);
    if (shouldRetain !== row.retain) {
      (shouldRetain ? toRetain : toRelease).push(row.id);
    }
  }

  if (toRetain.length === 0 && toRelease.length === 0) return;

  if (toRetain.length > 0) {
    db.update(cloudFiles).set({ retain: true }).where(inArray(cloudFiles.id, toRetain)).run();
  }
  if (toRelease.length > 0) {
    db.update(cloudFiles).set({ retain: false }).where(inArray(cloudFiles.id, toRelease)).run();
  }

  log(`Retention updated for ${packageName}: pinned ${toRetain.length} artifacts across ${retainedVersions.length} versions, released ${toRelease.length} (keeping newest ${retentionCount})`);
}

/**
 * Recompute retention for every tracked app. Called on startup (after any
 * backfill) and whenever the global setting changes.
 */
export function applyRetentionForAllApps(db: AppDatabase): void {
  const retentionCount = getLocalRetentionCount(db);
  const apps = db.select({ id: trackedApps.id, packageName: trackedApps.packageName })
    .from(trackedApps)
    .all();

  for (const app of apps) {
    applyRetentionForApp(db, app.id, app.packageName, retentionCount);
  }
}
