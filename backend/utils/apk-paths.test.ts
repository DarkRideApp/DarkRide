import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import {
  APK_DIR,
  apkFilePath,
  analysisDir,
  analysisDbPath,
  analysisNotesPath,
  apkCloudKey,
  analysisDbCloudKey,
  resolveApkLocal,
  lookupVersionMeta,
  resolveApkVersion,
  ensureApkLocal,
  ensureApkVersionLocal,
} from './apk-paths';

// ── Tier 1: Constants + Pure Path Construction ───────────────────────

describe('APK_DIR', () => {
  it('is an absolute path', () => {
    expect(path.isAbsolute(APK_DIR)).toBe(true);
  });

  it('ends with data/apks', () => {
    expect(APK_DIR.endsWith(path.join('data', 'apks'))).toBe(true);
  });
});

describe('apkFilePath', () => {
  it('joins APK_DIR, packageName, and filename', () => {
    expect(apkFilePath('com.example', '100_1.0.apk')).toBe(
      path.join(APK_DIR, 'com.example', '100_1.0.apk'),
    );
  });
});

describe('analysisDir', () => {
  it('produces correct analysis directory path', () => {
    expect(analysisDir('com.example', 42)).toBe(
      path.join(APK_DIR, 'com.example', 'analysis', '42'),
    );
  });
});

describe('analysisDbPath', () => {
  it('produces correct source.db path', () => {
    expect(analysisDbPath('com.example', 42)).toBe(
      path.join(APK_DIR, 'com.example', 'analysis', '42', 'source.db'),
    );
  });
});

describe('analysisNotesPath', () => {
  it('produces correct notes.md path', () => {
    expect(analysisNotesPath('com.example', 42)).toBe(
      path.join(APK_DIR, 'com.example', 'analysis', '42', 'notes.md'),
    );
  });
});

describe('apkCloudKey', () => {
  it('produces correct cloud key', () => {
    expect(apkCloudKey('com.example', '100_1.0.apk')).toBe('apks/com.example/100_1.0.apk');
  });
});

describe('analysisDbCloudKey', () => {
  it('produces correct cloud key', () => {
    expect(analysisDbCloudKey('com.example', 42)).toBe('apks/com.example/analysis/42/source.db');
  });
});

// ── Tier 2: Filesystem Resolution ────────────────────────────────────

describe('resolveApkLocal', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'apk-paths-test-'));
    // Monkey-patch APK_DIR via module internals — instead, use vi.mock
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns null when path does not exist', () => {
    const result = resolveApkLocal('nonexistent.package', 'missing.apk');
    expect(result).toBeNull();
  });

  it('resolves single APK file', () => {
    const pkgDir = path.join(tmpDir, 'com.test');
    fs.mkdirSync(pkgDir, { recursive: true });
    const apkFile = path.join(pkgDir, '100_1.0.apk');
    fs.writeFileSync(apkFile, 'fake-apk');

    const expectedPath = apkFilePath('com.test', '100_1.0.apk');
    const origFn = fs.existsSync;
    const origStat = fs.statSync;

    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (p === expectedPath) return true;
      return origFn(p);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (p === expectedPath) return origStat(apkFile);
      return origStat(p);
    });

    const result = resolveApkLocal('com.test', '100_1.0.apk');
    expect(result).not.toBeNull();
    expect(result!.isSplit).toBe(false);
    expect(result!.apkPath).toBe(expectedPath);
    expect(result!.baseApkPath).toBe(expectedPath);
    expect(result!.allApkPaths).toEqual([expectedPath]);
  });

  it('resolves split APK directory', () => {
    const pkgDir = path.join(tmpDir, 'com.split');
    const splitDir = path.join(pkgDir, '200_2.0');
    fs.mkdirSync(splitDir, { recursive: true });
    fs.writeFileSync(path.join(splitDir, 'base.apk'), 'base');
    fs.writeFileSync(path.join(splitDir, 'split_config.apk'), 'split');
    fs.writeFileSync(path.join(splitDir, 'not-apk.txt'), 'ignored');

    const expectedPath = apkFilePath('com.split', '200_2.0');
    const origFn = fs.existsSync;
    const origStat = fs.statSync;
    const origReaddir = fs.readdirSync;

    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (p === expectedPath) return true;
      return origFn(p);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (p === expectedPath) return origStat(splitDir);
      return origStat(p);
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation((p: any, opts?: any) => {
      if (p === expectedPath) return origReaddir(splitDir, opts) as any;
      return origReaddir(p, opts) as any;
    });

    const result = resolveApkLocal('com.split', '200_2.0');
    expect(result).not.toBeNull();
    expect(result!.isSplit).toBe(true);
    expect(result!.apkPath).toBe(expectedPath);
    expect(result!.baseApkPath).toBe(path.join(expectedPath, 'base.apk'));
    expect(result!.allApkPaths).toHaveLength(2);
    expect(result!.allApkPaths.every(p => p.endsWith('.apk'))).toBe(true);
  });

  it('split APK without base.apk falls back to first .apk', () => {
    const pkgDir = path.join(tmpDir, 'com.nosplit');
    const splitDir = path.join(pkgDir, '300_3.0');
    fs.mkdirSync(splitDir, { recursive: true });
    fs.writeFileSync(path.join(splitDir, 'config.apk'), 'config');
    fs.writeFileSync(path.join(splitDir, 'libs.apk'), 'libs');

    const expectedPath = apkFilePath('com.nosplit', '300_3.0');
    const origFn = fs.existsSync;
    const origStat = fs.statSync;
    const origReaddir = fs.readdirSync;

    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (p === expectedPath) return true;
      return origFn(p);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (p === expectedPath) return origStat(splitDir);
      return origStat(p);
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation((p: any, opts?: any) => {
      if (p === expectedPath) return origReaddir(splitDir, opts) as any;
      return origReaddir(p, opts) as any;
    });

    const result = resolveApkLocal('com.nosplit', '300_3.0');
    expect(result).not.toBeNull();
    expect(result!.isSplit).toBe(true);
    // Falls back to first .apk found
    expect(result!.baseApkPath.endsWith('.apk')).toBe(true);
  });

  it('returns null for empty split directory (evicted .apk files)', () => {
    const pkgDir = path.join(tmpDir, 'com.evicted');
    const splitDir = path.join(pkgDir, '400_4.0');
    fs.mkdirSync(splitDir, { recursive: true });
    // Directory exists but contains no .apk files (FileStorageService evicted them)

    const expectedPath = apkFilePath('com.evicted', '400_4.0');
    const origFn = fs.existsSync;
    const origStat = fs.statSync;
    const origReaddir = fs.readdirSync;

    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (p === expectedPath) return true;
      return origFn(p);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (p === expectedPath) return origStat(splitDir);
      return origStat(p);
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation((p: any, opts?: any) => {
      if (p === expectedPath) return origReaddir(splitDir, opts) as any;
      return origReaddir(p, opts) as any;
    });

    const result = resolveApkLocal('com.evicted', '400_4.0');
    expect(result).toBeNull();
  });
});

