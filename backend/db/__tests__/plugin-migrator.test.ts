import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import {
  applyPluginMigrations,
  backfillPluginMigrationsFromJournal,
} from '../plugin-migrator';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plugin_migrations (
      plugin_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_name, filename)
    );
    CREATE TABLE __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `);
  return db;
}

function makePlugin(rootDir: string, name: string, files: Record<string, string>): string {
  const path = join(rootDir, name);
  const migrationsDir = join(path, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(migrationsDir, filename), content);
  }
  return path;
}

describe('applyPluginMigrations', () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'plugin-migrator-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('applies all .sql files in lexicographic order on first run', () => {
    const db = makeDb();
    const path = makePlugin(tmp, 'foo', {
      '0001_second.sql': 'CREATE TABLE foo_b (id INTEGER);',
      '0000_first.sql':  'CREATE TABLE foo_a (id INTEGER);',
    });

    const result = applyPluginMigrations(db, [{ name: 'foo', path }]);
    expect(result.applied).toBe(2);
    expect(result.total).toBe(2);
    expect(result.failures).toEqual([]);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('foo_a');
    expect(names).toContain('foo_b');

    const tracked = db.prepare('SELECT filename FROM plugin_migrations WHERE plugin_name = ? ORDER BY filename').all('foo');
    expect(tracked).toEqual([{ filename: '0000_first.sql' }, { filename: '0001_second.sql' }]);
  });

  it('skips .sql files already recorded in plugin_migrations', () => {
    const db = makeDb();
    const path = makePlugin(tmp, 'foo', {
      '0000_init.sql': 'CREATE TABLE foo_a (id INTEGER);',
    });
    db.prepare('INSERT INTO plugin_migrations (plugin_name, filename, applied_at) VALUES (?, ?, ?)')
      .run('foo', '0000_init.sql', 1700000000);

    const result = applyPluginMigrations(db, [{ name: 'foo', path }]);
    expect(result.applied).toBe(0);
    expect(result.total).toBe(1);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo_a'").all();
    expect(tables).toHaveLength(0); // SQL not re-run
  });

  it('rolls back the transaction on SQL error and reports failure (does not throw)', () => {
    // Migration failure must NOT propagate as a thrown exception — the
    // boot sequence depends on continuing past a bad plugin and disabling
    // it, not on the host process crashing.
    const db = makeDb();
    const path = makePlugin(tmp, 'foo', {
      '0000_bad.sql': 'CREATE TABLE foo_a (id INTEGER); BANANA;', // syntax error
    });

    const result = applyPluginMigrations(db, [{ name: 'foo', path }]);
    expect(result.applied).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].plugin).toBe('foo');
    expect(result.failures[0].filename).toBe('0000_bad.sql');
    expect(result.failures[0].error).toMatch(/foo:0000_bad\.sql/);

    // Table NOT created (rolled back)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo_a'").all();
    expect(tables).toHaveLength(0);
    // Tracking row NOT inserted
    const tracked = db.prepare('SELECT * FROM plugin_migrations').all();
    expect(tracked).toHaveLength(0);
  });

  it('isolates failures: one bad plugin does not stop the next plugin', () => {
    // The original bug: bad migration in one managed plugin crashed the
    // whole boot. The migrator must keep going so the rest of the system
    // boots cleanly with the offender auto-disabled.
    const db = makeDb();
    const badPath = makePlugin(tmp, 'bad', { '0000_broken.sql': 'BANANA;' });
    const goodPath = makePlugin(tmp, 'good', { '0000_ok.sql': 'CREATE TABLE good_t (id INTEGER);' });

    const result = applyPluginMigrations(db, [
      { name: 'bad', path: badPath },
      { name: 'good', path: goodPath },
    ]);

    expect(result.applied).toBe(1); // good's migration succeeded
    expect(result.failures.map(f => f.plugin)).toEqual(['bad']);

    // good's table was created
    const goodTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='good_t'").all();
    expect(goodTables).toHaveLength(1);
  });

  it('stops a failed plugin queue after the first failure (avoids dependent-migration cascades)', () => {
    // If migration 0001 fails, 0002 probably depends on it (e.g. ALTERs
    // the table 0001 was supposed to create). Don't pile failure logs.
    const db = makeDb();
    const path = makePlugin(tmp, 'foo', {
      '0000_first.sql': 'CREATE TABLE foo_a (id INTEGER);',  // succeeds
      '0001_broken.sql': 'BANANA;',                           // fails
      '0002_later.sql': 'CREATE TABLE foo_b (id INTEGER);',   // skipped
    });

    const result = applyPluginMigrations(db, [{ name: 'foo', path }]);

    expect(result.applied).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].filename).toBe('0001_broken.sql');

    // 0002 was never tried — table absent, no tracking row
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo_b'").all();
    expect(tables).toHaveLength(0);
  });

  it('handles multiple plugins independently', () => {
    const db = makeDb();
    const fooPath = makePlugin(tmp, 'foo', { '0000_init.sql': 'CREATE TABLE t_foo (id INTEGER);' });
    const barPath = makePlugin(tmp, 'bar', { '0000_init.sql': 'CREATE TABLE t_bar (id INTEGER);' });

    const result = applyPluginMigrations(db, [{ name: 'foo', path: fooPath }, { name: 'bar', path: barPath }]);
    expect(result.applied).toBe(2);

    const tracked = db.prepare('SELECT plugin_name, filename FROM plugin_migrations ORDER BY plugin_name').all();
    expect(tracked).toEqual([
      { plugin_name: 'bar', filename: '0000_init.sql' },
      { plugin_name: 'foo', filename: '0000_init.sql' },
    ]);
  });

  it('ignores non-.sql files (e.g. meta/ directories from old format)', () => {
    const db = makeDb();
    const path = makePlugin(tmp, 'foo', {
      '0000_init.sql': 'CREATE TABLE t_foo (id INTEGER);',
      'README.md': '# notes',
    });
    mkdirSync(join(path, 'migrations', 'meta'), { recursive: true });
    writeFileSync(join(path, 'migrations', 'meta', '_journal.json'), '{"version":"7"}');

    const result = applyPluginMigrations(db, [{ name: 'foo', path }]);
    expect(result.applied).toBe(1);
  });

  it('returns total count even when applied = 0 (steady state)', () => {
    const db = makeDb();
    const path = makePlugin(tmp, 'foo', { '0000_a.sql': 'CREATE TABLE t1 (i INTEGER);' });
    db.prepare('INSERT INTO plugin_migrations VALUES (?,?,?)').run('foo', '0000_a.sql', 1);
    const result = applyPluginMigrations(db, [{ name: 'foo', path }]);
    expect(result).toEqual({ applied: 0, total: 1, failures: [] });
  });

  it('no-op when plugin has no migrations directory', () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmp, 'no-migrations-'));
    const result = applyPluginMigrations(db, [{ name: 'foo', path }]);
    expect(result).toEqual({ applied: 0, total: 0, failures: [] });
  });
});

describe('backfillPluginMigrationsFromJournal', () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'plugin-migrator-bf-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('backfills plugin_migrations from existing __drizzle_migrations rows', () => {
    const db = makeDb();
    // Pretend Drizzle applied this migration in the past
    db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('0000_init', 1700000000);

    const path = makePlugin(tmp, 'test-plugin', {
      '0000_init.sql': 'CREATE TABLE x (id INTEGER);',
    });
    mkdirSync(join(path, 'migrations', 'meta'), { recursive: true });
    writeFileSync(join(path, 'migrations', 'meta', '_journal.json'), JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [{ idx: 0, version: '7', when: 1700000000, tag: '0000_init', breakpoints: true }],
    }));

    backfillPluginMigrationsFromJournal(db, [{ name: 'test-plugin', path }]);

    const tracked = db.prepare('SELECT plugin_name, filename FROM plugin_migrations').all();
    expect(tracked).toEqual([{ plugin_name: 'test-plugin', filename: '0000_init.sql' }]);
  });

  it('is idempotent — re-running does not duplicate rows', () => {
    const db = makeDb();
    db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('0000_init', 1700000000);

    const path = makePlugin(tmp, 'foo', { '0000_init.sql': 'CREATE TABLE x (id INTEGER);' });
    mkdirSync(join(path, 'migrations', 'meta'), { recursive: true });
    writeFileSync(join(path, 'migrations', 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite',
      entries: [{ idx: 0, version: '7', when: 1700000000, tag: '0000_init', breakpoints: true }],
    }));

    backfillPluginMigrationsFromJournal(db, [{ name: 'foo', path }]);
    backfillPluginMigrationsFromJournal(db, [{ name: 'foo', path }]);

    const count = db.prepare('SELECT COUNT(*) AS n FROM plugin_migrations').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('skips journal entries not present in __drizzle_migrations (never applied under old system)', () => {
    const db = makeDb();
    // No row in __drizzle_migrations for this tag
    const path = makePlugin(tmp, 'foo', { '0000_init.sql': 'CREATE TABLE x (id INTEGER);' });
    mkdirSync(join(path, 'migrations', 'meta'), { recursive: true });
    writeFileSync(join(path, 'migrations', 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite',
      entries: [{ idx: 0, version: '7', when: 1700000000, tag: '0000_init', breakpoints: true }],
    }));

    backfillPluginMigrationsFromJournal(db, [{ name: 'foo', path }]);

    const tracked = db.prepare('SELECT * FROM plugin_migrations').all();
    expect(tracked).toHaveLength(0);
  });

  it('no-op when plugin has no journal', () => {
    const db = makeDb();
    const path = makePlugin(tmp, 'foo', { '0000_init.sql': 'CREATE TABLE x (id INTEGER);' });

    expect(() => backfillPluginMigrationsFromJournal(db, [{ name: 'foo', path }])).not.toThrow();

    const tracked = db.prepare('SELECT * FROM plugin_migrations').all();
    expect(tracked).toHaveLength(0);
  });
});
