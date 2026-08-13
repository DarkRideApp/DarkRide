import fs from 'fs';
import path from 'path';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';
import * as schema from '../db/schema';
import { createLoggers } from '../logs';
import type { CloudStorageService } from './cloud-storage';
import type { FileStorageService as IFileStorageService } from '@darkrideapp/plugin-sdk';
import { NamespacedStorageImpl } from './namespaced-storage';
import { cleanupEvictedApkAnalysisDir } from '../utils/apk-paths';
import { absoluteLocalPath, toRelativeLocalPath } from '../config/paths';
import { safeJoinInside } from '../utils/safe-path';

const logger = createLoggers('file-sync');

const { cloudFiles, settings, automationSessions, screenshots, apkVersions, trackedApps } = schema;

const DEFAULT_CACHE_BUDGET_MB = 5000;

/**
 * Returns true only when all cloud-backed artifacts for this APK version
 * (APK file(s) + source.db + metadata.json) are present in cloudFiles with
 * syncState === 'synced'. Handles split-APK directories by requiring every
 * child file under `apks/<pkg>/<filename>/` to be synced.
 */
export function isVersionSafeToEvict(
  db: AppDatabase,
  packageName: string,
  versionCode: number,
  filename: string,
): boolean {
  return apkVersionEvictability(db, packageName, versionCode, filename) === 'safe';
}

/**
 * Eviction verdict for one APK version.
 *
 *  - `blocked`            the APK itself is not fully synced, or one of its
 *                         analysis artifacts IS tracked but has not finished
 *                         uploading. Evicting now would lose data.
 *  - `safe`               APK and both analysis artifacts are synced to cloud.
 *  - `safe-no-analysis`   APK is synced, but the analysis artifacts were never
 *                         tracked in cloud_files at all. The APK is safe to
 *                         evict (it exists in the cloud), but the local
 *                         analysis dir must be left alone — it has no cloud
 *                         copy to restore from.
 *
 * The untracked case is not hypothetical: nothing in the analyzer registers
 * source.db or metadata.json with the file-sync service, so on a real install
 * every version lands here. Treating that as `blocked` (the original
 * behaviour) made the APK cache un-evictable forever.
 */
export type ApkEvictability = 'blocked' | 'safe' | 'safe-no-analysis';

export function apkVersionEvictability(
  db: AppDatabase,
  packageName: string,
  versionCode: number,
  filename: string,
): ApkEvictability {
  const apkKeyPrefix = `apks/${packageName}/${filename}`;

  // Get APK rows: exact match (single APK) OR children under the prefix (split APK)
  const apkRows = db.select().from(cloudFiles)
    .where(or(
      eq(cloudFiles.cloudKey, apkKeyPrefix),
      like(cloudFiles.cloudKey, `${apkKeyPrefix}/%`),
    )).all();

  if (apkRows.length === 0) return 'blocked'; // APK never tracked
  if (apkRows.some(r => r.syncState !== 'synced')) return 'blocked';

  const requiredAnalysisKeys = [
    `apks/${packageName}/analysis/${versionCode}/source.db`,
    `apks/${packageName}/analysis/${versionCode}/metadata.json`,
  ];

  let tracked = 0;
  for (const key of requiredAnalysisKeys) {
    const row = db.select().from(cloudFiles).where(eq(cloudFiles.cloudKey, key)).get();
    if (!row) continue;
    // Tracked but mid-flight — this is the race the gate exists to prevent.
    if (row.syncState !== 'synced') return 'blocked';
    tracked++;
  }

  return tracked === requiredAnalysisKeys.length ? 'safe' : 'safe-no-analysis';
}

/**
 * If `cloudKey` belongs to an APK version (apks/<pkg>/...), return its
 * identifiers. Returns null for non-APK cloud keys so the eviction loop
 * skips the safety check for other namespaces.
 */