// ── Tier 3: DB-Backed Resolution ─────────────────────────────────────

describe('lookupVersionMeta', () => {
  it('returns null for non-existent version', () => {
    const db = createTestDb();
    expect(lookupVersionMeta(db, 999)).toBeNull();
  });

  it('returns metadata for valid version', () => {
    const db = createTestDb();
    db.insert(schema.trackedApps).values({
      packageName: 'com.example.app',
      appName: 'Example App',
      createdAt: new Date(),
    }).run();
    const app = db.select().from(schema.trackedApps).all()[0];

    db.insert(schema.apkVersions).values({
      trackedAppId: app.id,
      versionCode: 100,
      versionName: '1.0.0',
      filename: '100_1.0.0.apk',
      downloadedAt: new Date(),
    }).run();
    const version = db.select().from(schema.apkVersions).all()[0];

    const meta = lookupVersionMeta(db, version.id);
    expect(meta).not.toBeNull();
    expect(meta!.packageName).toBe('com.example.app');
    expect(meta!.appName).toBe('Example App');
    expect(meta!.versionCode).toBe(100);
    expect(meta!.versionName).toBe('1.0.0');
    expect(meta!.filename).toBe('100_1.0.0.apk');
    expect(meta!.trackedAppId).toBe(app.id);
  });

  it('returns null when tracked app is missing', () => {
    const db = createTestDb();
    // Disable FK checks to insert an orphaned version
    const sqlite = (db as any).session.client as Database.Database;
    sqlite.exec('PRAGMA foreign_keys = OFF');
    sqlite.exec(`INSERT INTO apk_versions (tracked_app_id, version_code, filename, downloaded_at) VALUES (999, 1, 'x.apk', 0)`);
    sqlite.exec('PRAGMA foreign_keys = ON');

    const version = db.select().from(schema.apkVersions).all()[0];
    expect(lookupVersionMeta(db, version.id)).toBeNull();
  });
});

describe('resolveApkVersion', () => {
  it('returns null for non-existent version', () => {
    const db = createTestDb();
    expect(resolveApkVersion(db, 999)).toBeNull();
  });

  it('returns meta with null local when file does not exist', () => {
    const db = createTestDb();
    db.insert(schema.trackedApps).values({
      packageName: 'com.notondisk',
      createdAt: new Date(),
    }).run();
    const app = db.select().from(schema.trackedApps).all()[0];
    db.insert(schema.apkVersions).values({
      trackedAppId: app.id,
      versionCode: 1,
      filename: 'nonexistent.apk',
      downloadedAt: new Date(),
    }).run();
    const version = db.select().from(schema.apkVersions).all()[0];

    const result = resolveApkVersion(db, version.id);
    expect(result).not.toBeNull();
    expect(result!.meta.packageName).toBe('com.notondisk');
    expect(result!.local).toBeNull();
  });
});

