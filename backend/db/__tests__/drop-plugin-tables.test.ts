import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { dropPluginTables } from '../plugin-migrator';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plugin_migrations (
      plugin_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_name, filename)
    );
  `);
  return db;
}

describe('dropPluginTables', () => {
  it('drops tables matching plugin_<name>__*', () => {
    const db = makeDb();
    db.exec(`CREATE TABLE plugin_disney__sessions (id INTEGER); CREATE TABLE plugin_disney__cache (id INTEGER); CREATE TABLE plugin_other__keep (id INTEGER); CREATE TABLE app_data (id INTEGER);`);

    dropPluginTables(db, 'disney');

    const remaining = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
    expect(remaining).toContain('plugin_other__keep');
    expect(remaining).toContain('app_data');
    expect(remaining).not.toContain('plugin_disney__sessions');
    expect(remaining).not.toContain('plugin_disney__cache');
  });

  it('clears plugin_migrations rows for the plugin', () => {
    const db = makeDb();
    db.prepare('INSERT INTO plugin_migrations VALUES (?,?,?)').run('disney', '0000_init.sql', 1);
    db.prepare('INSERT INTO plugin_migrations VALUES (?,?,?)').run('other',  '0000_init.sql', 1);

    dropPluginTables(db, 'disney');

    const rows = db.prepare('SELECT plugin_name FROM plugin_migrations').all() as { plugin_name: string }[];
    expect(rows.map(r => r.plugin_name)).toEqual(['other']);
  });

  it('is a no-op when the plugin has no tables', () => {
    const db = makeDb();
    db.exec(`CREATE TABLE app_data (id INTEGER);`);
    expect(() => dropPluginTables(db, 'absent')).not.toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(2); // app_data + plugin_migrations
  });

  it('does NOT match tables whose name only starts with plugin_ but lacks the __ separator', () => {
    const db = makeDb();
    db.exec(`CREATE TABLE plugin_disneyfoo (id INTEGER);`); // no __ — should NOT be dropped
    db.exec(`CREATE TABLE plugin_disney__yes (id INTEGER);`);

    dropPluginTables(db, 'disney');

    const remaining = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(remaining).toContain('plugin_disneyfoo');
    expect(remaining).not.toContain('plugin_disney__yes');
  });
});