function extractApkVersionMetaFromCloudKey(
  db: AppDatabase,
  cloudKey: string,
): { packageName: string; versionCode: number; filename: string } | null {
  if (!cloudKey.startsWith('apks/')) return null;
  const rest = cloudKey.slice('apks/'.length);
  const firstSlash = rest.indexOf('/');
  if (firstSlash === -1) return null;
  const packageName = rest.slice(0, firstSlash);
  const remainder = rest.slice(firstSlash + 1);

  const app = db.select({ id: trackedApps.id })
    .from(trackedApps)
    .where(eq(trackedApps.packageName, packageName))
    .get();
  if (!app) return null;

  // Case 1: analysis path — apks/<pkg>/analysis/<vc>/...
  if (remainder.startsWith('analysis/')) {
    const m = /^analysis\/(\d+)\//.exec(remainder);
    if (!m) return null;
    const versionCode = parseInt(m[1], 10);
    if (!Number.isFinite(versionCode)) return null;
    const ver = db.select({ versionCode: apkVersions.versionCode, filename: apkVersions.filename })
      .from(apkVersions)
      .where(and(eq(apkVersions.trackedAppId, app.id), eq(apkVersions.versionCode, versionCode)))
      .get();
    if (!ver) return null;
    return { packageName, versionCode, filename: ver.filename };
  }

  // Case 2: APK file or split APK child — apks/<pkg>/<filename>[/<child>]
  const filename = remainder.split('/')[0];
  const ver = db.select({ versionCode: apkVersions.versionCode })
    .from(apkVersions)
    .where(and(eq(apkVersions.trackedAppId, app.id), eq(apkVersions.filename, filename)))
    .get();
  if (!ver) return null;
  return { packageName, versionCode: ver.versionCode, filename };
}

export interface CloudStatus {
  configured: boolean;
  localCacheUsageMb: number;
  localCacheBudgetMb: number;
  filesTracked: number;
  filesCloudOnly: number;
  pendingUploads: number;
  errors: { cloudKey: string; error: string }[];
}

export interface AcquireResult {
  path?: string;
  error?: string;
}

export class FileStorageService implements IFileStorageService {
  private db: AppDatabase;
  private cloudStorage: CloudStorageService;
  private databasePath?: string;
  private screenshotPath?: string;

  private uploadTimer: ReturnType<typeof setInterval> | null = null;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private sessionSyncTimer: ReturnType<typeof setInterval> | null = null;

  private lastBackupDate: string | null = null;
  private uploadRunning = false;

  constructor(db: AppDatabase, cloudStorage: CloudStorageService, databasePath?: string, screenshotPath?: string) {
    this.db = db;
    this.cloudStorage = cloudStorage;
    this.databasePath = databasePath;
    this.screenshotPath = screenshotPath;
  }

  forPlugin(pluginName: string): NamespacedStorageImpl {
    const localRoot = path.resolve(`./data/plugins/${pluginName}`);
    if (!fs.existsSync(localRoot)) fs.mkdirSync(localRoot, { recursive: true });
    return new NamespacedStorageImpl(pluginName, localRoot, this.db, this.cloudStorage, `plugins/${pluginName}/`);
  }

  forNamespace(namespace: string): NamespacedStorageImpl {
    const localRoot = path.resolve(`./data/${namespace}`);
    if (!fs.existsSync(localRoot)) fs.mkdirSync(localRoot, { recursive: true });
    return new NamespacedStorageImpl(namespace, localRoot, this.db, this.cloudStorage, `${namespace}/`);
  }

  start(): void {
    logger.log('Starting file sync workers');

    this.uploadTimer = setInterval(() => {
      this.processUploadQueue().catch(err => logger.error('Upload queue error:', err.message));
    }, 10_000);

    this.evictionTimer = setInterval(() => {
      this.runEviction().catch(err => logger.error('Eviction error:', err.message));
    }, 5 * 60_000);

    this.backupTimer = setInterval(() => {
      this.checkDailyBackup().catch(err => logger.error('Backup check error:', err.message));
    }, 60 * 60_000);

    this.sessionSyncTimer = setInterval(() => {
      this.syncPinnedSessions().catch(err => logger.error('Session sync error:', err.message));
    }, 60_000);

    // Run session sync immediately on startup
    this.syncPinnedSessions().catch(err => logger.error('Session sync error:', err.message));
  }

