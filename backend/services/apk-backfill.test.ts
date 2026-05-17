import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb } from '../test-utils/create-test-db';
import * as schema from '../db/schema';
import { FileStorageService } from './file-storage';
import { backfillApkCloudFiles, cleanupStaleAnalysisDirs } from './apk-backfill';
import type { AppDatabase } from '../db/index';

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
    exists: vi.fn().mockResolvedValue(false),
    presignUrl: vi.fn().mockResolvedValue(''),
    headBucket: vi.fn().mockResolvedValue(undefined),
    listObjects: vi.fn().mockResolvedValue({ prefixes: [], files: [] }),
    getPresignCacheSize: vi.fn().mockReturnValue(0),
  } as any;
}

describe('backfillApkCloudFiles', () => {
  let db: AppDatabase;
  let fileSync: FileStorageService;
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    db = createTestDb(undefined, { foreignKeys: false });
    fileSync = new FileStorageService(db, createMockCloudStorage());
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-backfill-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'data', 'apks'), { recursive: true });
  });

  afterEach(() => {
    fileSync.stop();
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedApp(packageName: string): number {
    const now = new Date();
    const r = db.insert(schema.trackedApps).values({
      packageName,
      appName: packageName,
      trackMode: 'device',
      createdAt: now,
      updatedAt: now,
    }).run();
    return Number(r.lastInsertRowid);
  }

  function seedVersion(appId: number, versionCode: number, filename: string) {
    db.insert(schema.apkVersions).values({
      trackedAppId: appId,
      versionCode,
      versionName: String(versionCode),
      filename,
      downloadedAt: new Date(),
    }).run();
  }

  function writeApk(packageName: string, filename: string, bytes = 'apk-bytes') {
    const dir = path.join(tmpDir, 'data', 'apks', packageName);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, filename);
    fs.writeFileSync(p, bytes);
    return p;
  }

  function writeSplitApk(packageName: string, dirName: string, children: string[]) {
    const dir = path.join(tmpDir, 'data', 'apks', packageName, dirName);
    fs.mkdirSync(dir, { recursive: true });
    for (const child of children) {
      fs.writeFileSync(path.join(dir, child), `${child}-bytes`);
    }
  }

  it('registers a single-file APK matched to a DB version', () => {
    const appId = seedApp('com.single');
    seedVersion(appId, 100, '100_1.0.apk');
    writeApk('com.single', '100_1.0.apk');

    backfillApkCloudFiles(db, fileSync);

    const rows = db.select().from(schema.cloudFiles).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].cloudKey).toBe('apks/com.single/100_1.0.apk');
    expect(rows[0].fileType).toBe('apk');
    expect(rows[0].syncState).toBe('pending_upload');
  });

  it('registers every child of a split APK', () => {
    const appId = seedApp('com.split');
    seedVersion(appId, 50, '50_1.0');
    writeSplitApk('com.split', '50_1.0', ['base.apk', 'split_config.en.apk', 'split_config.xxhdpi.apk']);

    backfillApkCloudFiles(db, fileSync);

    const rows = db.select().from(schema.cloudFiles).all();
    const keys = rows.map(r => r.cloudKey).sort();
    expect(keys).toEqual([
      'apks/com.split/50_1.0/base.apk',
      'apks/com.split/50_1.0/split_config.en.apk',
      'apks/com.split/50_1.0/split_config.xxhdpi.apk',
    ]);
  });

  it('skips analysis/ and wg-binaries/ directories', () => {
    const appId = seedApp('com.foo');
    seedVersion(appId, 1, '1.apk');
    writeApk('com.foo', '1.apk');

    // create noise that must be ignored
    fs.mkdirSync(path.join(tmpDir, 'data', 'apks', 'com.foo', 'analysis', '1'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data', 'apks', 'com.foo', 'analysis', '1', 'source.db'), 'x');
    fs.mkdirSync(path.join(tmpDir, 'data', 'apks', 'wg-binaries'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data', 'apks', 'wg-binaries', 'arm64-v8a.so'), 'x');

    backfillApkCloudFiles(db, fileSync);

    const rows = db.select().from(schema.cloudFiles).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].cloudKey).toBe('apks/com.foo/1.apk');
  });

  it('is idempotent — re-running does not duplicate rows', () => {
    const appId = seedApp('com.foo');
    seedVersion(appId, 1, '1.apk');
    writeApk('com.foo', '1.apk');

    backfillApkCloudFiles(db, fileSync);
    backfillApkCloudFiles(db, fileSync);

    const rows = db.select().from(schema.cloudFiles).all();
    expect(rows).toHaveLength(1);
  });

  it('ignores on-disk files without a matching DB version', () => {
    seedApp('com.foo');
    writeApk('com.foo', 'orphan.apk');

    backfillApkCloudFiles(db, fileSync);

    const rows = db.select().from(schema.cloudFiles).all();
    expect(rows).toHaveLength(0);
  });
});

