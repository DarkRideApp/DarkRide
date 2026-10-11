import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TAG = '0102_adb_proxy';

describe('migration 0102: ADB proxy keys and device ports', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT);`);
    db.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY);`);
    const dir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(dir).find((f) => f.startsWith(TAG));
    expect(file).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, file!), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
  });

  it('creates adb_proxy_keys with the expected columns', () => {
    const cols = (db.prepare('PRAGMA table_info(adb_proxy_keys)').all() as any[]).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'key_id', 'public_key', 'comment', 'status', 'device_ids', 'first_seen_at',
      'last_seen_at', 'last_seen_ip', 'last_device_id', 'decided_by', 'decided_at',
    ]);
  });

  it('creates adb_proxy_devices with the expected columns', () => {
    const cols = (db.prepare('PRAGMA table_info(adb_proxy_devices)').all() as any[]).map((c) => c.name);
    expect(cols).toEqual(['device_id', 'port', 'enabled', 'created_at']);
  });

  it('rejects a status outside approved, denied and revoked', () => {
    expect(() =>
      db.prepare(`INSERT INTO adb_proxy_keys (key_id, public_key, status, first_seen_at, last_seen_at) VALUES ('k', 'p', 'pending', 1, 1)`).run(),
    ).toThrow();
  });

  it('rejects a duplicate key id', () => {
    const insert = () =>
      db.prepare(`INSERT INTO adb_proxy_keys (key_id, public_key, status, first_seen_at, last_seen_at) VALUES ('k', 'p', 'approved', 1, 1)`).run();
    insert();
    expect(insert).toThrow();
  });

  it('sets decided_by to NULL when the deciding user is deleted', () => {
    db.prepare(`INSERT INTO users (username) VALUES ('admin')`).run();
    db.prepare(
      `INSERT INTO adb_proxy_keys (key_id, public_key, status, first_seen_at, last_seen_at, decided_by) VALUES ('k', 'p', 'approved', 1, 1, 1)`,
    ).run();
    db.prepare('DELETE FROM users WHERE id = 1').run();
    expect((db.prepare('SELECT decided_by FROM adb_proxy_keys').get() as any).decided_by).toBeNull();
  });

  it('keeps one port per device and one device per port', () => {
    db.prepare(`INSERT INTO devices (id) VALUES ('A'), ('B')`).run();
    db.prepare(`INSERT INTO adb_proxy_devices (device_id, port, created_at) VALUES ('A', 6500, 1)`).run();
    expect(() => db.prepare(`INSERT INTO adb_proxy_devices (device_id, port, created_at) VALUES ('B', 6500, 1)`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO adb_proxy_devices (device_id, port, created_at) VALUES ('A', 6501, 1)`).run()).toThrow();
  });

  it('blocks deleting a device that still has a proxy row (the app must clear it first)', () => {
    db.prepare(`INSERT INTO devices (id) VALUES ('A')`).run();
    db.prepare(`INSERT INTO adb_proxy_devices (device_id, port, created_at) VALUES ('A', 6500, 1)`).run();
    expect(() => db.prepare(`DELETE FROM devices WHERE id = 'A'`).run()).toThrow();
  });
});