  stop(): void {
    if (this.uploadTimer) { clearInterval(this.uploadTimer); this.uploadTimer = null; }
    if (this.evictionTimer) { clearInterval(this.evictionTimer); this.evictionTimer = null; }
    if (this.backupTimer) { clearInterval(this.backupTimer); this.backupTimer = null; }
    if (this.sessionSyncTimer) { clearInterval(this.sessionSyncTimer); this.sessionSyncTimer = null; }
    logger.log('File sync workers stopped');
  }

  trackFile(localPath: string, cloudKey: string, fileType: string, fileSize: number): void {
    if (!this.cloudStorage.isConfigured()) return;

    const storedPath = toRelativeLocalPath(localPath);

    const now = new Date();
    const existing = this.db.select()
      .from(cloudFiles)
      .where(eq(cloudFiles.cloudKey, cloudKey))
      .all();

    if (existing.length > 0) {
      // Don't re-queue files that are already synced or uploading
      const state = existing[0].syncState;
      if (state === 'synced' || state === 'pending_upload') {
        this.db.update(cloudFiles)
          .set({ lastAccessed: now })
          .where(eq(cloudFiles.cloudKey, cloudKey))
          .run();
        return;
      }
      this.db.update(cloudFiles)
        .set({
          relativePath: storedPath,
          fileType,
          fileSize,
          syncState: 'pending_upload',
          syncError: null,
          lastAccessed: now,
        })
        .where(eq(cloudFiles.cloudKey, cloudKey))
        .run();
    } else {
      this.db.insert(cloudFiles)
        .values({
          cloudKey,
          relativePath: storedPath,
          fileType,
          fileSize,
          syncState: 'pending_upload',
          lastAccessed: now,
          createdAt: now,
        })
        .run();
    }
  }

  async acquireLocal(cloudKey: string, _holder: string, localPath?: string): Promise<AcquireResult> {
    const rows = this.db.select()
      .from(cloudFiles)
      .where(eq(cloudFiles.cloudKey, cloudKey))
      .all();

    const now = new Date();

    if (rows.length === 0) {
      // No DB entry — try direct cloud download as fallback
      if (!localPath || !this.cloudStorage.isConfigured()) {
        return { error: `File not found: ${cloudKey}` };
      }

      const existsInCloud = await this.cloudStorage.exists(cloudKey);
      if (!existsInCloud) {
        return { error: `File not found: ${cloudKey}` };
      }

      logger.log(`Recovering untracked file from cloud: ${cloudKey}`);
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const result = await this.cloudStorage.download(cloudKey, localPath);
      if (result.error) {
        return { error: `Download failed: ${result.error}` };
      }

      // Create tracking entry so future access is seamless
      const fileSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
      this.db.insert(cloudFiles)
        .values({
          cloudKey,
          relativePath: toRelativeLocalPath(localPath),
          fileType: cloudKey.includes('/analysis/') ? 'analysis' : cloudKey.startsWith('sessions/') ? 'session-screenshot' : 'apk',
          fileSize,
          syncState: 'synced',
          lastAccessed: now,
          createdAt: now,
        })
        .run();

      return { path: localPath };
    }

    const file = rows[0];
    const resolvedPath = absoluteLocalPath(file.relativePath);

    // Check if file exists locally with correct size
    let localOk = false;
    try {
      if (fs.existsSync(resolvedPath)) {
        const stat = fs.statSync(resolvedPath);
        if (stat.size === file.fileSize) {
          localOk = true;
        }
      }
    } catch {
      localOk = false;
    }

    if (!localOk && (file.syncState === 'cloud_only' || file.syncState === 'synced')) {
      // Need to download from cloud
      const result = await this.cloudStorage.download(cloudKey, resolvedPath);
      if (result.error) {
        return { error: `Download failed: ${result.error}` };
      }

      this.db.update(cloudFiles)
        .set({ syncState: 'synced', lastAccessed: now })
        .where(eq(cloudFiles.id, file.id))
        .run();
    } else if (!localOk) {
      // Tracked but neither on disk nor uploaded (e.g. syncState=pending_upload
      // and something wiped the local copy before the upload worker ran). Fail
      // explicitly — returning a stale path silently passes to callers that
      // then fail further down the stack with misleading errors.
      return { error: `File ${cloudKey} is ${file.syncState} and not present locally` };
    } else {
      // Update lastAccessed. If the row still says cloud_only but the file is
      // present at the right size, the local copy was restored by some path
      // other than this method — return the row to 'synced' so the evictor can
      // see it again. runEviction only ever selects syncState='synced', so
      // leaving it as cloud_only strands the file on disk permanently and hides
      // it from the cache-budget accounting.
      this.db.update(cloudFiles)
        .set({ lastAccessed: now, ...(file.syncState === 'cloud_only' ? { syncState: 'synced' as const } : {}) })
        .where(eq(cloudFiles.id, file.id))
        .run();
    }

    return { path: resolvedPath };
  }