describe('cleanupStaleAnalysisDirs', () => {
  let db: AppDatabase;
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    db = createTestDb(undefined, { foreignKeys: false });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-cleanup-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'data', 'apks'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedApp(packageName: string): number {
    const now = new Date();
    const r = db.insert(schema.trackedApps).values({
      packageName, appName: packageName, trackMode: 'device',
      createdAt: now, updatedAt: now,
    }).run();
    return Number(r.lastInsertRowid);
  }

  function seedVersion(appId: number, versionCode: number, filename: string) {
    db.insert(schema.apkVersions).values({
      trackedAppId: appId, versionCode, versionName: String(versionCode),
      filename, downloadedAt: new Date(),
    }).run();
  }

  function writeAnalysisDir(packageName: string, versionCode: number) {
    const dir = path.join(tmpDir, 'data', 'apks', packageName, 'analysis', String(versionCode));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'source.db'), 'decompiled-output');
    return dir;
  }

  function seedCloudFile(cloudKey: string, syncState: string) {
    const now = new Date();
    db.insert(schema.cloudFiles).values({
      namespace: '', relativePath: '', cloudKey,
      localPath: `/tmp/${cloudKey}`, fileType: 'apk', fileSize: 1,
      syncState, lastAccessed: now, createdAt: now,
    }).run();
  }

  it('removes analysis dirs whose APK is cloud_only', () => {
    const appId = seedApp('com.evict');
    seedVersion(appId, 100, '100_1.0.apk');
    const dir = writeAnalysisDir('com.evict', 100);
    seedCloudFile('apks/com.evict/100_1.0.apk', 'cloud_only');

    cleanupStaleAnalysisDirs(db);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps analysis dirs whose APK is synced locally', () => {
    const appId = seedApp('com.keep');
    seedVersion(appId, 50, '50_2.0.apk');
    const dir = writeAnalysisDir('com.keep', 50);
    seedCloudFile('apks/com.keep/50_2.0.apk', 'synced');

    cleanupStaleAnalysisDirs(db);

    expect(fs.existsSync(dir)).toBe(true);
  });

  it('removes orphan analysis dirs with no apk_versions row', () => {
    seedApp('com.orphan');
    const dir = writeAnalysisDir('com.orphan', 999);

    cleanupStaleAnalysisDirs(db);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps analysis dirs when any split-apk child is synced', () => {
    const appId = seedApp('com.split');
    seedVersion(appId, 7, '7_1.0');
    const dir = writeAnalysisDir('com.split', 7);
    seedCloudFile('apks/com.split/7_1.0/base.apk', 'synced');
    seedCloudFile('apks/com.split/7_1.0/split_config.en.apk', 'cloud_only');

    cleanupStaleAnalysisDirs(db);

    expect(fs.existsSync(dir)).toBe(true);
  });

  it('removes analysis dir when every split-apk child is cloud_only', () => {
    const appId = seedApp('com.split');
    seedVersion(appId, 7, '7_1.0');
    const dir = writeAnalysisDir('com.split', 7);
    seedCloudFile('apks/com.split/7_1.0/base.apk', 'cloud_only');
    seedCloudFile('apks/com.split/7_1.0/split_config.en.apk', 'cloud_only');

    cleanupStaleAnalysisDirs(db);

    expect(fs.existsSync(dir)).toBe(false);
  });
});
