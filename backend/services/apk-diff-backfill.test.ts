import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { backfillFailedDiffs } from './apk-diff-backfill';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function seedTwoVersions(db: BetterSQLite3Database<typeof schema>) {
  const now = new Date();
  const app = db.insert(schema.trackedApps).values({
    packageName: 'com.foo',
    appName: 'com.foo',
    createdAt: now,
  } as any).returning({ id: schema.trackedApps.id }).get();
  const v1 = db.insert(schema.apkVersions).values({
    trackedAppId: app.id,
    versionCode: 100,
    filename: 'v100.apk',
    source: 'upload',
    downloadedAt: now,
  } as any).returning({ id: schema.apkVersions.id }).get();
  const v2 = db.insert(schema.apkVersions).values({
    trackedAppId: app.id,
    versionCode: 101,
    filename: 'v101.apk',
    source: 'upload',
    downloadedAt: now,
  } as any).returning({ id: schema.apkVersions.id }).get();
  return { oldVersionId: v1.id, newVersionId: v2.id, appId: app.id };
}

function seedCloudFile(
  db: any,
  cloudKey: string,
  syncState: 'pending_upload' | 'synced' | 'cloud_only',
  localPath: string = '/tmp/path',
) {
  db.insert(schema.cloudFiles).values({
    namespace: 'apks',
    relativePath: cloudKey.slice('apks/'.length),
    cloudKey,
    localPath,
    fileType: 'apk',
    fileSize: 1024,
    syncState,
    retain: false,
    createdAt: new Date(),
    lastAccessed: new Date(),
  } as any).run();
}

function seedVersionAs(db: any, versionCode: number, filename: string, state: 'local' | 'cloud' | 'lost') {
  if (state === 'local') {
    seedCloudFile(db, `apks/com.foo/${filename}`, 'synced', '/tmp/apk');
    seedCloudFile(db, `apks/com.foo/analysis/${versionCode}/source.db`, 'synced', '/tmp/db');
    seedCloudFile(db, `apks/com.foo/analysis/${versionCode}/metadata.json`, 'synced', '/tmp/meta');
  } else if (state === 'cloud') {
    seedCloudFile(db, `apks/com.foo/${filename}`, 'cloud_only', '');
    seedCloudFile(db, `apks/com.foo/analysis/${versionCode}/source.db`, 'cloud_only', '');
    seedCloudFile(db, `apks/com.foo/analysis/${versionCode}/metadata.json`, 'cloud_only', '');
  }
  // 'lost' = no cloudFiles rows at all
}

describe('backfillFailedDiffs', () => {
  it('converts failed diffs with recoverable availability to skipped', () => {
    const db = makeDb();
    const { oldVersionId, newVersionId } = seedTwoVersions(db);
    seedVersionAs(db, 100, 'v100.apk', 'cloud'); // oldVersion → cloud (restorable)
    seedVersionAs(db, 101, 'v101.apk', 'local'); // newVersion → local
    const reportId = db
      .insert(schema.apkDiffReports)
      .values({
        apkVersionId: newVersionId,
        compareVersionId: oldVersionId,
        status: 'failed',
        error: 'Analysis database not available for previous version',
        createdAt: new Date(),
      } as any)
      .returning({ id: schema.apkDiffReports.id })
      .get().id;

    const changed = backfillFailedDiffs(db);
    expect(changed).toBe(1);

    const after = db.select().from(schema.apkDiffReports).where(eq(schema.apkDiffReports.id, reportId)).get()!;
    expect(after.status).toBe('skipped');
    expect(after.error).toMatch(/not local|cloud/i);
  });

  it('leaves failed diffs with lost-state sides alone', () => {
    const db = makeDb();
    const { oldVersionId, newVersionId } = seedTwoVersions(db);
    seedVersionAs(db, 100, 'v100.apk', 'lost'); // unrecoverable
    seedVersionAs(db, 101, 'v101.apk', 'local');
    const reportId = db
      .insert(schema.apkDiffReports)
      .values({
        apkVersionId: newVersionId,
        compareVersionId: oldVersionId,
        status: 'failed',
        error: 'Analysis database not available',
        createdAt: new Date(),
      } as any)
      .returning({ id: schema.apkDiffReports.id })
      .get().id;

    const changed = backfillFailedDiffs(db);
    expect(changed).toBe(0);
    const after = db.select().from(schema.apkDiffReports).where(eq(schema.apkDiffReports.id, reportId)).get()!;
    expect(after.status).toBe('failed');
  });

  it('second run is a no-op (idempotent)', () => {
    const db = makeDb();
    const { oldVersionId, newVersionId } = seedTwoVersions(db);
    seedVersionAs(db, 100, 'v100.apk', 'cloud');
    seedVersionAs(db, 101, 'v101.apk', 'local');
    db.insert(schema.apkDiffReports)
      .values({
        apkVersionId: newVersionId,
        compareVersionId: oldVersionId,
        status: 'failed',
        error: 'Analysis database not available',
        createdAt: new Date(),
      } as any)
      .run();
    backfillFailedDiffs(db);
    const second = backfillFailedDiffs(db);
    expect(second).toBe(0);
  });

  it('only targets rows with the specific error message (not unrelated failures)', () => {
    const db = makeDb();
    const { oldVersionId, newVersionId } = seedTwoVersions(db);
    seedVersionAs(db, 100, 'v100.apk', 'cloud');
    seedVersionAs(db, 101, 'v101.apk', 'local');
    db.insert(schema.apkDiffReports)
      .values({
        apkVersionId: newVersionId,
        compareVersionId: oldVersionId,
        status: 'failed',
        error: 'Some other failure reason',
        createdAt: new Date(),
      } as any)
      .run();
    const changed = backfillFailedDiffs(db);
    expect(changed).toBe(0);
  });
});
