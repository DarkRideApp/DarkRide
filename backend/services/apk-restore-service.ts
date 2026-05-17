import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { join } from 'path';
import { computeVersionAvailability } from './apk-availability';
import { lookupVersionMeta, apkFilePath, analysisDbPath, analysisDir } from '../utils/apk-paths';
import { createLoggers } from '../logs';

const { log } = createLoggers('apk-restore');

export type RestoreOutcome =
  | { kind: 'already-local' }
  | { kind: 'downloaded'; artifacts: number }
  | { kind: 'reanalysis-enqueued'; jobId: number };

export class RestoreLostError extends Error {
  constructor(versionId: number) {
    super(`Version ${versionId} has no cloud copy to restore from`);
    this.name = 'RestoreLostError';
  }
}

/**
 * Minimal interface for the file sync service that the restore service needs.
 *
 * Matches the real `FileStorageService.acquireLocal` signature:
 *   acquireLocal(cloudKey, holder, localPath?) → Promise<{ path?, error? }>
 */
export interface RestoreFileSync {
  acquireLocal(
    cloudKey: string,
    holder: string,
    localPath?: string,
  ): Promise<{ path?: string; error?: string }>;
}

/**
 * Minimal interface for the APK analyzer that the restore service needs.
 *
 * Uses `enqueue(apkVersionId, opts)` which is the real method on `ApkAnalyzerService`
 * that queues a decompilation + source.db rebuild job. `skipAiReview: true` is
 * passed so re-analysis doesn't overwrite existing AI notes.
 */
export interface RestoreApkAnalyzer {
  enqueue(apkVersionId: number, opts?: { skipAiReview?: boolean }): Promise<number>;
}

export interface ApkRestoreServiceDeps {
  db: BetterSQLite3Database<any>;
  fileSync: RestoreFileSync;
  apkAnalyzer: RestoreApkAnalyzer;
}

/**
 * Service that picks the right restore strategy based on a version's current
 * availability state (local / cloud / needs-reanalyze / lost).
 *
 * - local         → no-op
 * - cloud         → download all three artifacts (APK + source.db + metadata)
 * - needs-reanalyze → ensure APK is local, then enqueue re-analysis job
 * - lost          → throw RestoreLostError (no recovery path)
 */
export class ApkRestoreService {
  constructor(private deps: ApkRestoreServiceDeps) {}

  async restore(versionId: number): Promise<RestoreOutcome> {
    const meta = lookupVersionMeta(this.deps.db, versionId);
    if (!meta) throw new Error(`Unknown APK version: ${versionId}`);

    const avail = computeVersionAvailability(this.deps.db, versionId);

    switch (avail.state) {
      case 'local':
        return { kind: 'already-local' };

      case 'cloud': {
        const targets = [
          {
            cloudKey: `apks/${meta.packageName}/${meta.filename}`,
            localPath: apkFilePath(meta.packageName, meta.filename),
          },
          {
            cloudKey: `apks/${meta.packageName}/analysis/${meta.versionCode}/source.db`,
            localPath: analysisDbPath(meta.packageName, meta.versionCode),
          },
          {
            cloudKey: `apks/${meta.packageName}/analysis/${meta.versionCode}/metadata.json`,
            localPath: join(analysisDir(meta.packageName, meta.versionCode), 'metadata.json'),
          },
        ];

        let count = 0;
        for (const t of targets) {
          const result = await this.deps.fileSync.acquireLocal(
            t.cloudKey,
            `apk-restore-${versionId}`,
            t.localPath,
          );
          if (result.error) {
            throw new Error(`Failed to download ${t.cloudKey}: ${result.error}`);
          }
          count++;
        }

        log(`Restored ${meta.packageName}@${meta.versionCode} from cloud (${count} artifacts)`);
        return { kind: 'downloaded', artifacts: count };
      }

      case 'needs-reanalyze': {
        // Ensure APK is local before enqueuing analysis
        if (!avail.apk.localPresent) {
          const apkKey = `apks/${meta.packageName}/${meta.filename}`;
          const localPath = apkFilePath(meta.packageName, meta.filename);
          const result = await this.deps.fileSync.acquireLocal(
            apkKey,
            `apk-restore-${versionId}`,
            localPath,
          );
          if (result.error) {
            throw new Error(`Failed to download APK for re-analysis: ${result.error}`);
          }
        }

        // skipAiReview: true so existing AI notes in apk_notes are preserved
        const jobId = await this.deps.apkAnalyzer.enqueue(versionId, { skipAiReview: true });

        log(`Enqueued re-analysis for ${meta.packageName}@${meta.versionCode} (job ${jobId})`);
        return { kind: 'reanalysis-enqueued', jobId };
      }

      case 'lost':
        throw new RestoreLostError(versionId);
    }
  }
}