  /**
   * Acquire all cloud-tracked files whose keys start with `prefix`.
   * Used to recover split APK sub-files (e.g. prefix "apks/pkg/dir/" recovers base.apk, split_config.apk, etc.).
   * Returns paths for all acquired files. On any failure, returns error.
   */
  async acquireLocalByPrefix(prefix: string, holder: string): Promise<{ error?: string }> {
    const rows = this.db.select()
      .from(cloudFiles)
      .where(sql`${cloudFiles.cloudKey} LIKE ${prefix + '%'}`)
      .all();

    if (rows.length === 0) return { error: `No files found with prefix: ${prefix}` };

    for (const row of rows) {
      const result = await this.acquireLocal(row.cloudKey, holder, absoluteLocalPath(row.relativePath));
      if (result.error) {
        return { error: result.error };
      }
    }

    return {};
  }

  async getDirectUrl(cloudKey: string): Promise<string | null> {
    return this.cloudStorage.presignUrl(cloudKey);
  }

  async removeFile(cloudKey: string): Promise<void> {
    const rows = this.db.select()
      .from(cloudFiles)
      .where(eq(cloudFiles.cloudKey, cloudKey))
      .all();

    if (rows.length === 0) return;

    const file = rows[0];
    const resolvedPath = absoluteLocalPath(file.relativePath);

    // Delete from cloud
    await this.cloudStorage.delete(cloudKey);

    // Delete local file
    try {
      if (fs.existsSync(resolvedPath)) {
        fs.unlinkSync(resolvedPath);
      }
    } catch {
      // ignore missing file
    }

    // Delete DB row
    this.db.delete(cloudFiles)
      .where(eq(cloudFiles.id, file.id))
      .run();
  }

  getStatus(): CloudStatus {
    const configured = this.cloudStorage.isConfigured();

    const allFiles = this.db.select().from(cloudFiles).all();

    const filesTracked = allFiles.length;
    const filesCloudOnly = allFiles.filter(f => f.syncState === 'cloud_only').length;
    const pendingUploads = allFiles.filter(f => f.syncState === 'pending_upload').length;
    const errors = allFiles
      .filter(f => f.syncError !== null)
      .map(f => ({ cloudKey: f.cloudKey, error: f.syncError! }));

    // Sum file sizes for cache usage (files that have local copies)
    const localFiles = allFiles.filter(f => f.syncState !== 'cloud_only');
    const localCacheUsageBytes = localFiles.reduce((sum, f) => sum + f.fileSize, 0);
    const localCacheUsageMb = Math.round(localCacheUsageBytes / (1024 * 1024) * 100) / 100;

    const localCacheBudgetMb = this.getCacheBudgetMb();

    return {
      configured,
      localCacheUsageMb,
      localCacheBudgetMb,
      filesTracked,
      filesCloudOnly,
      pendingUploads,
      errors,
    };
  }