// ── Tier 4: Cloud-Aware Ensure ───────────────────────────────────────

describe('ensureApkLocal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns resolution immediately when file exists locally', async () => {
    const expectedPath = apkFilePath('com.local', 'app.apk');
    const origFn = fs.existsSync;
    const origStat = fs.statSync;

    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (p === expectedPath) return true;
      return origFn(p);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (p === expectedPath) return { isDirectory: () => false } as any;
      return origStat(p);
    });

    const result = await ensureApkLocal('com.local', 'app.apk', null, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.resolution.isSplit).toBe(false);
      expect(result.resolution.apkPath).toBe(expectedPath);
      // release is a no-op for local
      result.release();
    }
  });

  it('returns error when file missing and no fileSync', async () => {
    const result = await ensureApkLocal('com.missing', 'gone.apk', null, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('not found locally');
    }
  });

  it('fetches from cloud and returns handle with release', async () => {
    const expectedPath = apkFilePath('com.cloud', 'cloud.apk');
    const origFn = fs.existsSync;
    const origStat = fs.statSync;

    let callCount = 0;
    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (p === expectedPath) {
        callCount++;
        // First call (local check): not found. Second call (after cloud download): found.
        return callCount > 1;
      }
      return origFn(p);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (p === expectedPath) return { isDirectory: () => false } as any;
      return origStat(p);
    });

    const mockFileSync = {
      acquireLocal: vi.fn().mockResolvedValue({ path: expectedPath }),
    } as any;

    const result = await ensureApkLocal('com.cloud', 'cloud.apk', mockFileSync, 'test-holder');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.resolution.apkPath).toBe(expectedPath);
      expect(mockFileSync.acquireLocal).toHaveBeenCalledWith(
        'apks/com.cloud/cloud.apk',
        'test-holder',
        expectedPath,
      );

      // Release is now a no-op
      result.release();
    }
  });

  it('returns error when cloud fetch fails', async () => {
    const mockFileSync = {
      acquireLocal: vi.fn().mockResolvedValue({ error: 'Not in cloud' }),
      acquireLocalByPrefix: vi.fn().mockResolvedValue({ error: 'No files found' }),
    } as any;

    const result = await ensureApkLocal('com.nowhere', 'x.apk', mockFileSync, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Not in cloud');
    }
  });

  it('recovers split APK sub-files from cloud when single-key fails', async () => {
    const expectedPath = apkFilePath('com.split', '500_5.0');
    const origFn = fs.existsSync;
    const origStat = fs.statSync;
    const origReaddir = fs.readdirSync;

    let resolveCallCount = 0;
    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (p === expectedPath) {
        resolveCallCount++;
        // First call: not found (or empty dir). After prefix recovery: found.
        return resolveCallCount > 1;
      }
      return origFn(p);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (p === expectedPath) return { isDirectory: () => true } as any;
      return origStat(p);
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation((p: any, opts?: any) => {
      if (p === expectedPath) return ['base.apk', 'split_config.apk'] as any;
      return origReaddir(p, opts) as any;
    });

    const mockFileSync = {
      acquireLocal: vi.fn().mockResolvedValue({ error: 'File not found: apks/com.split/500_5.0' }),
      acquireLocalByPrefix: vi.fn().mockResolvedValue({}),
    } as any;

    const result = await ensureApkLocal('com.split', '500_5.0', mockFileSync, 'test-split');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.resolution.isSplit).toBe(true);
      expect(mockFileSync.acquireLocalByPrefix).toHaveBeenCalledWith(
        'apks/com.split/500_5.0/',
        'test-split',
      );
      // Release is now a no-op
      result.release();
    }
  });
});

describe('ensureApkVersionLocal', () => {
  it('returns error for non-existent version', async () => {
    const db = createTestDb();
    const result = await ensureApkVersionLocal(db, 999, null, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('APK version not found');
    }
  });

  it('returns handle with meta for existing version', async () => {
    const db = createTestDb();
    db.insert(schema.trackedApps).values({
      packageName: 'com.ensure',
      appName: 'Ensure App',
      createdAt: new Date(),
    }).run();
    const app = db.select().from(schema.trackedApps).all()[0];
    db.insert(schema.apkVersions).values({
      trackedAppId: app.id,
      versionCode: 50,
      versionName: '5.0',
      filename: '50_5.0.apk',
      downloadedAt: new Date(),
    }).run();
    const version = db.select().from(schema.apkVersions).all()[0];

    const expectedPath = apkFilePath('com.ensure', '50_5.0.apk');
    const origFn = fs.existsSync;
    const origStat = fs.statSync;

    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (p === expectedPath) return true;
      return origFn(p);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (p === expectedPath) return { isDirectory: () => false } as any;
      return origStat(p);
    });

    const result = await ensureApkVersionLocal(db, version.id, null, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.meta.packageName).toBe('com.ensure');
      expect(result.meta.versionCode).toBe(50);
      expect(result.resolution.apkPath).toBe(expectedPath);
    }
  });
});
