import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { FileStorageService, isVersionSafeToEvict, type CloudStatus, type AcquireResult } from './file-storage';
import { createTestDb } from '../test-utils/create-test-db';
import type { AppDatabase } from '../db/index';

const { cloudFiles, settings, automationSessions, screenshots } = schema;

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

function createMockCloudStorage() {
  return {
    isConfigured: vi.fn().mockReturnValue(true),
    configure: vi.fn(),
    upload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    presignUrl: vi.fn().mockResolvedValue('https://example.com/signed'),
    headBucket: vi.fn().mockResolvedValue(undefined),
    listObjects: vi.fn().mockResolvedValue({ prefixes: [], files: [] }),
    getPresignCacheSize: vi.fn().mockReturnValue(0),
  } as any;
}

describe('FileStorageService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let mockCloud: ReturnType<typeof createMockCloudStorage>;
  let fileSync: FileStorageService;

  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let statSyncSpy: ReturnType<typeof vi.spyOn>;
  let unlinkSyncSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = createTestDb(undefined, { foreignKeys: true });
    mockCloud = createMockCloudStorage();
    fileSync = new FileStorageService(db, mockCloud);

    // Import fs dynamically and spy on methods
    const fs = await import('fs');
    existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(false);
    statSyncSpy = vi.spyOn(fs.default, 'statSync').mockReturnValue({ size: 0 } as any);
    unlinkSyncSpy = vi.spyOn(fs.default, 'unlinkSync').mockReturnValue(undefined);
    mkdirSyncSpy = vi.spyOn(fs.default, 'mkdirSync').mockReturnValue(undefined as any);
  });

  afterEach(() => {
    fileSync.stop();
    vi.restoreAllMocks();
  });

  // --- trackFile ---

  describe('trackFile', () => {
    it('inserts row with pending_upload state', () => {
      fileSync.trackFile('screenshots/shot.png', 'screenshots/shot.png', 'screenshot', 1024);

      const rows = db.select().from(cloudFiles).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].cloudKey).toBe('screenshots/shot.png');
      expect(rows[0].relativePath).toBe('screenshots/shot.png');
      expect(rows[0].fileType).toBe('screenshot');
      expect(rows[0].fileSize).toBe(1024);
      expect(rows[0].syncState).toBe('pending_upload');
      expect(rows[0].syncError).toBeNull();
    });

    it('does not re-queue if same cloudKey is already pending or synced', () => {
      fileSync.trackFile('screenshots/shot.png', 'screenshots/shot.png', 'screenshot', 1024);
      fileSync.trackFile('screenshots/shot-v2.png', 'screenshots/shot.png', 'screenshot', 2048);

      const rows = db.select().from(cloudFiles).all();
      expect(rows).toHaveLength(1);
      // Original pending_upload entry is preserved, not overwritten
      expect(rows[0].relativePath).toBe('screenshots/shot.png');
      expect(rows[0].fileSize).toBe(1024);
      expect(rows[0].syncState).toBe('pending_upload');
    });

    it('is a no-op when cloud is unconfigured', () => {
      mockCloud.isConfigured.mockReturnValue(false);

      fileSync.trackFile('screenshots/shot.png', 'screenshots/shot.png', 'screenshot', 1024);

      const rows = db.select().from(cloudFiles).all();
      expect(rows).toHaveLength(0);
    });
  });

  // --- acquireLocal ---

  describe('acquireLocal', () => {
    it('returns error for unknown cloudKey', async () => {
      const result = await fileSync.acquireLocal('nonexistent/key', 'holder1');
      expect(result.error).toBeDefined();
      expect(result.path).toBeUndefined();
    });

    it('returns path for locally available file', async () => {
      // Insert a synced file
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/file.bin',
        relativePath: '/data/test/file.bin',
        fileType: 'binary',
        fileSize: 5000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // Mock fs to say file exists with correct size
      existsSyncSpy.mockReturnValue(true);
      statSyncSpy.mockReturnValue({ size: 5000 } as any);

      const result = await fileSync.acquireLocal('test/file.bin', 'automation-runner');
      expect(result.error).toBeUndefined();
      expect(result.path).toBe('/data/test/file.bin');
    });

    // Regression: a cloud_only row whose local file reappeared (restored by a
    // path other than acquireLocal) kept syncState=cloud_only forever. The
    // evictor only ever selects syncState='synced', so those files became
    // invisible to both the budget accounting and eviction — 4.2 GB of them
    // were stranded on production.
    it('returns a reappeared cloud_only file to synced so it stays evictable', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/reappeared.bin',
        relativePath: '/data/test/reappeared.bin',
        fileType: 'binary',
        fileSize: 5000,
        syncState: 'cloud_only',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // File is present locally at the expected size — no download needed.
      existsSyncSpy.mockReturnValue(true);
      statSyncSpy.mockReturnValue({ size: 5000 } as any);

      const result = await fileSync.acquireLocal('test/reappeared.bin', 'apk-analyzer');
      expect(result.error).toBeUndefined();
      expect(mockCloud.download).not.toHaveBeenCalled();

      const row = db.select().from(cloudFiles)
        .where(eq(cloudFiles.cloudKey, 'test/reappeared.bin')).get();
      expect(row!.syncState).toBe('synced');
    });

    it('downloads from cloud when file is cloud_only', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/cloud-file.bin',
        relativePath: '/data/test/cloud-file.bin',
        fileType: 'binary',
        fileSize: 3000,
        syncState: 'cloud_only',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // File not local
      existsSyncSpy.mockReturnValue(false);
      mockCloud.download.mockResolvedValue({});

      const result = await fileSync.acquireLocal('test/cloud-file.bin', 'holder1');
      expect(result.error).toBeUndefined();
      expect(result.path).toBe('/data/test/cloud-file.bin');

      // Verify download was called
      expect(mockCloud.download).toHaveBeenCalledWith('test/cloud-file.bin', '/data/test/cloud-file.bin');

      // Verify state updated to synced
      const files = db.select().from(cloudFiles).all();
      expect(files[0].syncState).toBe('synced');
    });

    it('downloads from cloud when synced but local file missing', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/missing.bin',
        relativePath: '/data/test/missing.bin',
        fileType: 'binary',
        fileSize: 2000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // File doesn't exist locally
      existsSyncSpy.mockReturnValue(false);
      mockCloud.download.mockResolvedValue({});

      const result = await fileSync.acquireLocal('test/missing.bin', 'holder1');
      expect(result.error).toBeUndefined();
      expect(result.path).toBe('/data/test/missing.bin');
      expect(mockCloud.download).toHaveBeenCalled();
    });

    it('returns error when download fails', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/fail.bin',
        relativePath: '/data/test/fail.bin',
        fileType: 'binary',
        fileSize: 1000,
        syncState: 'cloud_only',
        lastAccessed: now,
        createdAt: now,
      }).run();

      existsSyncSpy.mockReturnValue(false);
      mockCloud.download.mockResolvedValue({ error: 'Access denied' });

      const result = await fileSync.acquireLocal('test/fail.bin', 'holder1');
      expect(result.error).toContain('Access denied');
      expect(result.path).toBeUndefined();
    });

    it('recovers untracked file from cloud when localPath provided', async () => {
      // No DB entry exists, but file is in cloud
      mockCloud.exists.mockResolvedValue(true);
      mockCloud.download.mockResolvedValue({});
      existsSyncSpy.mockReturnValue(true);
      statSyncSpy.mockReturnValue({ size: 8000 } as any);
      mkdirSyncSpy.mockReturnValue(undefined as any);

      // Use a path under DATA_ROOT so toRelativeLocalPath can derive the
      // relative form for storage.
      const { absoluteLocalPath } = await import('../config/paths');
      const absApkPath = absoluteLocalPath('apks/com.test/1_1.0.apk');
      const result = await fileSync.acquireLocal('apks/com.test/1_1.0.apk', 'analysis-job-1', absApkPath);
      expect(result.error).toBeUndefined();
      expect(result.path).toBe(absApkPath);

      // Verify cloud download was called
      expect(mockCloud.exists).toHaveBeenCalledWith('apks/com.test/1_1.0.apk');
      expect(mockCloud.download).toHaveBeenCalledWith('apks/com.test/1_1.0.apk', absApkPath);

      // Verify tracking entry was created
      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(1);
      expect(files[0].cloudKey).toBe('apks/com.test/1_1.0.apk');
      expect(files[0].relativePath).toBe('apks/com.test/1_1.0.apk');
      expect(files[0].syncState).toBe('synced');
      expect(files[0].fileSize).toBe(8000);
    });

    it('returns error for untracked file not in cloud', async () => {
      mockCloud.exists.mockResolvedValue(false);

      const result = await fileSync.acquireLocal('apks/missing/file.apk', 'holder', '/data/apks/missing/file.apk');
      expect(result.error).toContain('File not found');
    });

    it('returns error for untracked file without localPath', async () => {
      const result = await fileSync.acquireLocal('apks/missing/file.apk', 'holder');
      expect(result.error).toContain('File not found');
    });

    it('returns error when syncState=pending_upload and local file is missing', async () => {
      // Regression guard: an APK whose upload never completed can end up as
      // pending_upload with the local file gone (manual cleanup, disk fault,
      // etc.). acquireLocal previously returned { path } with no error even
      // though the file isn't there — callers then tried to read a dangling
      // path and failed far from the root cause.
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/orphaned.bin',
        relativePath: '/data/test/orphaned.bin',
        fileType: 'binary',
        fileSize: 4000,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();
      existsSyncSpy.mockReturnValue(false);

      const result = await fileSync.acquireLocal('test/orphaned.bin', 'holder1');
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/pending[_ -]upload/i);
      expect(result.path).toBeUndefined();
    });
  });

  // --- acquireLocalByPrefix ---

  describe('acquireLocalByPrefix', () => {
    it('returns error when no files match prefix', async () => {
      const result = await fileSync.acquireLocalByPrefix('apks/nonexistent/', 'test');
      expect(result.error).toBeDefined();
    });

    it('acquires all files matching prefix', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'apks/com.test/500/base.apk',
        relativePath: '/data/apks/com.test/500/base.apk',
        fileType: 'apk',
        fileSize: 1000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();
      db.insert(cloudFiles).values({
        cloudKey: 'apks/com.test/500/split_config.apk',
        relativePath: '/data/apks/com.test/500/split_config.apk',
        fileType: 'apk',
        fileSize: 2000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // Mock fs to say files exist with correct sizes
      existsSyncSpy.mockReturnValue(true);
      statSyncSpy.mockImplementation((p: any) => {
        if (p === '/data/apks/com.test/500/base.apk') return { size: 1000 } as any;
        if (p === '/data/apks/com.test/500/split_config.apk') return { size: 2000 } as any;
        return { size: 0 } as any;
      });

      const result = await fileSync.acquireLocalByPrefix('apks/com.test/500/', 'test-holder');
      expect(result.error).toBeUndefined();
    });

    it('returns error on partial failure', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'apks/com.fail/600/base.apk',
        relativePath: '/data/apks/com.fail/600/base.apk',
        fileType: 'apk',
        fileSize: 1000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();
      db.insert(cloudFiles).values({
        cloudKey: 'apks/com.fail/600/split.apk',
        relativePath: '/data/apks/com.fail/600/split.apk',
        fileType: 'apk',
        fileSize: 2000,
        syncState: 'cloud_only',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // First file exists locally, second needs cloud download which fails
      existsSyncSpy.mockImplementation((p: any) => {
        return p === '/data/apks/com.fail/600/base.apk';
      });
      statSyncSpy.mockReturnValue({ size: 1000 } as any);
      mockCloud.download.mockResolvedValue({ error: 'Network error' });

      const result = await fileSync.acquireLocalByPrefix('apks/com.fail/600/', 'test-holder');
      expect(result.error).toBeDefined();
    });
  });

  // --- getDirectUrl ---

  describe('getDirectUrl', () => {
    it('returns presigned URL from cloudStorage', async () => {
      const url = await fileSync.getDirectUrl('test/file.bin');
      expect(url).toBe('https://example.com/signed');
      expect(mockCloud.presignUrl).toHaveBeenCalledWith('test/file.bin');
    });

    it('returns null when cloud is unconfigured', async () => {
      mockCloud.presignUrl.mockResolvedValue(null);
      const url = await fileSync.getDirectUrl('test/file.bin');
      expect(url).toBeNull();
    });
  });

  // --- removeFile ---

  describe('removeFile', () => {
    it('deletes from cloud, local, and DB', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/remove-me.bin',
        relativePath: '/data/test/remove-me.bin',
        fileType: 'binary',
        fileSize: 1024,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      existsSyncSpy.mockReturnValue(true);

      await fileSync.removeFile('test/remove-me.bin');

      // Cloud delete called
      expect(mockCloud.delete).toHaveBeenCalledWith('test/remove-me.bin');

      // Local file delete called
      expect(unlinkSyncSpy).toHaveBeenCalledWith('/data/test/remove-me.bin');

      // DB rows deleted
      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(0);
    });

    it('is a no-op for non-existent cloudKey', async () => {
      await fileSync.removeFile('nonexistent/key');
      expect(mockCloud.delete).not.toHaveBeenCalled();
    });

    it('handles missing local file gracefully', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/gone.bin',
        relativePath: '/data/test/gone.bin',
        fileType: 'binary',
        fileSize: 512,
        syncState: 'cloud_only',
        lastAccessed: now,
        createdAt: now,
      }).run();

      existsSyncSpy.mockReturnValue(false);

      await fileSync.removeFile('test/gone.bin');

      expect(mockCloud.delete).toHaveBeenCalledWith('test/gone.bin');
      expect(unlinkSyncSpy).not.toHaveBeenCalled();

      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(0);
    });
  });

  // --- getStatus ---

  describe('getStatus', () => {
    it('returns correct summary with no files', () => {
      const status = fileSync.getStatus();
      expect(status.configured).toBe(true);
      expect(status.filesTracked).toBe(0);
      expect(status.filesCloudOnly).toBe(0);
      expect(status.pendingUploads).toBe(0);
      expect(status.errors).toEqual([]);
      expect(status.localCacheUsageMb).toBe(0);
      expect(status.localCacheBudgetMb).toBe(5000);
    });

    it('returns correct counts for mixed file states', () => {
      const now = new Date();

      // pending_upload
      db.insert(cloudFiles).values({
        cloudKey: 'a.bin', relativePath: '/data/a.bin', fileType: 'binary',
        fileSize: 1048576, syncState: 'pending_upload', lastAccessed: now, createdAt: now,
      }).run();

      // synced
      db.insert(cloudFiles).values({
        cloudKey: 'b.bin', relativePath: '/data/b.bin', fileType: 'binary',
        fileSize: 2097152, syncState: 'synced', lastAccessed: now, createdAt: now,
      }).run();

      // cloud_only
      db.insert(cloudFiles).values({
        cloudKey: 'c.bin', relativePath: '/data/c.bin', fileType: 'binary',
        fileSize: 524288, syncState: 'cloud_only', lastAccessed: now, createdAt: now,
      }).run();

      // with error
      db.insert(cloudFiles).values({
        cloudKey: 'd.bin', relativePath: '/data/d.bin', fileType: 'binary',
        fileSize: 1024, syncState: 'pending_upload',
        syncError: 'Upload failed', lastAccessed: now, createdAt: now,
      }).run();

      const status = fileSync.getStatus();
      expect(status.filesTracked).toBe(4);
      expect(status.filesCloudOnly).toBe(1);
      expect(status.pendingUploads).toBe(2);
      expect(status.errors).toHaveLength(1);
      expect(status.errors[0]).toEqual({ cloudKey: 'd.bin', error: 'Upload failed' });
      // Cache usage: pending_upload (1MB) + synced (2MB) + pending_upload (1KB) ≈ 3MB
      // cloud_only not counted
      expect(status.localCacheUsageMb).toBeGreaterThan(0);
    });

    it('returns configured false when cloud is unconfigured', () => {
      mockCloud.isConfigured.mockReturnValue(false);
      const status = fileSync.getStatus();
      expect(status.configured).toBe(false);
    });

    it('reads cache budget from settings table', () => {
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '2000' }).run();

      const status = fileSync.getStatus();
      expect(status.localCacheBudgetMb).toBe(2000);
    });

    it('uses default cache budget when setting is missing', () => {
      const status = fileSync.getStatus();
      expect(status.localCacheBudgetMb).toBe(5000);
    });
  });

  // --- processUploadQueue (via start/stop) ---

  describe('processUploadQueue', () => {
    it('uploads pending files and sets state to synced', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'upload/test.bin',
        relativePath: '/data/upload/test.bin',
        fileType: 'binary',
        fileSize: 1000,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // Call processUploadQueue directly via the private method
      await (fileSync as any).processUploadQueue();

      expect(mockCloud.upload).toHaveBeenCalledWith('upload/test.bin', '/data/upload/test.bin');

      const files = db.select().from(cloudFiles).all();
      expect(files[0].syncState).toBe('synced');
      expect(files[0].syncError).toBeNull();
    });

    it('sets syncError on upload failure', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'upload/fail.bin',
        relativePath: '/data/upload/fail.bin',
        fileType: 'binary',
        fileSize: 1000,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();

      mockCloud.upload.mockRejectedValue(new Error('Network error'));

      await (fileSync as any).processUploadQueue();

      const files = db.select().from(cloudFiles).all();
      expect(files[0].syncState).toBe('pending_upload');
      expect(files[0].syncError).toBe('Network error');
    });

    it('does nothing when cloud is unconfigured', async () => {
      mockCloud.isConfigured.mockReturnValue(false);

      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'upload/skip.bin',
        relativePath: '/data/upload/skip.bin',
        fileType: 'binary',
        fileSize: 1000,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();

      await (fileSync as any).processUploadQueue();

      expect(mockCloud.upload).not.toHaveBeenCalled();
    });
  });

  // --- runEviction ---

  describe('runEviction', () => {
    it('evicts unlocked synced files when over budget', async () => {
      // Set a very small budget
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      const now = new Date();
      const olderDate = new Date(now.getTime() - 86400000); // 1 day ago

      // Insert 2 synced files totaling more than 1MB
      db.insert(cloudFiles).values({
        cloudKey: 'evict/old.bin',
        relativePath: '/data/evict/old.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();

      db.insert(cloudFiles).values({
        cloudKey: 'evict/new.bin',
        relativePath: '/data/evict/new.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      existsSyncSpy.mockReturnValue(true);

      await (fileSync as any).runEviction();

      const files = db.select().from(cloudFiles).all();
      // The older file should be evicted (cloud_only), newer kept (synced)
      const oldFile = files.find(f => f.cloudKey === 'evict/old.bin');
      const newFile = files.find(f => f.cloudKey === 'evict/new.bin');
      expect(oldFile!.syncState).toBe('cloud_only');
      expect(newFile!.syncState).toBe('synced');
    });

    // Regression: on production every APK was permanently un-evictable because
    // nothing ever registers analysis/<vc>/source.db or metadata.json in
    // cloud_files. isVersionSafeToEvict treated "artifact untracked" the same
    // as "artifact mid-upload" and returned false forever, so the evictor
    // logged 107k skips over 48h and freed nothing while the disk hit 96%.
    it('evicts a synced APK whose analysis artifacts were never tracked', async () => {
      const trackedAppResult = db.insert(schema.trackedApps).values({
        packageName: 'com.untracked.analysis',
        appName: 'Untracked Analysis',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).run();
      db.insert(schema.apkVersions).values({
        trackedAppId: Number(trackedAppResult.lastInsertRowid),
        versionCode: 7,
        versionName: '0.7',
        filename: '7_0.7.apk',
        downloadedAt: new Date(),
      }).run();

      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();
      const olderDate = new Date(Date.now() - 86400000);
      db.insert(cloudFiles).values({
        cloudKey: 'apks/com.untracked.analysis/7_0.7.apk',
        relativePath: 'apks/com.untracked.analysis/7_0.7.apk',
        fileType: 'apk',
        fileSize: 10 * 1024 * 1024,
        syncState: 'synced',
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();
      // Deliberately NO analysis rows — this is the production state.

      existsSyncSpy.mockReturnValue(true);

      await (fileSync as any).runEviction();

      const row = db.select().from(cloudFiles)
        .where(eq(cloudFiles.cloudKey, 'apks/com.untracked.analysis/7_0.7.apk')).get();
      expect(row!.syncState).toBe('cloud_only');
    });

    // The original race this gate was built for must still hold: a genuinely
    // tracked-but-unuploaded source.db still blocks eviction of its APK.
    it('does not evict an APK whose tracked analysis artifact is still uploading', async () => {
      const trackedAppResult = db.insert(schema.trackedApps).values({
        packageName: 'com.pending.analysis',
        appName: 'Pending Analysis',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).run();
      db.insert(schema.apkVersions).values({
        trackedAppId: Number(trackedAppResult.lastInsertRowid),
        versionCode: 9,
        versionName: '0.9',
        filename: '9_0.9.apk',
        downloadedAt: new Date(),
      }).run();

      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();
      const olderDate = new Date(Date.now() - 86400000);
      db.insert(cloudFiles).values({
        cloudKey: 'apks/com.pending.analysis/9_0.9.apk',
        relativePath: 'apks/com.pending.analysis/9_0.9.apk',
        fileType: 'apk',
        fileSize: 10 * 1024 * 1024,
        syncState: 'synced',
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();
      db.insert(cloudFiles).values({
        cloudKey: 'apks/com.pending.analysis/analysis/9/source.db',
        relativePath: 'apks/com.pending.analysis/analysis/9/source.db',
        fileType: 'analysis',
        fileSize: 1000,
        syncState: 'pending_upload',
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();

      existsSyncSpy.mockReturnValue(true);

      await (fileSync as any).runEviction();

      const row = db.select().from(cloudFiles)
        .where(eq(cloudFiles.cloudKey, 'apks/com.pending.analysis/9_0.9.apk')).get();
      expect(row!.syncState).toBe('synced');
    });

    // A cloud_only row whose local file is still on disk is invisible to both
    // the budget total and the eviction loop. Production had 101 such rows
    // holding 4.2 GB. Eviction reconciles them back to 'synced' first so the
    // cache heals itself instead of needing a manual sweep.
    it('reclaims cloud_only rows whose local file is still on disk', async () => {
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      const olderDate = new Date(Date.now() - 86400000);
      db.insert(cloudFiles).values({
        cloudKey: 'evict/stranded.bin',
        relativePath: 'evict/stranded.bin',
        fileType: 'binary',
        fileSize: 4 * 1024 * 1024,
        syncState: 'cloud_only',
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();

      existsSyncSpy.mockReturnValue(true);
      statSyncSpy.mockReturnValue({ size: 4 * 1024 * 1024 } as any);

      await (fileSync as any).runEviction();

      // Reclaimed into the evictable pool, then evicted (over the 1MB budget),
      // which is what actually frees the disk space.
      const row = db.select().from(cloudFiles)
        .where(eq(cloudFiles.cloudKey, 'evict/stranded.bin')).get();
      expect(row!.syncState).toBe('cloud_only');
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it('leaves cloud_only rows alone when the local file is genuinely gone', async () => {
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      db.insert(cloudFiles).values({
        cloudKey: 'evict/really-gone.bin',
        relativePath: 'evict/really-gone.bin',
        fileType: 'binary',
        fileSize: 4 * 1024 * 1024,
        syncState: 'cloud_only',
        lastAccessed: new Date(),
        createdAt: new Date(),
      }).run();

      existsSyncSpy.mockReturnValue(false);

      await (fileSync as any).runEviction();

      const row = db.select().from(cloudFiles)
        .where(eq(cloudFiles.cloudKey, 'evict/really-gone.bin')).get();
      expect(row!.syncState).toBe('cloud_only');
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('does not evict retained files', async () => {
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '0' }).run();

      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'evict/retained.bin',
        relativePath: '/data/evict/retained.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        retain: true,
        lastAccessed: now,
        createdAt: now,
      }).run();

      await (fileSync as any).runEviction();

      const files = db.select().from(cloudFiles).all();
      // Should still be synced since it's retained
      expect(files[0].syncState).toBe('synced');
    });

    it('does nothing when under budget', async () => {
      // Default budget is 5000 MB, so tiny files won't trigger eviction
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'evict/small.bin',
        relativePath: '/data/evict/small.bin',
        fileType: 'binary',
        fileSize: 100,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      await (fileSync as any).runEviction();

      const files = db.select().from(cloudFiles).all();
      expect(files[0].syncState).toBe('synced');
    });

    it('removes the analysis dir when an apks/ row is evicted', async () => {
      // Seed a tracked app + version so cleanupEvictedApkAnalysisDir can map
      // the cloud key back to a versionCode.
      const trackedAppResult = db.insert(schema.trackedApps).values({
        packageName: 'com.evict.apk',
        appName: 'Evict Test',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).run();
      const trackedAppId = Number(trackedAppResult.lastInsertRowid);
      db.insert(schema.apkVersions).values({
        trackedAppId,
        versionCode: 42,
        versionName: '4.2',
        filename: '42_4.2.apk',
        downloadedAt: new Date(),
      }).run();

      // Restore real fs for this test — it needs to observe actual directory state
      mkdirSyncSpy.mockRestore();
      existsSyncSpy.mockRestore();
      unlinkSyncSpy.mockRestore();
      statSyncSpy.mockRestore();

      const fsReal = (await import('fs')).default;
      const pathReal = (await import('path')).default;
      const os = (await import('os')).default;
      const tmpRoot = fsReal.mkdtempSync(pathReal.join(os.tmpdir(), 'evict-analysis-'));
      const origCwd = process.cwd();
      process.chdir(tmpRoot);
      try {
        const analysisDirPath = pathReal.resolve('./data/apks/com.evict.apk/analysis/42');
        fsReal.mkdirSync(analysisDirPath, { recursive: true });
        fsReal.writeFileSync(pathReal.join(analysisDirPath, 'source.db'), 'analysis-output');

        // Tiny budget + file well over it → eviction picks this row up
        db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();
        const olderDate = new Date(Date.now() - 86400000);
        db.insert(cloudFiles).values({
          cloudKey: 'apks/com.evict.apk/42_4.2.apk',
          relativePath: pathReal.resolve('./data/apks/com.evict.apk/42_4.2.apk'),
          fileType: 'apk',
          fileSize: 10 * 1024 * 1024,
          syncState: 'synced',
          lastAccessed: olderDate,
          createdAt: olderDate,
        }).run();
        // Seed the analysis artifacts as synced so isVersionSafeToEvict returns true
        const now = new Date();
        db.insert(cloudFiles).values({
          cloudKey: 'apks/com.evict.apk/analysis/42/source.db',
          relativePath: pathReal.resolve('./data/apks/com.evict.apk/analysis/42/source.db'),
          fileType: 'analysis',
          fileSize: 1000,
          syncState: 'synced',
          lastAccessed: now,
          createdAt: now,
        }).run();
        db.insert(cloudFiles).values({
          cloudKey: 'apks/com.evict.apk/analysis/42/metadata.json',
          relativePath: pathReal.resolve('./data/apks/com.evict.apk/analysis/42/metadata.json'),
          fileType: 'analysis',
          fileSize: 500,
          syncState: 'synced',
          lastAccessed: now,
          createdAt: now,
        }).run();

        await (fileSync as any).runEviction();

        expect(fsReal.existsSync(analysisDirPath)).toBe(false);
      } finally {
        process.chdir(origCwd);
        fsReal.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  // --- syncPinnedSessions ---

  describe('syncPinnedSessions', () => {
    it('tracks screenshots from pinned sessions', async () => {
      const { getDataRoot } = await import('../config/paths');
      const DATA_ROOT = getDataRoot();
      const screenshotDir = path.join(DATA_ROOT, 'screenshots');
      const fsWithPath = new FileStorageService(db, mockCloud, undefined, screenshotDir);
      const now = new Date();

      // Create a pinned session with a screenshot
      db.insert(automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        isPinned: true,
        startedAt: now,
      }).run();

      db.insert(screenshots).values({
        sessionId: 1,
        filename: '1_1234_test.png',
        capturedAt: now,
      }).run();

      // Mock fs: file exists with known size
      existsSyncSpy.mockReturnValue(true);
      statSyncSpy.mockReturnValue({ size: 5000 } as any);

      await (fsWithPath as any).syncPinnedSessions();

      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(1);
      expect(files[0].cloudKey).toBe('sessions/1/1_1234_test.png');
      expect(files[0].relativePath).toBe('screenshots/1_1234_test.png');
      expect(files[0].fileType).toBe('session-screenshot');
      expect(files[0].fileSize).toBe(5000);
      expect(files[0].syncState).toBe('pending_upload');

      fsWithPath.stop();
    });

    it('skips unpinned sessions', async () => {
      const fsWithPath = new FileStorageService(db, mockCloud, undefined, '/data/screenshots');
      const now = new Date();

      db.insert(automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        isPinned: false,
        startedAt: now,
      }).run();

      db.insert(screenshots).values({
        sessionId: 1,
        filename: '1_1234_test.png',
        capturedAt: now,
      }).run();

      statSyncSpy.mockReturnValue({ size: 5000 } as any);

      await (fsWithPath as any).syncPinnedSessions();

      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(0);

      fsWithPath.stop();
    });

    it('skips already-tracked screenshots', async () => {
      const fsWithPath = new FileStorageService(db, mockCloud, undefined, '/data/screenshots');
      const now = new Date();

      db.insert(automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        isPinned: true,
        startedAt: now,
      }).run();

      db.insert(screenshots).values({
        sessionId: 1,
        filename: '1_1234_test.png',
        capturedAt: now,
      }).run();

      // Pre-track the file
      db.insert(cloudFiles).values({
        cloudKey: 'sessions/1/1_1234_test.png',
        relativePath: '/data/screenshots/1_1234_test.png',
        fileType: 'session-screenshot',
        fileSize: 5000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      statSyncSpy.mockReturnValue({ size: 5000 } as any);

      await (fsWithPath as any).syncPinnedSessions();

      // Still only 1 row — no duplicate
      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(1);

      fsWithPath.stop();
    });

    it('skips when screenshotPath not set', async () => {
      // fileSync has no screenshotPath
      await (fileSync as any).syncPinnedSessions();
      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(0);
    });

    it('skips when cloud is unconfigured', async () => {
      mockCloud.isConfigured.mockReturnValue(false);
      const fsWithPath = new FileStorageService(db, mockCloud, undefined, '/data/screenshots');
      const now = new Date();

      db.insert(automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        isPinned: true,
        startedAt: now,
      }).run();

      db.insert(screenshots).values({
        sessionId: 1,
        filename: '1_1234_test.png',
        capturedAt: now,
      }).run();

      await (fsWithPath as any).syncPinnedSessions();

      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(0);

      fsWithPath.stop();
    });

    it('handles missing screenshot file gracefully', async () => {
      const fsWithPath = new FileStorageService(db, mockCloud, undefined, '/data/screenshots');
      const now = new Date();

      db.insert(automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        isPinned: true,
        startedAt: now,
      }).run();

      db.insert(screenshots).values({
        sessionId: 1,
        filename: '1_1234_missing.png',
        capturedAt: now,
      }).run();

      // statSync throws for missing file
      statSyncSpy.mockImplementation(() => { throw new Error('ENOENT'); });

      await (fsWithPath as any).syncPinnedSessions();

      // No file tracked since it's missing on disk
      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(0);

      fsWithPath.stop();
    });
  });

  // --- retryUpload ---

  describe('retryUpload', () => {
    it('clears syncError for the given cloudKey', () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'retry/fail.bin',
        relativePath: '/data/retry/fail.bin',
        fileType: 'binary',
        fileSize: 1000,
        syncState: 'pending_upload',
        syncError: 'Connection timeout',
        lastAccessed: now,
        createdAt: now,
      }).run();

      fileSync.retryUpload('retry/fail.bin');

      const files = db.select().from(cloudFiles).all();
      expect(files[0].syncError).toBeNull();
      expect(files[0].syncState).toBe('pending_upload');
    });

    it('is a no-op for unknown cloudKey', () => {
      // Should not throw
      expect(() => fileSync.retryUpload('does/not/exist.bin')).not.toThrow();
    });
  });

  // --- forPlugin / forNamespace ---

  describe('forPlugin', () => {
    it('returns a NamespacedStorageImpl with correct localRoot and cloudKeyPrefix', () => {
      const ns = fileSync.forPlugin('maps');
      // NamespacedStorageImpl exposes namespace via url() helper
      expect(ns.url('test.json')).toBe('/v1/files/maps/test.json');
      // mkdirSync should have been called for ./data/plugins/maps/
      expect(mkdirSyncSpy).toHaveBeenCalled();
      const calledPath = mkdirSyncSpy.mock.calls[0][0] as string;
      expect(calledPath).toContain(path.join('data', 'plugins', 'maps'));
    });

    it('creates directory if it does not exist', () => {
      existsSyncSpy.mockReturnValue(false);
      fileSync.forPlugin('new-plugin');
      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(path.join('data', 'plugins', 'new-plugin')),
        { recursive: true },
      );
    });

    it('skips mkdir when directory already exists', () => {
      existsSyncSpy.mockReturnValue(true);
      fileSync.forPlugin('existing-plugin');
      expect(mkdirSyncSpy).not.toHaveBeenCalled();
    });
  });

  describe('forNamespace', () => {
    it('returns a NamespacedStorageImpl with correct localRoot and cloudKeyPrefix', () => {
      const ns = fileSync.forNamespace('apks');
      expect(ns.url('com.test/1.apk')).toBe('/v1/files/apks/com.test/1.apk');
      expect(mkdirSyncSpy).toHaveBeenCalled();
      const calledPath = mkdirSyncSpy.mock.calls[0][0] as string;
      expect(calledPath).toContain(path.join('data', 'apks'));
    });

    it('creates directory if it does not exist', () => {
      existsSyncSpy.mockReturnValue(false);
      fileSync.forNamespace('screenshots');
      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(path.join('data', 'screenshots')),
        { recursive: true },
      );
    });

    it('skips mkdir when directory already exists', () => {
      existsSyncSpy.mockReturnValue(true);
      fileSync.forNamespace('apks');
      expect(mkdirSyncSpy).not.toHaveBeenCalled();
    });
  });

  // --- processUploadQueue (additional coverage) ---

  describe('processUploadQueue (additional)', () => {
    it('prevents concurrent runs via uploadRunning flag', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'concurrent/a.bin',
        relativePath: '/data/concurrent/a.bin',
        fileType: 'binary',
        fileSize: 1000,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // Simulate a slow upload that takes time
      let resolveUpload: () => void;
      const uploadPromise = new Promise<void>(resolve => { resolveUpload = resolve; });
      mockCloud.upload.mockImplementation(async () => {
        await uploadPromise;
        return undefined;
      });

      // Start first run — it will block on the upload
      const firstRun = (fileSync as any).processUploadQueue();

      // Start second run while first is still running
      const secondRun = (fileSync as any).processUploadQueue();

      // Second run should complete immediately (skipped due to uploadRunning)
      await secondRun;

      // Upload should only have been called once (from first run)
      expect(mockCloud.upload).toHaveBeenCalledTimes(1);

      // Resolve the upload so first run finishes
      resolveUpload!();
      await firstRun;
    });

    it('uploads multiple pending files in sequence', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'batch/a.bin',
        relativePath: '/data/batch/a.bin',
        fileType: 'binary',
        fileSize: 500,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();
      db.insert(cloudFiles).values({
        cloudKey: 'batch/b.bin',
        relativePath: '/data/batch/b.bin',
        fileType: 'binary',
        fileSize: 800,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();

      await (fileSync as any).processUploadQueue();

      expect(mockCloud.upload).toHaveBeenCalledTimes(2);
      expect(mockCloud.upload).toHaveBeenCalledWith('batch/a.bin', '/data/batch/a.bin');
      expect(mockCloud.upload).toHaveBeenCalledWith('batch/b.bin', '/data/batch/b.bin');

      const files = db.select().from(cloudFiles).all();
      expect(files.every(f => f.syncState === 'synced')).toBe(true);
    });

    it('continues uploading remaining files when one fails', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'partial/a.bin',
        relativePath: '/data/partial/a.bin',
        fileType: 'binary',
        fileSize: 500,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();
      db.insert(cloudFiles).values({
        cloudKey: 'partial/b.bin',
        relativePath: '/data/partial/b.bin',
        fileType: 'binary',
        fileSize: 800,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // First upload fails, second succeeds
      mockCloud.upload
        .mockRejectedValueOnce(new Error('Disk read error'))
        .mockResolvedValueOnce(undefined);

      await (fileSync as any).processUploadQueue();

      const files = db.select().from(cloudFiles).all();
      const fileA = files.find(f => f.cloudKey === 'partial/a.bin')!;
      const fileB = files.find(f => f.cloudKey === 'partial/b.bin')!;
      expect(fileA.syncState).toBe('pending_upload');
      expect(fileA.syncError).toBe('Disk read error');
      expect(fileB.syncState).toBe('synced');
      expect(fileB.syncError).toBeNull();
    });

    it('resets uploadRunning flag even when an error occurs', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'flag/test.bin',
        relativePath: '/data/flag/test.bin',
        fileType: 'binary',
        fileSize: 100,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();

      mockCloud.upload.mockRejectedValue(new Error('Transient error'));

      await (fileSync as any).processUploadQueue();

      // uploadRunning should be reset so a subsequent run works
      expect((fileSync as any).uploadRunning).toBe(false);

      // A second call should work (not be blocked by stale flag)
      mockCloud.upload.mockResolvedValue(undefined);
      await (fileSync as any).processUploadQueue();
      // Upload called once more for the retry
      expect(mockCloud.upload).toHaveBeenCalledTimes(2);
    });

    it('skips non-pending files', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'synced/a.bin',
        relativePath: '/data/synced/a.bin',
        fileType: 'binary',
        fileSize: 500,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();
      db.insert(cloudFiles).values({
        cloudKey: 'co/b.bin',
        relativePath: '/data/co/b.bin',
        fileType: 'binary',
        fileSize: 500,
        syncState: 'cloud_only',
        lastAccessed: now,
        createdAt: now,
      }).run();

      await (fileSync as any).processUploadQueue();

      expect(mockCloud.upload).not.toHaveBeenCalled();
    });
  });

  // --- runEviction (additional coverage) ---

  describe('runEviction (additional)', () => {
    it('only evicts synced files, not pending_upload', async () => {
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      const now = new Date();
      const olderDate = new Date(now.getTime() - 86400000);

      // pending_upload file — should NOT be evicted (eviction only queries synced)
      db.insert(cloudFiles).values({
        cloudKey: 'evict/pending.bin',
        relativePath: '/data/evict/pending.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'pending_upload',
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();

      // Two synced files totaling > 1 MB — eviction triggered
      db.insert(cloudFiles).values({
        cloudKey: 'evict/synced-old.bin',
        relativePath: '/data/evict/synced-old.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();

      db.insert(cloudFiles).values({
        cloudKey: 'evict/synced-new.bin',
        relativePath: '/data/evict/synced-new.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      existsSyncSpy.mockReturnValue(true);

      await (fileSync as any).runEviction();

      const files = db.select().from(cloudFiles).all();
      const pending = files.find(f => f.cloudKey === 'evict/pending.bin')!;
      const syncedOld = files.find(f => f.cloudKey === 'evict/synced-old.bin')!;
      // pending_upload is untouched — eviction only considers synced files
      expect(pending.syncState).toBe('pending_upload');
      // older synced file gets evicted
      expect(syncedOld.syncState).toBe('cloud_only');
    });

    it('stops evicting once under budget (does not evict all synced files)', async () => {
      // Budget: 1 MB = 1048576 bytes
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      const now = new Date();

      // 3 synced files: 500KB each = 1.5 MB total (over 1 MB budget)
      // Evicting just the oldest one brings us to 1.0 MB = under budget
      db.insert(cloudFiles).values({
        cloudKey: 'evict/oldest.bin',
        relativePath: '/data/evict/oldest.bin',
        fileType: 'binary',
        fileSize: 524288, // 512 KB
        syncState: 'synced',
        lastAccessed: new Date(now.getTime() - 300000), // oldest
        createdAt: now,
      }).run();

      db.insert(cloudFiles).values({
        cloudKey: 'evict/middle.bin',
        relativePath: '/data/evict/middle.bin',
        fileType: 'binary',
        fileSize: 524288,
        syncState: 'synced',
        lastAccessed: new Date(now.getTime() - 100000), // middle
        createdAt: now,
      }).run();

      db.insert(cloudFiles).values({
        cloudKey: 'evict/newest.bin',
        relativePath: '/data/evict/newest.bin',
        fileType: 'binary',
        fileSize: 524288,
        syncState: 'synced',
        lastAccessed: now, // newest
        createdAt: now,
      }).run();

      existsSyncSpy.mockReturnValue(true);

      await (fileSync as any).runEviction();

      const files = db.select().from(cloudFiles).all();
      const oldest = files.find(f => f.cloudKey === 'evict/oldest.bin')!;
      const middle = files.find(f => f.cloudKey === 'evict/middle.bin')!;
      const newest = files.find(f => f.cloudKey === 'evict/newest.bin')!;

      // Only the oldest should be evicted (brings total from 1.5MB to ~1.0MB)
      expect(oldest.syncState).toBe('cloud_only');
      expect(middle.syncState).toBe('synced');
      expect(newest.syncState).toBe('synced');
    });

    it('deletes local file on eviction', async () => {
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      const now = new Date();
      const olderDate = new Date(now.getTime() - 86400000);

      // Two synced files totaling > 1 MB to trigger eviction
      db.insert(cloudFiles).values({
        cloudKey: 'evict/delete-local.bin',
        relativePath: '/data/evict/delete-local.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();
      db.insert(cloudFiles).values({
        cloudKey: 'evict/keep.bin',
        relativePath: '/data/evict/keep.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      existsSyncSpy.mockReturnValue(true);

      await (fileSync as any).runEviction();

      // Oldest file's local copy should be deleted
      expect(unlinkSyncSpy).toHaveBeenCalledWith('/data/evict/delete-local.bin');
    });

    it('handles missing local file gracefully during eviction', async () => {
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      const now = new Date();
      const olderDate = new Date(now.getTime() - 86400000);

      // Two synced files totaling > 1 MB to trigger eviction
      db.insert(cloudFiles).values({
        cloudKey: 'evict/missing-local.bin',
        relativePath: '/data/evict/missing-local.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();
      db.insert(cloudFiles).values({
        cloudKey: 'evict/other.bin',
        relativePath: '/data/evict/other.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // Local file does not exist
      existsSyncSpy.mockReturnValue(false);

      // Should not throw
      await (fileSync as any).runEviction();

      // Oldest file still gets marked as cloud_only even though local file was already gone
      const files = db.select().from(cloudFiles).all();
      const missing = files.find(f => f.cloudKey === 'evict/missing-local.bin')!;
      expect(missing.syncState).toBe('cloud_only');
      // unlinkSync should not be called since existsSync returns false
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('evicts multiple files in LRU order when all need eviction', async () => {
      // Budget 1 MB; three files of 600KB each = 1.8 MB, must evict at least 2 to get under 1 MB
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'evict/oldest.bin',
        relativePath: '/data/evict/oldest.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: new Date(now.getTime() - 200000), // oldest
        createdAt: now,
      }).run();

      db.insert(cloudFiles).values({
        cloudKey: 'evict/middle.bin',
        relativePath: '/data/evict/middle.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: new Date(now.getTime() - 100000), // middle
        createdAt: now,
      }).run();

      db.insert(cloudFiles).values({
        cloudKey: 'evict/newest.bin',
        relativePath: '/data/evict/newest.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        lastAccessed: now, // newest
        createdAt: now,
      }).run();

      existsSyncSpy.mockReturnValue(true);

      await (fileSync as any).runEviction();

      const files = db.select().from(cloudFiles).all();
      const oldest = files.find(f => f.cloudKey === 'evict/oldest.bin')!;
      const middle = files.find(f => f.cloudKey === 'evict/middle.bin')!;
      const newest = files.find(f => f.cloudKey === 'evict/newest.bin')!;

      // oldest evicted first, then middle — LRU order
      expect(oldest.syncState).toBe('cloud_only');
      expect(middle.syncState).toBe('cloud_only');
      // newest kept since remaining 600KB < 1MB budget
      expect(newest.syncState).toBe('synced');
    });

    it('does not evict retained files even when all others are evicted', async () => {
      // Budget 1 MB; two files totaling > 1 MB
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      const now = new Date();
      const olderDate = new Date(now.getTime() - 86400000);

      // Retained file — oldest, but should be kept despite eviction pressure
      db.insert(cloudFiles).values({
        cloudKey: 'evict/retained.bin',
        relativePath: '/data/evict/retained.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        retain: true,
        lastAccessed: olderDate,
        createdAt: olderDate,
      }).run();

      // Non-retained file — newer, but should be evicted to make room
      db.insert(cloudFiles).values({
        cloudKey: 'evict/evictable.bin',
        relativePath: '/data/evict/evictable.bin',
        fileType: 'binary',
        fileSize: 600000,
        syncState: 'synced',
        retain: false,
        lastAccessed: now,
        createdAt: now,
      }).run();

      existsSyncSpy.mockReturnValue(true);

      await (fileSync as any).runEviction();

      const files = db.select().from(cloudFiles).all();
      const retained = files.find(f => f.cloudKey === 'evict/retained.bin')!;
      const evictable = files.find(f => f.cloudKey === 'evict/evictable.bin')!;
      expect(retained.syncState).toBe('synced');
      expect(evictable.syncState).toBe('cloud_only');
    });

    it('does not evict cloud_only files', async () => {
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '0' }).run();

      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'evict/already-cloud.bin',
        relativePath: '/data/evict/already-cloud.bin',
        fileType: 'binary',
        fileSize: 1000,
        syncState: 'cloud_only',
        lastAccessed: now,
        createdAt: now,
      }).run();

      await (fileSync as any).runEviction();

      // Should remain cloud_only (not re-processed)
      const files = db.select().from(cloudFiles).all();
      expect(files[0].syncState).toBe('cloud_only');
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });
  });

  // --- trackFile (additional coverage) ---

  describe('trackFile (additional)', () => {
    it('re-queues a cloud_only file as pending_upload with updated metadata', () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'requeue/file.bin',
        relativePath: 'old/path.bin',
        fileType: 'binary',
        fileSize: 100,
        syncState: 'cloud_only',
        lastAccessed: now,
        createdAt: now,
      }).run();

      fileSync.trackFile('new/path.bin', 'requeue/file.bin', 'apk', 2048);

      const files = db.select().from(cloudFiles).all();
      expect(files).toHaveLength(1);
      expect(files[0].syncState).toBe('pending_upload');
      expect(files[0].relativePath).toBe('new/path.bin');
      expect(files[0].fileType).toBe('apk');
      expect(files[0].fileSize).toBe(2048);
      expect(files[0].syncError).toBeNull();
    });
  });

  // --- Unconfigured cloud behavior ---

  describe('unconfigured cloud', () => {
    let unconfiguredFileSync: FileStorageService;

    beforeEach(() => {
      const unconfiguredCloud = createMockCloudStorage();
      unconfiguredCloud.isConfigured.mockReturnValue(false);
      unconfiguredFileSync = new FileStorageService(db, unconfiguredCloud);
    });

    afterEach(() => {
      unconfiguredFileSync.stop();
    });

    it('processUploadQueue skips when cloud not configured', async () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'nocloud/a.bin',
        relativePath: '/data/nocloud/a.bin',
        fileType: 'binary',
        fileSize: 500,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();

      await (unconfiguredFileSync as any).processUploadQueue();

      // File should remain pending — upload never attempted
      const files = db.select().from(cloudFiles).all();
      expect(files[0].syncState).toBe('pending_upload');
    });

    it('runEviction has nothing to evict when cloud not configured', async () => {
      // Without cloud, nothing gets to 'synced' state via upload queue,
      // but we can still test that eviction doesn't crash with pending files
      db.insert(settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'nocloud/pending.bin',
        relativePath: '/data/nocloud/pending.bin',
        fileType: 'binary',
        fileSize: 2000000,
        syncState: 'pending_upload',
        lastAccessed: now,
        createdAt: now,
      }).run();

      // Should not throw — eviction only targets synced files
      await (unconfiguredFileSync as any).runEviction();

      const files = db.select().from(cloudFiles).all();
      expect(files[0].syncState).toBe('pending_upload');
    });
  });

  // --- start / stop ---

  describe('start / stop', () => {
    it('start creates interval timers and stop clears them', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      fileSync.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(4);

      fileSync.stop();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(4);
    });

    it('stop is safe to call multiple times', () => {
      fileSync.start();
      fileSync.stop();
      fileSync.stop(); // should not throw
    });

    it('stop is safe to call without start', () => {
      fileSync.stop(); // should not throw
    });
  });

  // --- FileStorageService relative paths ---

  describe('FileStorageService relative paths', () => {
    let relDb: BetterSQLite3Database<typeof schema>;
    let relCloud: ReturnType<typeof createMockCloudStorage>;
    let relSvc: FileStorageService;

    beforeEach(() => {
      relDb = createTestDb(undefined, { foreignKeys: true });
      relCloud = createMockCloudStorage();
      relSvc = new FileStorageService(relDb, relCloud);
    });

    afterEach(() => {
      relSvc.stop();
      vi.restoreAllMocks();
    });

    it('stores relative local_path when given an absolute path under DATA_ROOT', async () => {
      const { getDataRoot } = await import('../config/paths');
      const DATA_ROOT = getDataRoot();
      const abs = path.join(DATA_ROOT, 'apks/pkg/x.apk');
      relSvc.trackFile(abs, 'apks/pkg/x.apk', 'apk', 123);
      const row = relDb.select().from(cloudFiles).where(eq(cloudFiles.cloudKey, 'apks/pkg/x.apk')).all()[0];
      expect(row.relativePath).toBe('apks/pkg/x.apk');
    });

    it('stores relative local_path when given a relative path', () => {
      relSvc.trackFile('apks/pkg/y.apk', 'apks/pkg/y.apk', 'apk', 123);
      const row = relDb.select().from(cloudFiles).where(eq(cloudFiles.cloudKey, 'apks/pkg/y.apk')).all()[0];
      expect(row.relativePath).toBe('apks/pkg/y.apk');
    });

    it('acquireLocal resolves stored relative path against DATA_ROOT on read', async () => {
      const { getDataRoot } = await import('../config/paths');
      const DATA_ROOT = getDataRoot();
      // Restore real fs so we can create a real file on disk.
      existsSyncSpy.mockRestore();
      statSyncSpy.mockRestore();
      mkdirSyncSpy.mockRestore();
      unlinkSyncSpy.mockRestore();
      const abs = path.join(DATA_ROOT, 'apks/pkg/z.apk');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'test');
      try {
        const stat = fs.statSync(abs);
        relSvc.trackFile(abs, 'apks/pkg/z.apk', 'apk', stat.size);
        // Mark synced so acquireLocal does not re-download.
        relDb.update(cloudFiles).set({ syncState: 'synced' }).where(eq(cloudFiles.cloudKey, 'apks/pkg/z.apk')).run();
        const result = await relSvc.acquireLocal('apks/pkg/z.apk', 'test');
        expect(result.error).toBeUndefined();
        expect(result.path).toBe(abs);
      } finally {
        fs.rmSync(abs, { force: true });
      }
    });
  });
});

// ── Helpers shared by isVersionSafeToEvict + runEviction-with-safety tests ──

function insertApp(db: AppDatabase, packageName: string): number {
  const now = new Date();
  const result = db.insert(schema.trackedApps).values({
    packageName,
    appName: packageName,
    trackMode: 'device',
    createdAt: now,
    updatedAt: now,
  }).run();
  return Number(result.lastInsertRowid);
}

function insertVersion(db: AppDatabase, trackedAppId: number, versionCode: number, filename: string): void {
  db.insert(schema.apkVersions).values({
    trackedAppId,
    versionCode,
    versionName: String(versionCode),
    filename,
    downloadedAt: new Date(),
  }).run();
}

interface TrackOptions {
  retain?: boolean;
  lastAccessed?: Date;
  relativePath?: string;
  fileSize?: number;
}

function seedCloudFile(
  db: AppDatabase,
  cloudKey: string,
  syncState: string,
  opts: TrackOptions = {},
): void {
  const now = new Date();
  db.insert(schema.cloudFiles).values({
    namespace: '',
    cloudKey,
    relativePath: opts.relativePath ?? `/tmp/${cloudKey}`,
    fileType: 'apk',
    fileSize: opts.fileSize ?? 1_000_000,
    syncState,
    retain: opts.retain ?? false,
    lastAccessed: opts.lastAccessed ?? now,
    createdAt: now,
  }).run();
}

// ── isVersionSafeToEvict tests ──

describe('isVersionSafeToEvict', () => {
  it('returns false when any artifact is pending_upload', () => {
    const db = createTestDb();
    const appId = insertApp(db, 'com.foo');
    insertVersion(db, appId, 101, 'v101.apk');
    seedCloudFile(db, 'apks/com.foo/v101.apk', 'synced');
    seedCloudFile(db, 'apks/com.foo/analysis/101/source.db', 'pending_upload');
    seedCloudFile(db, 'apks/com.foo/analysis/101/metadata.json', 'synced');
    expect(isVersionSafeToEvict(db, 'com.foo', 101, 'v101.apk')).toBe(false);
  });

  it('returns true when all three artifacts are synced', () => {
    const db = createTestDb();
    const appId = insertApp(db, 'com.foo');
    insertVersion(db, appId, 101, 'v101.apk');
    seedCloudFile(db, 'apks/com.foo/v101.apk', 'synced');
    seedCloudFile(db, 'apks/com.foo/analysis/101/source.db', 'synced');
    seedCloudFile(db, 'apks/com.foo/analysis/101/metadata.json', 'synced');
    expect(isVersionSafeToEvict(db, 'com.foo', 101, 'v101.apk')).toBe(true);
  });

  it('returns false if any artifact has no cloudFiles row (never uploaded)', () => {
    const db = createTestDb();
    const appId = insertApp(db, 'com.foo');
    insertVersion(db, appId, 101, 'v101.apk');
    seedCloudFile(db, 'apks/com.foo/v101.apk', 'synced');
    seedCloudFile(db, 'apks/com.foo/analysis/101/source.db', 'synced');
    // metadata.json deliberately absent
    expect(isVersionSafeToEvict(db, 'com.foo', 101, 'v101.apk')).toBe(false);
  });

  it('handles split APKs — all child files must be synced', () => {
    const db = createTestDb();
    const appId = insertApp(db, 'com.foo');
    insertVersion(db, appId, 101, 'v101.apk');
    seedCloudFile(db, 'apks/com.foo/v101.apk/base.apk', 'synced');
    seedCloudFile(db, 'apks/com.foo/v101.apk/split_config.en.apk', 'pending_upload');
    seedCloudFile(db, 'apks/com.foo/analysis/101/source.db', 'synced');
    seedCloudFile(db, 'apks/com.foo/analysis/101/metadata.json', 'synced');
    expect(isVersionSafeToEvict(db, 'com.foo', 101, 'v101.apk')).toBe(false);
  });

  it('returns true for split APKs when all children are synced', () => {
    const db = createTestDb();
    const appId = insertApp(db, 'com.foo');
    insertVersion(db, appId, 101, 'v101.apk');
    seedCloudFile(db, 'apks/com.foo/v101.apk/base.apk', 'synced');
    seedCloudFile(db, 'apks/com.foo/v101.apk/split_config.en.apk', 'synced');
    seedCloudFile(db, 'apks/com.foo/analysis/101/source.db', 'synced');
    seedCloudFile(db, 'apks/com.foo/analysis/101/metadata.json', 'synced');
    expect(isVersionSafeToEvict(db, 'com.foo', 101, 'v101.apk')).toBe(true);
  });

  it('returns false when APK row is entirely missing', () => {
    const db = createTestDb();
    const appId = insertApp(db, 'com.foo');
    insertVersion(db, appId, 101, 'v101.apk');
    // No APK row at all — only analysis files
    seedCloudFile(db, 'apks/com.foo/analysis/101/source.db', 'synced');
    seedCloudFile(db, 'apks/com.foo/analysis/101/metadata.json', 'synced');
    expect(isVersionSafeToEvict(db, 'com.foo', 101, 'v101.apk')).toBe(false);
  });
});

// ── runEviction with safety check ──

describe('runEviction with safety check', () => {
  let db: AppDatabase;
  let mockCloud: ReturnType<typeof createMockCloudStorage>;
  let fileSync: FileStorageService;
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let unlinkSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = createTestDb();
    mockCloud = createMockCloudStorage();
    fileSync = new FileStorageService(db, mockCloud);
    const fs = await import('fs');
    existsSyncSpy = vi.spyOn(fs.default, 'existsSync').mockReturnValue(false);
    unlinkSyncSpy = vi.spyOn(fs.default, 'unlinkSync').mockReturnValue(undefined);
    vi.spyOn(fs.default, 'statSync').mockReturnValue({ size: 0 } as any);
    vi.spyOn(fs.default, 'mkdirSync').mockReturnValue(undefined as any);
  });

  afterEach(() => {
    fileSync.stop();
    vi.restoreAllMocks();
  });

  it('keeps APK local when source.db is still uploading', async () => {
    // Set a tiny budget so we'd normally evict everything
    db.insert(schema.settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

    const appId = insertApp(db, 'com.foo');
    insertVersion(db, appId, 100, 'old.apk');

    // APK + metadata synced, source.db pending — version is NOT safe to evict
    seedCloudFile(db, 'apks/com.foo/old.apk', 'synced', {
      retain: false,
      lastAccessed: new Date(0),
      relativePath: '/tmp/foo/old.apk',
      fileSize: 2_000_000,
    });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', 'pending_upload', {
      retain: false,
      relativePath: '/tmp/foo/analysis/100/source.db',
      fileSize: 500_000,
    });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', 'synced', {
      retain: false,
      relativePath: '/tmp/foo/analysis/100/metadata.json',
      fileSize: 10_000,
    });

    existsSyncSpy.mockReturnValue(true);

    await (fileSync as any).runEviction();

    const apkRow = db.select().from(schema.cloudFiles)
      .where(eq(schema.cloudFiles.cloudKey, 'apks/com.foo/old.apk')).get();
    // APK must still be locally present — eviction was skipped
    expect(apkRow!.syncState).toBe('synced');
    expect(apkRow!.relativePath).not.toBeNull();
    // Local file must NOT have been deleted
    expect(unlinkSyncSpy).not.toHaveBeenCalledWith('/tmp/foo/old.apk');
  });

  it('evicts APK once all artifacts are synced', async () => {
    db.insert(schema.settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

    const appId = insertApp(db, 'com.foo');
    insertVersion(db, appId, 100, 'old.apk');

    for (const [key, size] of [
      ['apks/com.foo/old.apk', 2_000_000],
      ['apks/com.foo/analysis/100/source.db', 500_000],
      ['apks/com.foo/analysis/100/metadata.json', 10_000],
    ] as [string, number][]) {
      seedCloudFile(db, key, 'synced', {
        retain: false,
        lastAccessed: new Date(0),
        relativePath: `/tmp/${key}`,
        fileSize: size,
      });
    }

    existsSyncSpy.mockReturnValue(true);

    await (fileSync as any).runEviction();

    const apkRow = db.select().from(schema.cloudFiles)
      .where(eq(schema.cloudFiles.cloudKey, 'apks/com.foo/old.apk')).get();
    expect(apkRow!.syncState).toBe('cloud_only');
  });

  it('non-APK files are still evicted normally regardless of safety check', async () => {
    db.insert(schema.settings).values({ key: 'cloud_local_cache_mb', value: '1' }).run();

    const now = new Date();
    // A non-APK synced file over budget
    db.insert(schema.cloudFiles).values({
      namespace: '',
      relativePath: '',
      cloudKey: 'sessions/1/screenshot.png',
      relativePath: '/data/sessions/1/screenshot.png',
      fileType: 'session-screenshot',
      fileSize: 2_000_000,
      syncState: 'synced',
      retain: false,
      lastAccessed: new Date(0),
      createdAt: now,
    }).run();

    existsSyncSpy.mockReturnValue(true);

    await (fileSync as any).runEviction();

    const row = db.select().from(schema.cloudFiles)
      .where(eq(schema.cloudFiles.cloudKey, 'sessions/1/screenshot.png')).get();
    expect(row!.syncState).toBe('cloud_only');
  });
});