  retryUpload(cloudKey: string): void {
    this.db.update(cloudFiles)
      .set({ syncError: null })
      .where(eq(cloudFiles.cloudKey, cloudKey))
      .run();
  }

  // --- Private worker methods ---

  private async processUploadQueue(): Promise<void> {
    if (!this.cloudStorage.isConfigured()) return;
    if (this.uploadRunning) return; // Prevent overlapping runs
    this.uploadRunning = true;

    try {
      const pending = this.db.select()
        .from(cloudFiles)
        .where(eq(cloudFiles.syncState, 'pending_upload'))
        .all();

      for (const file of pending) {
        try {
          const didUpload = await this.cloudStorage.upload(file.cloudKey, absoluteLocalPath(file.relativePath));
          this.db.update(cloudFiles)
            .set({ syncState: 'synced', syncError: null })
            .where(eq(cloudFiles.id, file.id))
            .run();
          if (didUpload) logger.log(`Uploaded ${file.cloudKey}`);
        } catch (err: any) {
          this.db.update(cloudFiles)
            .set({ syncError: err.message })
            .where(eq(cloudFiles.id, file.id))
            .run();
          logger.error(`Upload failed for ${file.cloudKey}: ${err.message}`);
        }
      }
    } finally {
      this.uploadRunning = false;
    }
  }

  /**
   * Return cloud_only rows whose local file is actually still present to
   * 'synced'. A cloud_only row is assumed to have no local copy, so it is
   * counted as zero against the cache budget and never considered for
   * eviction. When a local copy reappears — restored by a code path that did
   * not go through acquireLocal, or an unlink that silently failed — the file
   * occupies disk that nothing will ever reclaim.
   */
  private reconcileStrandedLocals(): number {
    const strandedRows = this.db.select()
      .from(cloudFiles)
      .where(eq(cloudFiles.syncState, 'cloud_only'))
      .all();

    const reclaimed: number[] = [];
    for (const row of strandedRows) {
      try {
        const local = absoluteLocalPath(row.relativePath);
        if (!fs.existsSync(local)) continue;
        // Only trust a full-size local copy; a truncated leftover is not a
        // usable cache entry and is handled by the normal download path.
        if (fs.statSync(local).size !== row.fileSize) continue;
        reclaimed.push(row.id);
      } catch {
        // Unreadable / path outside DATA_ROOT — leave the row untouched.
      }
    }

    if (reclaimed.length > 0) {
      this.db.update(cloudFiles)
        .set({ syncState: 'synced' })
        .where(inArray(cloudFiles.id, reclaimed))
        .run();
      logger.log(`Reclaimed ${reclaimed.length} cloud_only file(s) still present on disk into the evictable cache`);
    }
    return reclaimed.length;
  }

