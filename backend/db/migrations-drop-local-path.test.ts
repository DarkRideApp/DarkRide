import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * Verifies migration 0080_drop_local_path_column copies local_path into
 * relative_path for every row, then drops the column. Idempotent when
 * the column is already absent.
 */
describe('migration: drop local_path column', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Schema matching the post-0078/0079 state (local_path still present).
    db.exec(`
      CREATE TABLE cloud_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL DEFAULT '',
        relative_path TEXT NOT NULL DEFAULT '',
        cloud_key TEXT NOT NULL UNIQUE,
        local_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sync_state TEXT NOT NULL,
        sync_error TEXT,
        retain INTEGER NOT NULL DEFAULT 0,
        last_accessed INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  });

  function applyMigration() {
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(migrationsDir)
      .find(f => /_drop_local_path_column\.sql$/.test(f));
    if (!file) throw new Error('migration file not found');
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Drizzle splits on --> statement-breakpoint.
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      db.exec(trimmed);
    }
  }

  function columnNames(): string[] {
    const rows = db.prepare(`PRAGMA table_info(cloud_files)`).all() as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  it('drops the local_path column', () => {
    expect(columnNames()).toContain('local_path');
    applyMigration();
    expect(columnNames()).not.toContain('local_path');
  });

  it('backfills relative_path from local_path for rows where they differ', () => {
    // A legacy row (pre-0078) where local_path holds the real path and
    // relative_path is still the default empty string.
    db.prepare(`
      INSERT INTO cloud_files (namespace, relative_path, cloud_key, local_path, file_type, file_size, sync_state, last_accessed, created_at)
      VALUES ('', '', 'apks/pkg/v1.apk', 'apks/pkg/v1.apk', 'apk', 1000, 'synced', 0, 0)
    `).run();
    applyMigration();
    const row = db.prepare(`SELECT relative_path FROM cloud_files`).get() as { relative_path: string };
    expect(row.relative_path).toBe('apks/pkg/v1.apk');
  });

  it('overwrites relative_path with local_path for namespaced rows (new contract)', () => {
    // A plugin row where relative_path was namespace-relative but
    // local_path is DATA_ROOT-relative. Migration unifies to the latter.
    db.prepare(`
      INSERT INTO cloud_files (namespace, relative_path, cloud_key, local_path, file_type, file_size, sync_state, last_accessed, created_at)
      VALUES ('maps', 'tiles/a.png', 'plugins/maps/tiles/a.png', 'plugins/maps/tiles/a.png', 'png', 1, 'synced', 0, 0)
    `).run();
    applyMigration();
    const row = db.prepare(`SELECT relative_path, namespace FROM cloud_files`).get() as { relative_path: string; namespace: string };
    expect(row.relative_path).toBe('plugins/maps/tiles/a.png');
    expect(row.namespace).toBe('maps');
  });
});
