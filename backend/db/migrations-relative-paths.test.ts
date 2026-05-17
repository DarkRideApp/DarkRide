import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * This test verifies the 007X_cloud_files_relative_paths migration
 * strips absolute DATA_ROOT prefixes from cloud_files.local_path.
 */
describe('migration: cloud_files relative paths', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Minimal cloud_files shape — only columns the migration touches.
    db.exec(`
      CREATE TABLE cloud_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cloud_key TEXT NOT NULL UNIQUE,
        local_path TEXT NOT NULL
      );
    `);
  });

  function applyMigration() {
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(migrationsDir)
      .find(f => /_cloud_files_relative_paths\.sql$/.test(f));
    if (!file) throw new Error('migration file not found');
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec(sql);
  }

  it('strips /opt/darkride/data/ prefix', () => {
    db.prepare('INSERT INTO cloud_files (cloud_key, local_path) VALUES (?, ?)')
      .run('apks/x/y.apk', '/opt/darkride/data/apks/x/y.apk');
    applyMigration();
    const row = db.prepare('SELECT local_path FROM cloud_files').get() as { local_path: string };
    expect(row.local_path).toBe('apks/x/y.apk');
  });

  it('strips an arbitrary absolute prefix up to /data/', () => {
    db.prepare('INSERT INTO cloud_files (cloud_key, local_path) VALUES (?, ?)')
      .run('apks/x/y.apk', '/some/legacy/install/data/apks/x/y.apk');
    applyMigration();
    const row = db.prepare('SELECT local_path FROM cloud_files').get() as { local_path: string };
    expect(row.local_path).toBe('apks/x/y.apk');
  });

  it('leaves already-relative paths untouched', () => {
    db.prepare('INSERT INTO cloud_files (cloud_key, local_path) VALUES (?, ?)')
      .run('apks/x/y.apk', 'apks/x/y.apk');
    applyMigration();
    const row = db.prepare('SELECT local_path FROM cloud_files').get() as { local_path: string };
    expect(row.local_path).toBe('apks/x/y.apk');
  });

  it('is idempotent', () => {
    db.prepare('INSERT INTO cloud_files (cloud_key, local_path) VALUES (?, ?)')
      .run('apks/x/y.apk', '/opt/darkride/data/apks/x/y.apk');
    applyMigration();
    applyMigration();
    const row = db.prepare('SELECT local_path FROM cloud_files').get() as { local_path: string };
    expect(row.local_path).toBe('apks/x/y.apk');
  });

  it('leaves absolute paths with no /data/ segment untouched (loud failure later)', () => {
    db.prepare('INSERT INTO cloud_files (cloud_key, local_path) VALUES (?, ?)')
      .run('weird/key', '/var/log/weird.bin');
    applyMigration();
    const row = db.prepare('SELECT local_path FROM cloud_files').get() as { local_path: string };
    expect(row.local_path).toBe('/var/log/weird.bin');
  });
});
