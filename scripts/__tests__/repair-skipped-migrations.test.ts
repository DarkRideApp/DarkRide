import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '../..');

function readScript(name: string): string {
  return readFileSync(join(REPO_ROOT, 'scripts', name), 'utf-8');
}

function hashOf(migrationTag: string): string {
  const sql = readFileSync(join(REPO_ROOT, 'migrations', `${migrationTag}.sql`), 'utf-8');
  return createHash('sha256').update(sql).digest('hex');
}

const AT_RISK = [
  '0068_add_trusted_signing_keys',
  '0074_add_api_keys_internal',
  '0078_cloud_files_relative_paths',
  '0079_scopes_unwrap_double_encoded',
  '0080_drop_local_path_column',
];

function bootstrapBrokenDB(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      scopes TEXT
    );
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY,
      key_id TEXT,
      scopes TEXT
    );
    CREATE TABLE cloud_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cloud_key TEXT NOT NULL UNIQUE,
      local_path TEXT NOT NULL,
      relative_path TEXT NOT NULL DEFAULT '',
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      sync_state TEXT NOT NULL,
      sync_error TEXT,
      retain INTEGER NOT NULL DEFAULT 0,
      namespace TEXT NOT NULL DEFAULT '',
      last_accessed INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO cloud_files (cloud_key, local_path, file_type, file_size, sync_state, last_accessed, created_at)
      VALUES ('k', '/opt/darkride/data/apks/x.apk', 'apk', 1, 'synced', 1, 1);
    INSERT INTO users (id, username, scopes) VALUES (1, 'admin', '"[\\"core.admin\\"]"');
    INSERT INTO api_keys (id, key_id, scopes) VALUES (1, 'k1', '"[\\"core.api\\"]"');
  `);
  return sqlite;
}

function runScript(sqlite: Database.Database, scriptName: string) {
  const sql = readScript(scriptName);
  sqlite.exec(sql);
}

describe('repair-skipped-migrations.sql (always-safe portion)', () => {
  it('unwraps double-encoded scopes idempotently', () => {
    const sqlite = bootstrapBrokenDB();
    runScript(sqlite, 'repair-skipped-migrations.sql');

    const u = sqlite.prepare(`SELECT scopes FROM users WHERE id = 1`).get() as any;
    const k = sqlite.prepare(`SELECT scopes FROM api_keys WHERE id = 1`).get() as any;
    expect(u.scopes).toBe('["core.admin"]');
    expect(k.scopes).toBe('["core.api"]');

    runScript(sqlite, 'repair-skipped-migrations.sql');
    const u2 = sqlite.prepare(`SELECT scopes FROM users WHERE id = 1`).get() as any;
    expect(u2.scopes).toBe('["core.admin"]');
  });

  it('inserts __drizzle_migrations rows with hashes that match the migrator computation', () => {
    const sqlite = bootstrapBrokenDB();
    runScript(sqlite, 'repair-skipped-migrations.sql');

    const rows = sqlite.prepare(`SELECT hash FROM __drizzle_migrations ORDER BY id`).all() as any[];
    const insertedHashes = new Set(rows.map(r => r.hash));

    for (const tag of AT_RISK) {
      expect(insertedHashes.has(hashOf(tag))).toBe(true);
    }
  });

  it('inserting __drizzle_migrations rows is idempotent (no duplicates on re-run)', () => {
    const sqlite = bootstrapBrokenDB();
    runScript(sqlite, 'repair-skipped-migrations.sql');
    runScript(sqlite, 'repair-skipped-migrations.sql');

    for (const tag of AT_RISK) {
      const count = sqlite.prepare(
        `SELECT COUNT(*) AS n FROM __drizzle_migrations WHERE hash = ?`,
      ).get(hashOf(tag)) as any;
      expect(count.n).toBe(1);
    }
  });
});

describe('repair-cloud-files-local-path.sql (column-drop portion)', () => {
  it('drops local_path and backfills relative_path', () => {
    const sqlite = bootstrapBrokenDB();
    runScript(sqlite, 'repair-cloud-files-local-path.sql');

    const cols = sqlite.prepare(`PRAGMA table_info(cloud_files)`).all() as any[];
    expect(cols.map(c => c.name)).not.toContain('local_path');

    const file = sqlite.prepare(`SELECT relative_path FROM cloud_files WHERE id = 1`).get() as any;
    expect(file.relative_path).toBe('apks/x.apk');
  });
});
