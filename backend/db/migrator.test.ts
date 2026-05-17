import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyMigrations } from './migrator';

function makeMigrationsFolder(entries: Array<{ idx: number; tag: string; sql: string }>): string {
  const folder = mkdtempSync(join(tmpdir(), 'migrator-test-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const journal = {
    version: '7',
    dialect: 'sqlite',
    entries: entries.map(e => ({
      idx: e.idx,
      version: '7',
      when: 1000 + e.idx, // arbitrary; migrator must NOT use this for ordering
      tag: e.tag,
      breakpoints: true,
    })),
  };
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const e of entries) {
    writeFileSync(join(folder, `${e.tag}.sql`), e.sql);
  }
  return folder;
}

describe('applyMigrations', () => {
  it('applies all migrations in idx order on a fresh DB', () => {
    const folder = makeMigrationsFolder([
      { idx: 0, tag: '0000_first', sql: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);' },
      { idx: 1, tag: '0001_second', sql: 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);' },
    ]);
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, folder);

    const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
    expect(tables.map((t: any) => t.name)).toEqual(['__drizzle_migrations', 't1', 't2']);

    const rows = sqlite.prepare(`SELECT hash, created_at FROM __drizzle_migrations ORDER BY id`).all();
    expect(rows).toHaveLength(2);
    expect(typeof (rows[0] as any).hash).toBe('string');
    expect((rows[0] as any).hash).toHaveLength(64); // sha256 hex
  });

  it('skips migrations whose hash is already in __drizzle_migrations', () => {
    const folder = makeMigrationsFolder([
      { idx: 0, tag: '0000_first', sql: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);' },
      { idx: 1, tag: '0001_second', sql: 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);' },
    ]);
    const sqlite = new Database(':memory:');

    // Pre-create the tracking table and pre-insert idx=0's hash so it appears applied.
    sqlite.exec(`
      CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);
      CREATE TABLE t1 (id INTEGER PRIMARY KEY);
    `);
    const { createHash } = require('crypto');
    const idx0Hash = createHash('sha256').update('CREATE TABLE t1 (id INTEGER PRIMARY KEY);').digest('hex');
    sqlite.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`).run(idx0Hash, 1);

    applyMigrations(sqlite, folder);

    const rows = sqlite.prepare(`SELECT hash FROM __drizzle_migrations ORDER BY id`).all();
    expect(rows).toHaveLength(2); // idx 0 was pre-existing, idx 1 newly applied
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t2'`).get()).toBeTruthy();
  });

  it('is idempotent — re-running on an already-migrated DB is a no-op', () => {
    const folder = makeMigrationsFolder([
      { idx: 0, tag: '0000_first', sql: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);' },
    ]);
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, folder);
    applyMigrations(sqlite, folder);
    applyMigrations(sqlite, folder);

    const rows = sqlite.prepare(`SELECT hash FROM __drizzle_migrations`).all();
    expect(rows).toHaveLength(1);
  });

  it('splits SQL on --> statement-breakpoint and runs each statement', () => {
    const folder = makeMigrationsFolder([
      {
        idx: 0,
        tag: '0000_multi',
        sql: `CREATE TABLE t1 (id INTEGER);
--> statement-breakpoint
CREATE INDEX t1_id_idx ON t1 (id);
--> statement-breakpoint
INSERT INTO t1 (id) VALUES (42);`,
      },
    ]);
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, folder);

    const indexes = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='t1'`).all();
    expect(indexes.map((r: any) => r.name)).toContain('t1_id_idx');
    expect((sqlite.prepare(`SELECT id FROM t1`).get() as any).id).toBe(42);
  });

  it('processes journal entries in idx order regardless of when value', () => {
    // Build a journal where idx 0's `when` is LARGER than idx 1's `when`.
    // The original Drizzle migrator would silently skip idx 1 here. Ours must apply both.
    const folder = mkdtempSync(join(tmpdir(), 'migrator-test-'));
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          { idx: 0, version: '7', when: 9999999999999, tag: '0000_first', breakpoints: true },
          { idx: 1, version: '7', when: 100,           tag: '0001_second', breakpoints: true },
        ],
      }),
    );
    writeFileSync(join(folder, '0000_first.sql'), 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
    writeFileSync(join(folder, '0001_second.sql'), 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);');

    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, folder);
    const rows = sqlite.prepare(`SELECT hash FROM __drizzle_migrations`).all();
    expect(rows).toHaveLength(2);
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE name='t2'`).get()).toBeTruthy();
  });

  it('rolls back the whole migration when a statement fails', () => {
    const folder = makeMigrationsFolder([
      {
        idx: 0,
        tag: '0000_partfail',
        sql: `CREATE TABLE t1 (id INTEGER);
--> statement-breakpoint
SELECT * FROM nonexistent_table_intentional_error;`,
      },
    ]);
    const sqlite = new Database(':memory:');

    expect(() => applyMigrations(sqlite, folder)).toThrow(/0000_partfail/);

    // t1 should NOT exist (BEGIN..ROLLBACK undid the CREATE TABLE).
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE name='t1'`).get()).toBeUndefined();
    // No __drizzle_migrations row was inserted for the failed migration.
    const rows = sqlite.prepare(`SELECT hash FROM __drizzle_migrations`).all();
    expect(rows).toHaveLength(0);
  });

  it('throws MigrationFileMissingError when journal references a missing SQL file', () => {
    const folder = mkdtempSync(join(tmpdir(), 'migrator-test-'));
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, version: '7', when: 1, tag: '0000_ghost', breakpoints: true }],
      }),
    );
    // Note: 0000_ghost.sql is intentionally NOT created.

    const sqlite = new Database(':memory:');
    expect(() => applyMigrations(sqlite, folder)).toThrow(/0000_ghost/);
  });

  it('handles empty SQL files cleanly (no statements but still records the migration)', () => {
    const folder = makeMigrationsFolder([
      { idx: 0, tag: '0000_empty', sql: '' },
      { idx: 1, tag: '0001_real', sql: 'CREATE TABLE t1 (id INTEGER);' },
    ]);
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, folder);

    const rows = sqlite.prepare(`SELECT hash FROM __drizzle_migrations ORDER BY id`).all();
    expect(rows).toHaveLength(2);
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE name='t1'`).get()).toBeTruthy();
  });

  it('uses the same hash format as Drizzle (sha256 hex of the SQL file contents)', () => {
    // This guards against accidental drift in our hash function.
    const folder = makeMigrationsFolder([
      { idx: 0, tag: '0000_first', sql: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);' },
    ]);
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, folder);

    const expectedHash = require('crypto').createHash('sha256')
      .update('CREATE TABLE t1 (id INTEGER PRIMARY KEY);')
      .digest('hex');
    const row = sqlite.prepare(`SELECT hash FROM __drizzle_migrations`).get() as any;
    expect(row.hash).toBe(expectedHash);
  });

  it('hashes are platform-invariant — CRLF and LF produce the same canonical hash', () => {
    // Regression test for Windows checkout with autocrlf=true: a Linux-applied
    // DB whose __drizzle_migrations contains LF-hashes must still see CRLF
    // working-tree files as "already applied", not re-trigger migrations.
    const lfFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_first', sql: 'CREATE TABLE t1 (id INTEGER);\nCREATE INDEX i1 ON t1(id);' },
    ]);
    const crlfFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_first', sql: 'CREATE TABLE t1 (id INTEGER);\r\nCREATE INDEX i1 ON t1(id);' },
    ]);

    const lfSqlite = new Database(':memory:');
    applyMigrations(lfSqlite, lfFolder);
    const lfHash = (lfSqlite.prepare(`SELECT hash FROM __drizzle_migrations`).get() as any).hash;

    const crlfSqlite = new Database(':memory:');
    applyMigrations(crlfSqlite, crlfFolder);
    const crlfHash = (crlfSqlite.prepare(`SELECT hash FROM __drizzle_migrations`).get() as any).hash;

    expect(lfHash).toBe(crlfHash);
  });

  it('matches a previously-stored CRLF hash even when the working tree is LF', () => {
    // Drizzle on Windows would have hashed CRLF content. If the DB was
    // initialized there and now runs on Linux (working tree = LF), the
    // migrator must still recognize those CRLF-stored hashes.
    const sqlContent = 'CREATE TABLE t1 (id INTEGER);';
    const folder = makeMigrationsFolder([
      { idx: 0, tag: '0000_first', sql: sqlContent }, // file is LF (no CRLF here)
    ]);
    const sqlite = new Database(':memory:');

    // Pre-create the tracking table and pre-insert the CRLF-form hash, as if
    // the DB was initialized on Windows by Drizzle.
    sqlite.exec(`
      CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);
      CREATE TABLE t1 (id INTEGER);
    `);
    const { createHash } = require('crypto');
    const crlfHash = createHash('sha256').update('CREATE TABLE t1 (id INTEGER);').digest('hex');
    // ^ in this contrived case there's no \n so LF and CRLF hash are identical.
    // For a more realistic test, use multi-line content:
    const realFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_first', sql: 'CREATE TABLE t1 (id INTEGER);\nCREATE INDEX i1 ON t1(id);' },
    ]);
    const sqlite2 = new Database(':memory:');
    sqlite2.exec(`
      CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);
      CREATE TABLE t1 (id INTEGER);
      CREATE INDEX i1 ON t1(id);
    `);
    const crlfHashReal = createHash('sha256')
      .update('CREATE TABLE t1 (id INTEGER);\r\nCREATE INDEX i1 ON t1(id);')
      .digest('hex');
    sqlite2.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`).run(crlfHashReal, 1);

    // Run migrator. Should NOT try to re-apply (would fail on duplicate table).
    expect(() => applyMigrations(sqlite2, realFolder)).not.toThrow();

    // Should still have just the original 1 row (existing CRLF hash).
    const rows = sqlite2.prepare(`SELECT hash FROM __drizzle_migrations`).all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).hash).toBe(crlfHashReal);
  });
});

describe('applyMigrations — multiple folders (per-plugin)', () => {
  it('applies migrations from each folder in array order', () => {
    const coreFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_core_init', sql: 'CREATE TABLE core_t (id INTEGER PRIMARY KEY);' },
    ]);
    const pluginFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_plugin_init', sql: 'CREATE TABLE plugin_t (id INTEGER PRIMARY KEY);' },
    ]);
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, [coreFolder, pluginFolder]);

    const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
    expect(tables.map((t: any) => t.name)).toEqual(['__drizzle_migrations', 'core_t', 'plugin_t']);
    const rows = sqlite.prepare(`SELECT hash FROM __drizzle_migrations`).all();
    expect(rows).toHaveLength(2);
  });

  it('uses a shared hash table across folders (a migration moved between folders is not re-applied)', () => {
    const sql = 'CREATE TABLE shared_t (id INTEGER PRIMARY KEY);';
    const oldFolder = makeMigrationsFolder([{ idx: 0, tag: '0000_was_in_core', sql }]);
    const newFolder = makeMigrationsFolder([{ idx: 0, tag: '0000_now_in_plugin', sql }]);

    const sqlite = new Database(':memory:');
    // Initial install: migration ran from oldFolder (e.g. core/migrations).
    applyMigrations(sqlite, oldFolder);

    // After refactor: same migration content lives in newFolder (plugin's
    // migrations dir). Hash matches → migrator skips.
    expect(() => applyMigrations(sqlite, newFolder)).not.toThrow();

    const rows = sqlite.prepare(`SELECT hash FROM __drizzle_migrations`).all();
    expect(rows).toHaveLength(1);
  });

  it('a single applyMigrations([core, plugin]) applies both, plugin sees core tables', () => {
    const coreFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_core', sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY);' },
    ]);
    // Plugin migration creates a foreign key against the core table — only
    // works if core migrated first.
    const pluginFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_plugin', sql: 'CREATE TABLE plugin_data (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));' },
    ]);
    const sqlite = new Database(':memory:');
    expect(() => applyMigrations(sqlite, [coreFolder, pluginFolder])).not.toThrow();
  });

  it('failure in folder N aborts before folder N+1 is processed', () => {
    const goodFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_ok', sql: 'CREATE TABLE good (id INTEGER PRIMARY KEY);' },
    ]);
    const badFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_broken', sql: 'CREATE TABLE bad (this is not valid sql);' },
    ]);
    const laterFolder = makeMigrationsFolder([
      { idx: 0, tag: '0000_later', sql: 'CREATE TABLE later (id INTEGER PRIMARY KEY);' },
    ]);
    const sqlite = new Database(':memory:');
    expect(() => applyMigrations(sqlite, [goodFolder, badFolder, laterFolder])).toThrow(/0000_broken/);

    const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((t: any) => t.name);
    // good ran (committed); broken aborted (rolled back); later never reached.
    expect(tables).toContain('good');
    expect(tables).not.toContain('bad');
    expect(tables).not.toContain('later');
  });
});
