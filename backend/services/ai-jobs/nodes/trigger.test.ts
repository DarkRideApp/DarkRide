import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect } from 'vitest';
import * as schema from '../../../db/schema';
import { TRIGGER_REGISTRY } from './trigger';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE tracked_apps (id INTEGER PRIMARY KEY, package_name TEXT NOT NULL, app_name TEXT, auto_analyse INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE apk_versions (id INTEGER PRIMARY KEY, tracked_app_id INTEGER NOT NULL, version_code INTEGER NOT NULL, version_name TEXT, filename TEXT NOT NULL, file_size INTEGER, device_id TEXT, source TEXT DEFAULT 'device', downloaded_at INTEGER NOT NULL);
  `);
  return drizzle(sqlite, { schema });
}

describe('apk-analysis/apk-context trigger', () => {
  it('expands { versionId } into the full ApkContext struct', async () => {
    const db = makeDb();
    db.insert(schema.trackedApps).values({ id: 17, packageName: 'fr.parcasterix.appli.android', appName: 'Parc Astérix', createdAt: new Date() }).run();
    db.insert(schema.apkVersions).values({
      id: 431, trackedAppId: 17, versionCode: 1791383868, versionName: '6.10.1',
      filename: 'x.apk', fileSize: 150088871, source: 'device', downloadedAt: new Date('2026-10-09T22:16:21Z'),
    }).run();

    const expand = TRIGGER_REGISTRY['apk-analysis/apk-context'];
    const result = await expand({ versionId: 431 }, { db });

    expect(result).toEqual({
      appName: 'Parc Astérix',
      packageName: 'fr.parcasterix.appli.android',
      versionName: '6.10.1',
      versionCode: 1791383868,
      fileSizeBytes: 150088871,
      downloadedAt: '2026-10-09T22:16:21.000Z',
      source: 'device',
    });
  });

  it('throws on missing versionId rather than producing a half-populated context', async () => {
    const db = makeDb();
    const expand = TRIGGER_REGISTRY['apk-analysis/apk-context'];
    await expect(expand({}, { db })).rejects.toThrow(/versionId/);
  });

  it('throws when versionId does not resolve to a real apk_versions row', async () => {
    const db = makeDb();
    const expand = TRIGGER_REGISTRY['apk-analysis/apk-context'];
    await expect(expand({ versionId: 999 }, { db })).rejects.toThrow(/999/);
  });

  // TRIGGER_REGISTRY has no runner/guard in this file — the executor (Task 12+, not yet
  // built) is what will do `TRIGGER_REGISTRY[config.expandFn]` and throw "Unknown trigger
  // expander ...". Until then, an inherited Object.prototype key must at least fail to
  // resolve off the registry itself, the same direct-lookup shape this file's other tests use.
  it('does not resolve an inherited Object.prototype key as a registered expander', () => {
    expect(TRIGGER_REGISTRY['constructor']).toBeUndefined();
  });
});
