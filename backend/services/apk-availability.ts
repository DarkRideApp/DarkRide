import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { lookupVersionMeta, apkFilePath, analysisDir } from '../utils/apk-paths';

export type VersionAvailabilityState = 'local' | 'cloud' | 'needs-reanalyze' | 'lost';

export interface ArtifactStatus {
  localPresent: boolean;
  cloudSynced: boolean;
}

export interface VersionAvailability {
  state: VersionAvailabilityState;
  apk: ArtifactStatus;
  sourceDb: ArtifactStatus;
  metadata: ArtifactStatus;
  canRestoreFromCloud: boolean;
  canReanalyze: boolean;
}

function statusForArtifact(
  db: BetterSQLite3Database<any>,
  cloudKey: string,
  localPath: string,
): ArtifactStatus {
  const row = db.select().from(schema.cloudFiles)
    .where(eq(schema.cloudFiles.cloudKey, cloudKey)).get();
  if (row) {
    return {
      // localPath is NOT NULL in schema; cloud_only rows retain the old path string
      // but the file is no longer on disk — use syncState as the source of truth.
      localPresent: row.syncState !== 'cloud_only',
      cloudSynced: row.syncState === 'synced' || row.syncState === 'cloud_only',
    };
  }
  // No cloud_files row — either cloud storage isn't configured (trackFile
  // no-ops early when unconfigured) or the row hasn't been written yet.
  // Fall back to the filesystem as the source of truth for local presence.
  return {
    localPresent: fs.existsSync(localPath),
    cloudSynced: false,
  };
}

export function computeVersionAvailability(
  db: BetterSQLite3Database<any>,
  versionId: number,
): VersionAvailability {
  const meta = lookupVersionMeta(db, versionId);
  if (!meta) throw new Error(`Unknown APK version: ${versionId}`);

  const analysisRoot = analysisDir(meta.packageName, meta.versionCode);
  const apk = statusForArtifact(
    db,
    `apks/${meta.packageName}/${meta.filename}`,
    apkFilePath(meta.packageName, meta.filename),
  );
  const sourceDb = statusForArtifact(
    db,
    `apks/${meta.packageName}/analysis/${meta.versionCode}/source.db`,
    path.join(analysisRoot, 'source.db'),
  );
  const metadata = statusForArtifact(
    db,
    `apks/${meta.packageName}/analysis/${meta.versionCode}/metadata.json`,
    path.join(analysisRoot, 'metadata.json'),
  );

  const allLocal = apk.localPresent && sourceDb.localPresent && metadata.localPresent;
  const allSynced = apk.cloudSynced && sourceDb.cloudSynced && metadata.cloudSynced;
  const apkAvailable = apk.localPresent || apk.cloudSynced;
  const sourceDbMissingEverywhere = !sourceDb.localPresent && !sourceDb.cloudSynced;

  let state: VersionAvailabilityState;
  if (allLocal) {
    state = 'local';
  } else if (!apkAvailable) {
    state = 'lost';
  } else if (sourceDbMissingEverywhere) {
    state = 'needs-reanalyze';
  } else if (allSynced) {
    state = 'cloud';
  } else {
    // Partial state — APK available but something else is pending/missing.
    // If source.db is reachable (local or cloud), treat as cloud; otherwise needs-reanalyze.
    state = sourceDb.cloudSynced || sourceDb.localPresent ? 'cloud' : 'needs-reanalyze';
  }

  return {
    state,
    apk,
    sourceDb,
    metadata,
    canRestoreFromCloud: state === 'cloud',
    canReanalyze: state === 'needs-reanalyze' && apkAvailable,
  };
}