  private async runEviction(): Promise<void> {
    const budgetMb = this.getCacheBudgetMb();
    const budgetBytes = budgetMb * 1024 * 1024;

    // Fold any stranded local copies back in before measuring the cache, so
    // the budget reflects real disk usage rather than what the DB assumes.
    this.reconcileStrandedLocals();

    // Get all synced files (have both local + cloud copies)
    const syncedFiles = this.db.select()
      .from(cloudFiles)
      .where(eq(cloudFiles.syncState, 'synced'))
      .all();

    const totalSize = syncedFiles.reduce((sum, f) => sum + f.fileSize, 0);
    if (totalSize <= budgetBytes) return;

    // Sort by oldest lastAccessed first
    syncedFiles.sort((a, b) => {
      const aTime = a.lastAccessed instanceof Date ? a.lastAccessed.getTime() : Number(a.lastAccessed);
      const bTime = b.lastAccessed instanceof Date ? b.lastAccessed.getTime() : Number(b.lastAccessed);
      return aTime - bTime;
    });

    let currentSize = totalSize;
    let skippedNotSynced = 0;
    let skippedRetained = 0;

    for (const file of syncedFiles) {
      if (currentSize <= budgetBytes) break;

      // Skip retained files — they should never be evicted
      if (file.retain) { skippedRetained++; continue; }

      // Safety check: if this file belongs to an APK version, ensure all
      // artifacts of that version (APK + source.db + metadata.json) are fully
      // synced before evicting any of them. This prevents the race where we
      // evict an APK file while source.db is still pending_upload.
      const meta = extractApkVersionMetaFromCloudKey(this.db, file.cloudKey);
      let verdict: ApkEvictability = 'safe';
      if (meta) {
        verdict = apkVersionEvictability(this.db, meta.packageName, meta.versionCode, meta.filename);
        if (verdict === 'blocked') {
          // Counted and summarised after the loop. Logging per-file here ran
          // every 5 minutes against every APK and produced ~108k journal lines
          // in 48 hours on production.
          skippedNotSynced++;
          continue;
        }
      }

      // Evict: delete local file, set state to cloud_only
      try {
        if (fs.existsSync(absoluteLocalPath(file.relativePath))) {
          fs.unlinkSync(absoluteLocalPath(file.relativePath));
        }
      } catch {
        // ignore
      }

      this.db.update(cloudFiles)
        .set({ syncState: 'cloud_only' })
        .where(eq(cloudFiles.id, file.id))
        .run();

      // APKs own an analysis dir that becomes stale once the APK is gone
      // locally; regenerable from source.db rebuild. Notes are preserved in
      // the apk_notes table and are NOT touched by this cleanup.
      //
      // Only safe when the analysis artifacts actually reached the cloud. Under
      // 'safe-no-analysis' there is no cloud copy, so deleting the dir would
      // destroy the only copy of the analysis — leave it for the APK-level
      // analysis retention job instead.
      if (file.cloudKey.startsWith('apks/') && verdict === 'safe') {
        try {
          cleanupEvictedApkAnalysisDir(this.db, file.cloudKey);
        } catch (err: any) {
          logger.error(`Analysis dir cleanup failed for ${file.cloudKey}: ${err.message}`);
        }
      }

      currentSize -= file.fileSize;
      logger.log(`Evicted ${file.cloudKey} (${file.fileSize} bytes)`);
    }

    if (currentSize > budgetBytes) {
      logger.log(
        `Eviction finished over budget: ${(currentSize / 1048576).toFixed(0)}MB local vs ${budgetMb}MB budget ` +
        `(${skippedRetained} files pinned by retention, ${skippedNotSynced} not fully synced). ` +
        `Lower the APK retention count or raise the cache budget to close the gap.`,
      );
    }
  }

  /** Run a cloud backup now (public, for job system). Skips if cloud not configured. */
  async runBackupNow(): Promise<void> {
    if (!this.cloudStorage.isConfigured()) throw new Error('Cloud storage not configured');
    if (!this.databasePath) throw new Error('Database path not set');

    const todayStr = new Date().toISOString().slice(0, 10);
    this.lastBackupDate = todayStr;

    const tmpPath = path.join(path.dirname(this.databasePath), `darkride-backup-${todayStr}.db`);
    try {
      const Database = (await import('better-sqlite3')).default;
      const sourceDb = new Database(this.databasePath, { readonly: true });
      await sourceDb.backup(tmpPath);
      sourceDb.close();

      const backupKey = `backups/darkride-${todayStr}.db`;
      await this.cloudStorage.upload(backupKey, tmpPath);
      try { fs.unlinkSync(tmpPath); } catch {}
      logger.log(`Manual backup completed: ${backupKey}`);
    } catch (err: any) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }

