import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/create-test-db';
import * as schema from '../db/schema';
import { cloudFiles, settings } from '../db/schema';
import { applyRetentionForApp, getLocalRetentionCount, applyRetentionForAllApps, DEFAULT_APK_LOCAL_RETENTION, APK_RETENTION_FLOOR } from './apk-retention';
import type { AppDatabase } from '../db/index';

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

function insertVersion(db: AppDatabase, trackedAppId: number, versionCode: number, filename: string) {
  db.insert(schema.apkVersions).values({
    trackedAppId,
    versionCode,
    versionName: String(versionCode),
    filename,
    downloadedAt: new Date(),
  }).run();
}

function trackCloudFile(db: AppDatabase, cloudKey: string, retain = false) {
  const now = new Date();
  db.insert(schema.cloudFiles).values({
    namespace: '',
    relativePath: '',
    cloudKey,
    localPath: `/tmp/${cloudKey}`,
    fileType: 'apk',
    fileSize: 1000,
    syncState: 'synced',
    retain,
    lastAccessed: now,
    createdAt: now,
  }).run();
}

describe('apk-retention', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDb(undefined, { foreignKeys: false });
  });

  describe('getLocalRetentionCount', () => {
    it('returns default when setting missing', () => {
      expect(getLocalRetentionCount(db)).toBe(DEFAULT_APK_LOCAL_RETENTION);
    });

    it('reads configured value', () => {
      db.insert(schema.settings).values({ key: 'apk_local_retention_count', value: '7' }).run();
      expect(getLocalRetentionCount(db)).toBe(7);
    });

    it('falls back to default on invalid value', () => {
      db.insert(schema.settings).values({ key: 'apk_local_retention_count', value: 'abc' }).run();
      expect(getLocalRetentionCount(db)).toBe(DEFAULT_APK_LOCAL_RETENTION);
    });
  });

  describe('applyRetentionForApp', () => {
    it('pins the newest N versions by versionCode', () => {
      const appId = insertApp(db, 'com.foo');
      for (const v of [100, 101, 102, 103, 104]) {
        insertVersion(db, appId, v, `${v}_1.0.apk`);
        trackCloudFile(db, `apks/com.foo/${v}_1.0.apk`);
      }

      applyRetentionForApp(db, appId, 'com.foo', 3);

      const rows = db.select().from(schema.cloudFiles).all();
      const retained = rows.filter(r => r.retain).map(r => r.cloudKey).sort();
      const released = rows.filter(r => !r.retain).map(r => r.cloudKey).sort();

      expect(retained).toEqual([
        'apks/com.foo/102_1.0.apk',
        'apks/com.foo/103_1.0.apk',
        'apks/com.foo/104_1.0.apk',
      ]);
      expect(released).toEqual([
        'apks/com.foo/100_1.0.apk',
        'apks/com.foo/101_1.0.apk',
      ]);
    });

    it('demotes previously-retained versions when a newer one arrives', () => {
      const appId = insertApp(db, 'com.foo');
      insertVersion(db, appId, 100, '100_1.0.apk');
      trackCloudFile(db, 'apks/com.foo/100_1.0.apk', true);

      // New version ingests
      insertVersion(db, appId, 101, '101_1.1.apk');
      trackCloudFile(db, 'apks/com.foo/101_1.1.apk', false);

      applyRetentionForApp(db, appId, 'com.foo', 1);

      const rows = db.select().from(schema.cloudFiles).all();
      const v100 = rows.find(r => r.cloudKey.endsWith('100_1.0.apk'))!;
      const v101 = rows.find(r => r.cloudKey.endsWith('101_1.1.apk'))!;
      expect(v100.retain).toBe(false);
      expect(v101.retain).toBe(true);
    });

    it('retains every child of a split APK together', () => {
      const appId = insertApp(db, 'com.split');
      insertVersion(db, appId, 50, '50_1.0');
      trackCloudFile(db, 'apks/com.split/50_1.0/base.apk');
      trackCloudFile(db, 'apks/com.split/50_1.0/split_config.en.apk');
      trackCloudFile(db, 'apks/com.split/50_1.0/split_config.xxhdpi.apk');

      applyRetentionForApp(db, appId, 'com.split', 1);

      const rows = db.select().from(schema.cloudFiles).all();
      expect(rows.every(r => r.retain)).toBe(true);
    });

    it('leaves other apps untouched', () => {
      const a = insertApp(db, 'com.a');
      const b = insertApp(db, 'com.b');
      insertVersion(db, a, 1, '1.apk');
      insertVersion(db, b, 1, '1.apk');
      trackCloudFile(db, 'apks/com.a/1.apk', false);
      trackCloudFile(db, 'apks/com.b/1.apk', false);

      applyRetentionForApp(db, a, 'com.a', 1);

      const aRow = db.select().from(schema.cloudFiles).all().find(r => r.cloudKey === 'apks/com.a/1.apk')!;
      const bRow = db.select().from(schema.cloudFiles).all().find(r => r.cloudKey === 'apks/com.b/1.apk')!;
      expect(aRow.retain).toBe(true);
      expect(bRow.retain).toBe(false);
    });

    it('is a no-op when the package has no tracked versions', () => {
      const appId = insertApp(db, 'com.empty');
      expect(() => applyRetentionForApp(db, appId, 'com.empty', 3)).not.toThrow();
    });

    it('retains all when retentionCount exceeds available versions', () => {
      const appId = insertApp(db, 'com.few');
      insertVersion(db, appId, 1, '1.apk');
      trackCloudFile(db, 'apks/com.few/1.apk');

      applyRetentionForApp(db, appId, 'com.few', 10);

      const row = db.select().from(schema.cloudFiles).all()[0];
      expect(row.retain).toBe(true);
    });
  });

  describe('retention floor', () => {
    it('exports APK_RETENTION_FLOOR = 2', () => {
      expect(APK_RETENTION_FLOOR).toBe(2);
    });

    it('clamps a setting of 1 up to 2 when selecting newest versions', () => {
      const appId = insertApp(db, 'com.floor');
      db.insert(schema.settings).values({ key: 'apk_local_retention_count', value: '1' }).run();
      for (const v of [100, 101, 102, 103]) {
        insertVersion(db, appId, v, `${v}_1.0.apk`);
        trackCloudFile(db, `apks/com.floor/${v}_1.0.apk`);
      }

      applyRetentionForAllApps(db);

      const retained = db.select().from(schema.cloudFiles).where(schema.cloudFiles.retain).all();
      expect(retained.length).toBeGreaterThanOrEqual(2);
    });

    it('honours a setting of 5 (above the floor)', () => {
      const appId = insertApp(db, 'com.above');
      db.insert(schema.settings).values({ key: 'apk_local_retention_count', value: '5' }).run();
      for (const v of [100, 101, 102, 103, 104, 105]) {
        insertVersion(db, appId, v, `${v}_1.0.apk`);
        trackCloudFile(db, `apks/com.above/${v}_1.0.apk`);
      }

      applyRetentionForAllApps(db);

      const retained = db.select().from(schema.cloudFiles).where(schema.cloudFiles.retain).all();
      const retainedVersions = new Set(retained.map(r => {
        const match = r.cloudKey.match(/\/(\d+)_/);
        return match ? parseInt(match[1], 10) : null;
      }).filter(Boolean));
      expect(retainedVersions.size).toBe(5);
    });
  });

  describe('retention pins all artifacts per version', () => {
    it('sets retain=true on APK + source.db + metadata.json for each retained version', () => {
      const db = createTestDb();
      const appId = insertApp(db, 'com.foo');
      const packageName = 'com.foo';
      db.insert(settings).values({ key: 'apk_local_retention_count', value: '2' }).run();

      // Seed 3 versions, each with three cloud files
      for (const vc of [100, 101, 102]) {
        insertVersion(db, appId, vc, `v${vc}.apk`);
        trackCloudFile(db, `apks/${packageName}/v${vc}.apk`);
        trackCloudFile(db, `apks/${packageName}/analysis/${vc}/source.db`);
        trackCloudFile(db, `apks/${packageName}/analysis/${vc}/metadata.json`);
      }

      applyRetentionForAllApps(db);

      // Newest 2 versions (101, 102) → retain=true on all three artifacts each
      const retained = db.select().from(cloudFiles).where(eq(cloudFiles.retain, true)).all();
      expect(retained.length).toBe(6); // 2 versions * 3 artifacts

      // Oldest (100) → all three artifacts released
      const released = db.select().from(cloudFiles).where(eq(cloudFiles.retain, false)).all();
      expect(released.length).toBe(3);

      // Sanity: the released files are all for version 100
      for (const f of released) {
        expect(f.cloudKey).toMatch(/v100|analysis\/100\//);
      }
    });

    it('unpins all three artifacts when a version ages out', () => {
      const db = createTestDb();
      const appId = insertApp(db, 'com.foo');
      db.insert(settings).values({ key: 'apk_local_retention_count', value: '2' }).run();

      // Start with versions 100, 101 — both retained
      for (const vc of [100, 101]) {
        insertVersion(db, appId, vc, `v${vc}.apk`);
        for (const suffix of [`v${vc}.apk`, `analysis/${vc}/source.db`, `analysis/${vc}/metadata.json`]) {
          trackCloudFile(db, `apks/com.foo/${suffix}`);
        }
      }
      applyRetentionForAllApps(db);
      expect(db.select().from(cloudFiles).where(eq(cloudFiles.retain, true)).all()).toHaveLength(6);

      // Ingest version 102 — 100 should age out, all three of its artifacts released
      insertVersion(db, appId, 102, 'v102.apk');
      for (const suffix of ['v102.apk', 'analysis/102/source.db', 'analysis/102/metadata.json']) {
        trackCloudFile(db, `apks/com.foo/${suffix}`);
      }
      applyRetentionForAllApps(db);

      const released = db.select().from(cloudFiles).where(eq(cloudFiles.retain, false)).all();
      expect(released).toHaveLength(3);
      for (const f of released) expect(f.cloudKey).toMatch(/v100|analysis\/100\//);
    });
  });
});
