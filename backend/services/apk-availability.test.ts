import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { computeVersionAvailability } from './apk-availability';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function seedVersion(
  db: BetterSQLite3Database<typeof schema>,
  packageName: string,
  versionCode: number,
  filename: string,
): number {
  const now = new Date();
  const app = db.insert(schema.trackedApps).values({
    packageName,
    appName: packageName,
    createdAt: now,
  } as any).returning({ id: schema.trackedApps.id }).get();
  const version = db.insert(schema.apkVersions).values({
    trackedAppId: app.id,
    versionCode,
    filename,
    source: 'upload',
    downloadedAt: now,
  } as any).returning({ id: schema.apkVersions.id }).get();
  return version.id;
}

function seedCloudFile(
  db: BetterSQLite3Database<typeof schema>,
  cloudKey: string,
  opts: { localPath: string | null; syncState: 'pending_upload' | 'synced' | 'cloud_only' },
) {
  const now = new Date();
  db.insert(schema.cloudFiles).values({
    namespace: 'apks',
    relativePath: cloudKey.slice('apks/'.length),
    cloudKey,
    // localPath is NOT NULL in schema — use empty string to represent "no local copy"
    localPath: opts.localPath ?? '',
    fileType: 'apk',
    fileSize: 1024,
    syncState: opts.syncState,
    retain: false,
    lastAccessed: now,
    createdAt: now,
  } as any).run();
}

describe('computeVersionAvailability', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let versionId: number;

  beforeEach(() => {
    db = makeDb();
    versionId = seedVersion(db, 'com.foo', 100, '1.apk');
  });

  it('returns local when APK + source.db + metadata are all localPresent', () => {
    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: '/tmp/apk', syncState: 'synced' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: '/tmp/db', syncState: 'synced' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: '/tmp/meta', syncState: 'synced' });
    const r = computeVersionAvailability(db, versionId);
    expect(r.state).toBe('local');
    expect(r.canRestoreFromCloud).toBe(false);
    expect(r.canReanalyze).toBe(false);
  });

  it('returns cloud when all synced but APK evicted locally', () => {
    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: null, syncState: 'cloud_only' });
    const r = computeVersionAvailability(db, versionId);
    expect(r.state).toBe('cloud');
    expect(r.canRestoreFromCloud).toBe(true);
  });

  it('returns needs-reanalyze when source.db missing both locally and in cloud', () => {
    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: '/tmp/apk', syncState: 'synced' });
    // source.db not in cloudFiles at all
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: '/tmp/meta', syncState: 'synced' });
    const r = computeVersionAvailability(db, versionId);
    expect(r.state).toBe('needs-reanalyze');
    expect(r.canReanalyze).toBe(true);
  });

  it('returns lost when APK has no local copy and no cloud row', () => {
    // APK missing from cloudFiles entirely
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: null, syncState: 'cloud_only' });
    const r = computeVersionAvailability(db, versionId);
    expect(r.state).toBe('lost');
    expect(r.canRestoreFromCloud).toBe(false);
    expect(r.canReanalyze).toBe(false);
  });

  it('exposes per-artifact localPresent + cloudSynced fields', () => {
    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: '/tmp/apk', syncState: 'synced' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: '/tmp/meta', syncState: 'synced' });
    const r = computeVersionAvailability(db, versionId);
    expect(r.apk.localPresent).toBe(true);
    expect(r.apk.cloudSynced).toBe(true);
    expect(r.sourceDb.localPresent).toBe(false);
    expect(r.sourceDb.cloudSynced).toBe(true);
    expect(r.metadata.localPresent).toBe(true);
  });

  it('throws on unknown versionId', () => {
    expect(() => computeVersionAvailability(db, 99999)).toThrow(/unknown.*version/i);
  });

  // ── Filesystem fallback when cloud storage is not configured ─────────────
  // When the server runs without S3/R2/etc., file-storage's trackFile() is a
  // no-op and never inserts a cloud_files row. Without a filesystem fallback
  // every freshly-downloaded APK would look 'lost' to the availability check.
  describe('filesystem fallback (no cloud_files row)', () => {
    let existsSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
      existsSpy?.mockRestore();
    });

    it('reports APK as available when the file exists on disk but has no cloud row', () => {
      // APK on disk, source.db generated by analyser, metadata.json written.
      // None of them are registered in cloud_files (unconfigured cloud).
      existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('com.foo/1.apk')
          || s.endsWith('com.foo/analysis/100/source.db')
          || s.endsWith('com.foo/analysis/100/metadata.json');
      });

      const r = computeVersionAvailability(db, versionId);
      expect(r.state).toBe('local');
      expect(r.apk.localPresent).toBe(true);
      expect(r.sourceDb.localPresent).toBe(true);
      expect(r.metadata.localPresent).toBe(true);
    });

    it('split APK: parent directory exists on disk — avoids false lost even when cloud tracks only sub-files', () => {
      // Regression guard: apk-tracker registers split APKs one cloud_files
      // row per sub-file ("apks/pkg/filename/base.apk" etc.) and never creates
      // the parent-level key. A naive availability check at the parent key
      // would see no row and report lost — despite the APK directory being
      // present on disk with real .apk files inside.
      seedCloudFile(db, 'apks/com.foo/1.apk/base.apk',   { localPath: '/tmp/apk/base.apk',   syncState: 'pending_upload' });
      seedCloudFile(db, 'apks/com.foo/1.apk/config.en.apk', { localPath: '/tmp/apk/config.en.apk', syncState: 'pending_upload' });
      // No row at the parent key "apks/com.foo/1.apk".
      existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('com.foo/1.apk'); // parent dir exists
      });

      const r = computeVersionAvailability(db, versionId);
      expect(r.apk.localPresent).toBe(true);
      expect(r.state).not.toBe('lost');
    });

    it('reports lost when no cloud row AND file is not on disk', () => {
      existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const r = computeVersionAvailability(db, versionId);
      expect(r.state).toBe('lost');
    });

    it('reports needs-reanalyze when APK is on disk but source.db is missing everywhere', () => {
      existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        // Only the APK exists — no analysis artefacts yet.
        return String(p).endsWith('/1.apk');
      });
      const r = computeVersionAvailability(db, versionId);
      expect(r.state).toBe('needs-reanalyze');
      expect(r.canReanalyze).toBe(true);
    });
  });
});