  private async checkDailyBackup(): Promise<void> {
    if (!this.cloudStorage.isConfigured()) return;
    if (!this.databasePath) return;

    const now = new Date();
    if (now.getHours() !== 0) return;

    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    if (this.lastBackupDate === todayStr) return;

    this.lastBackupDate = todayStr;

    const tmpPath = path.join(path.dirname(this.databasePath), `darkride-backup-${todayStr}.db`);

    try {
      // Use better-sqlite3's .backup() API
      const Database = (await import('better-sqlite3')).default;
      const sourceDb = new Database(this.databasePath, { readonly: true });
      await sourceDb.backup(tmpPath);
      sourceDb.close();

      const backupKey = `backups/darkride-${todayStr}.db`;
      await this.cloudStorage.upload(backupKey, tmpPath);

      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

      // Clean up old backups (> 7 days)
      const { files } = await this.cloudStorage.listObjects('backups/', '/');
      const cutoffDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      for (const file of files) {
        // Extract date from key: backups/darkride-YYYY-MM-DD.db
        const match = file.key.match(/darkride-(\d{4}-\d{2}-\d{2})\.db$/);
        if (match) {
          const backupDate = new Date(match[1]);
          if (backupDate < cutoffDate) {
            await this.cloudStorage.delete(file.key);
            logger.log(`Deleted old backup: ${file.key}`);
          }
        }
      }

      logger.log(`Daily backup completed: ${backupKey}`);
    } catch (err: any) {
      logger.error(`Daily backup failed: ${err.message}`);
      // Clean up temp file on error
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  async syncPinnedSessions(): Promise<{ pinnedSessions: number; screenshots: number; queued: number; alreadyTracked: number; missingOnDisk: number }> {
    const result = { pinnedSessions: 0, screenshots: 0, queued: 0, alreadyTracked: 0, missingOnDisk: 0 };
    if (!this.cloudStorage.isConfigured() || !this.screenshotPath) return result;

    const pinnedSessions = this.db.select({ id: automationSessions.id })
      .from(automationSessions)
      .where(eq(automationSessions.isPinned, true))
      .all();

    result.pinnedSessions = pinnedSessions.length;
    if (pinnedSessions.length === 0) return result;

    const pinnedIds = pinnedSessions.map(s => s.id);

    for (const sessionId of pinnedIds) {
      const sessionScreenshots = this.db.select()
        .from(screenshots)
        .where(eq(screenshots.sessionId, sessionId))
        .all();

      result.screenshots += sessionScreenshots.length;

      for (const ss of sessionScreenshots) {
        const cloudKey = `sessions/${sessionId}/${ss.filename}`;

        const existing = this.db.select()
          .from(cloudFiles)
          .where(eq(cloudFiles.cloudKey, cloudKey))
          .all();

        if (existing.length > 0) { result.alreadyTracked++; continue; }

        const localPath = safeJoinInside(this.screenshotPath!, ss.filename);
        try {
          const stat = fs.statSync(localPath);
          this.trackFile(localPath, cloudKey, 'session-screenshot', stat.size);
          result.queued++;
        } catch {
          result.missingOnDisk++;
        }
      }
    }

    if (result.queued > 0) {
      logger.log(`Session sync: queued ${result.queued} screenshot(s) from ${pinnedIds.length} pinned session(s) for upload`);
    }

    return result;
  }

  private getCacheBudgetMb(): number {
    try {
      const rows = this.db.select()
        .from(settings)
        .where(eq(settings.key, 'cloud_local_cache_mb'))
        .all();

      if (rows.length > 0) {
        const val = parseInt(rows[0].value, 10);
        if (!isNaN(val) && val > 0) return val;
      }
    } catch {
      // ignore
    }
    return DEFAULT_CACHE_BUDGET_MB;
  }
}
