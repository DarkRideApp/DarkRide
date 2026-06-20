import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { applyMigrations } from '../test-utils/create-test-db';

/**
 * Verifies migration 0096_app_sources:
 *  - creates the app_sources table (+ unique index),
 *  - backfills a `playstore` row per tracked app from the old
 *    auto_fetch_play_store / last_play_store_version columns,
 *  - drops those two columns from tracked_apps while preserving id/created_at,
 *  - keeps existing apk_versions FK rows valid.
 */
describe('migration: app_sources', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Pre-0096 shape of the apk-tracking tables.
    db.exec(`
      CREATE TABLE tracked_apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_name TEXT NOT NULL UNIQUE,
        app_name TEXT,
        auto_fetch_play_store INTEGER DEFAULT 1,
        last_play_store_version TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE apk_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracked_app_id INTEGER NOT NULL REFERENCES tracked_apps(id),
        version_code INTEGER NOT NULL,
        version_name TEXT,
        filename TEXT NOT NULL,
        file_size INTEGER,
        device_id TEXT,
        source TEXT DEFAULT 'device',
        downloaded_at INTEGER NOT NULL
      );
    `);
  });

  function applyMigration() {
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(migrationsDir).find(f => /_app_sources\.sql$/.test(f));
    if (!file) throw new Error('migration file not found');
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) db.exec(trimmed);
    }
  }

  function trackedColumns(): string[] {
    return (db.prepare(`PRAGMA table_info(tracked_apps)`).all() as Array<{ name: string }>)
      .map(r => r.name);
  }

  it('creates app_sources and drops the old single-source columns', () => {
    applyMigration();
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
      .map(t => t.name);
    expect(tables).toContain('app_sources');
    expect(trackedColumns()).not.toContain('auto_fetch_play_store');
    expect(trackedColumns()).not.toContain('last_play_store_version');
    expect(trackedColumns()).toContain('id');
    expect(trackedColumns()).toContain('created_at');
  });

  it('backfills a playstore row carrying enabled + last version, preserving ids/FKs', () => {
    db.prepare(`INSERT INTO tracked_apps (id, package_name, app_name, auto_fetch_play_store, last_play_store_version, created_at)
                VALUES (7, 'com.a.enabled', 'A', 1, '1.2.3', 1700000000)`).run();
    db.prepare(`INSERT INTO tracked_apps (id, package_name, app_name, auto_fetch_play_store, last_play_store_version, created_at)
                VALUES (8, 'com.b.disabled', 'B', 0, NULL, 1700000001)`).run();
    db.prepare(`INSERT INTO apk_versions (id, tracked_app_id, version_code, filename, downloaded_at)
                VALUES (1, 7, 100, '100_1.2.3.apk', 1700000002)`).run();

    applyMigration();

    const rows = db.prepare(`SELECT tracked_app_id, source, enabled, last_version FROM app_sources ORDER BY tracked_app_id`).all() as Array<any>;
    expect(rows).toEqual([
      { tracked_app_id: 7, source: 'playstore', enabled: 1, last_version: '1.2.3' },
      { tracked_app_id: 8, source: 'playstore', enabled: 0, last_version: null },
    ]);
    // id + created_at preserved through the column drops.
    const app = db.prepare(`SELECT id, created_at FROM tracked_apps WHERE package_name='com.a.enabled'`).get() as any;
    expect(app).toEqual({ id: 7, created_at: 1700000000 });
    // apk_versions FK still resolves.
    const v = db.prepare(`SELECT tracked_app_id FROM apk_versions WHERE id=1`).get() as any;
    expect(v.tracked_app_id).toBe(7);
  });

  it('enforces uniqueness on (tracked_app_id, source)', () => {
    db.prepare(`INSERT INTO tracked_apps (id, package_name, created_at) VALUES (1, 'com.x', 1)`).run();
    applyMigration();
    expect(() =>
      db.prepare(`INSERT INTO app_sources (tracked_app_id, source, enabled, created_at) VALUES (1, 'playstore', 1, 1)`).run(),
    ).toThrow();
  });
});

/**
 * Full-chain guard: run EVERY migration (0000…latest) via the real migrator on
 * a blank DB, so a future intervening migration that mutates tracked_apps can't
 * silently break 0096.
 */
describe('migration: app_sources (full chain via real migrator)', () => {
  it('runs the whole chain and leaves the expected app_sources shape', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);

    // app_sources exists with its unique index.
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(t => t.name);
    expect(tables).toContain('app_sources');
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='app_sources_app_source'`).get();
    expect(idx).toBeTruthy();

    // tracked_apps no longer carries the old single-source columns.
    const tcols = (db.prepare(`PRAGMA table_info(tracked_apps)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(tcols).not.toContain('auto_fetch_play_store');
    expect(tcols).not.toContain('last_play_store_version');

    // Backfill is one playstore row per app.
    db.prepare(`INSERT INTO tracked_apps (package_name, created_at) VALUES ('com.x', 1)`).run();
    const appId = (db.prepare(`SELECT id FROM tracked_apps WHERE package_name='com.x'`).get() as any).id;
    // The unique constraint is live on the real schema.
    db.prepare(`INSERT INTO app_sources (tracked_app_id, source, enabled, created_at) VALUES (?, 'qq', 0, 1)`).run(appId);
    expect(() =>
      db.prepare(`INSERT INTO app_sources (tracked_app_id, source, enabled, created_at) VALUES (?, 'qq', 1, 1)`).run(appId),
    ).toThrow();
  });
});
