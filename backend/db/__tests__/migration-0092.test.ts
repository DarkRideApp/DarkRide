import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations } from '../migrator';
import { resolve } from 'path';

describe('migration 0092 — device_instances', () => {
  it('creates device_instances + device_instance_config + adds devices.instance_id', () => {
    const db = new Database(':memory:');
    applyMigrations(db, [resolve('./migrations')]);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('device_instances');
    expect(names).toContain('device_instance_config');

    // devices.instance_id column exists
    const cols = db.prepare("PRAGMA table_info('devices')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('instance_id');
  });

  it('device_instance_config has composite primary key + FK cascade', () => {
    const db = new Database(':memory:');
    applyMigrations(db, [resolve('./migrations')]);

    // Foreign-key info
    const fks = db.prepare("PRAGMA foreign_key_list('device_instance_config')").all() as Array<{ table: string; on_delete: string }>;
    expect(fks).toHaveLength(1);
    expect(fks[0].table).toBe('device_instances');
    expect(fks[0].on_delete).toBe('CASCADE');

    // Composite primary key
    const pkCols = (db.prepare("PRAGMA table_info('device_instance_config')").all() as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(['instance_id', 'key']);
  });

  it('cascade deletes config rows when a device_instances row is removed', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON'); // SQLite default is OFF; the migrator may or may not enable it for tests
    applyMigrations(db, [resolve('./migrations')]);
    db.pragma('foreign_keys = ON'); // re-enable in case the migrator toggled it

    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO device_instances (provider_id, runtime_id, state, created_at, last_state_at) VALUES (?, ?, ?, ?, ?)",
    ).run('docker-android', 'abc', 'created', now, now);
    const instId = (db.prepare("SELECT id FROM device_instances WHERE runtime_id = 'abc'").get() as any).id;
    db.prepare("INSERT INTO device_instance_config (instance_id, key, value) VALUES (?, ?, ?)")
      .run(instId, 'image', 'docker-android:14');

    db.prepare("DELETE FROM device_instances WHERE id = ?").run(instId);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM device_instance_config").get() as any;
    expect(remaining.n).toBe(0);
  });
});
