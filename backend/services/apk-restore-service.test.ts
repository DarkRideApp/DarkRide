import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { ApkRestoreService, RestoreLostError } from './apk-restore-service';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function seedVersion(db: any, packageName: string, versionCode: number, filename: string): number {
  const now = new Date();
  const app = db.insert(schema.trackedApps).values({
    packageName, appName: packageName, createdAt: now,
  } as any).returning({ id: schema.trackedApps.id }).get();
  const v = db.insert(schema.apkVersions).values({
    trackedAppId: app.id, versionCode, filename, source: 'upload', downloadedAt: now,
  } as any).returning({ id: schema.apkVersions.id }).get();
  return v.id;
}

function seedCloudFile(
  db: any,
  cloudKey: string,
  opts: { localPath: string; syncState: 'pending_upload' | 'synced' | 'cloud_only' },
) {
  const now = new Date();
  db.insert(schema.cloudFiles).values({
    namespace: 'apks',
    relativePath: cloudKey.slice('apks/'.length),
    cloudKey,
    localPath: opts.localPath,
    fileType: 'apk',
    fileSize: 1024,
    syncState: opts.syncState,
    retain: false,
    createdAt: now,
    lastAccessed: now,
  } as any).run();
}

describe('ApkRestoreService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let versionId: number;
  // fileSync mock: acquireLocal(cloudKey, holder, localPath?) returns { path } on success
  let fileSync: any;
  // apkAnalyzer mock: enqueue(versionId, opts?) returns job id (number)
  let apkAnalyzer: any;
  let service: ApkRestoreService;

  beforeEach(() => {
    db = makeDb();
    versionId = seedVersion(db, 'com.foo', 100, '1.apk');
    fileSync = { acquireLocal: vi.fn().mockResolvedValue({ path: '/tmp/downloaded' }) };
    apkAnalyzer = { enqueue: vi.fn().mockResolvedValue(42) };
    service = new ApkRestoreService({ db, fileSync, apkAnalyzer });
  });

  it('local state → returns already-local, no work', async () => {
    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: '/tmp/apk', syncState: 'synced' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: '/tmp/db', syncState: 'synced' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: '/tmp/meta', syncState: 'synced' });

    const result = await service.restore(versionId);
    expect(result.kind).toBe('already-local');
    expect(fileSync.acquireLocal).not.toHaveBeenCalled();
    expect(apkAnalyzer.enqueue).not.toHaveBeenCalled();
  });

  it('cloud state → downloads all three artifacts', async () => {
    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: '', syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: '', syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: '', syncState: 'cloud_only' });

    const result = await service.restore(versionId);
    expect(result.kind).toBe('downloaded');
    expect((result as any).artifacts).toBe(3);
    expect(fileSync.acquireLocal).toHaveBeenCalledTimes(3);
  });

  it('needs-reanalyze state → ensures APK local and enqueues re-analysis', async () => {
    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: '', syncState: 'cloud_only' });
    // source.db absent from cloudFiles entirely
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: '/tmp/meta', syncState: 'synced' });

    const result = await service.restore(versionId);
    expect(result.kind).toBe('reanalysis-enqueued');
    expect((result as any).jobId).toBe(42);
    // APK was cloud-only so the service should have fetched it before enqueue
    expect(fileSync.acquireLocal).toHaveBeenCalledWith(
      'apks/com.foo/1.apk', expect.any(String), expect.any(String),
    );
    expect(apkAnalyzer.enqueue).toHaveBeenCalledWith(versionId, { skipAiReview: true });
  });

  it('lost state → throws RestoreLostError', async () => {
    // APK + source.db + metadata all missing from cloudFiles (lost state)
    await expect(service.restore(versionId)).rejects.toThrow(RestoreLostError);
  });

  it('unknown versionId → throws generic error', async () => {
    await expect(service.restore(99999)).rejects.toThrow(/unknown/i);
  });
});
