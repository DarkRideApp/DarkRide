import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { applyMigrations } from '../test-utils/create-test-db';
import * as schema from './schema';

describe('apkDiffReports.status accepts "skipped"', () => {
  it('inserts and reads back a skipped row', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    applyMigrations(sqlite);
    const db = drizzle(sqlite, { schema });

    // Seed parent rows: a tracked app + two apk versions to satisfy FK
    const now = new Date();
    const app = db.insert(schema.trackedApps).values({
      packageName: 'com.test.skipped',
      appName: 'test',
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

    db.insert(schema.apkDiffReports).values({
      apkVersionId: v2.id,
      compareVersionId: v1.id,
      status: 'skipped',
      error: 'old version is cloud-only; restore before running',
      createdAt: now,
    } as any).run();

    const row = db.select().from(schema.apkDiffReports).get();
    expect(row!.status).toBe('skipped');
    expect(row!.error).toMatch(/cloud-only/);
  });
});
