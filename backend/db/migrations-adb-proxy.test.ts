import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import * as schema from './schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { forgetDeviceRow } from '../services/forget-device';

const TAG = '0102_adb_proxy';

// Only entries before a migration count: later migrations legitimately have a greater `when`.
function maxWhenBefore(entries: { idx: number; when: number }[], idx: number): number {
  return Math.max(...entries.filter((e) => e.idx < idx).map((e) => e.when));
}

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

  it('enables a device port by default', () => {
    db.prepare(`INSERT INTO devices (id) VALUES ('A')`).run();
    db.prepare(`INSERT INTO adb_proxy_devices (device_id, port, created_at) VALUES ('A', 6500, 1)`).run();
    expect((db.prepare('SELECT enabled FROM adb_proxy_devices').get() as any).enabled).toBe(1);
  });

  it('leaves every optional adb_proxy_keys column NULL on a minimal insert', () => {
    db.prepare(
      `INSERT INTO adb_proxy_keys (key_id, public_key, status, first_seen_at, last_seen_at) VALUES ('k', 'p', 'approved', 1, 1)`,
    ).run();
    expect(db.prepare('SELECT * FROM adb_proxy_keys').get()).toMatchObject({
      comment: null,
      device_ids: null,
      last_seen_ip: null,
      last_device_id: null,
      decided_by: null,
      decided_at: null,
    });
  });
});

describe('migration 0102 journal entry', () => {
  it('is journalled as idx 102 with a when greater than every earlier entry (so it can never be skipped)', () => {
    const j = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/meta/_journal.json'), 'utf8'));
    const entry = j.entries.find((e: any) => e.idx === 102);
    expect(entry?.tag).toBe(TAG);
    expect(entry.breakpoints).toBe(true);
    expect(entry.when).toBeGreaterThan(maxWhenBefore(j.entries, 102));
  });

  it('ignores later entries with a larger when, so a migration added after 0102 cannot break the check', () => {
    const entries = [{ idx: 1, when: 10 }, { idx: 2, when: 20 }, { idx: 3, when: 30 }];
    expect(maxWhenBefore(entries, 2)).toBe(10);
  });
});

describe('migration 0102 on the full migration chain', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    db = drizzle(sqlite, { schema });
  });

  it('creates both tables with the columns the Drizzle definitions use', () => {
    const cols = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
    expect(cols('adb_proxy_keys')).toEqual([
      'id', 'key_id', 'public_key', 'comment', 'status', 'device_ids', 'first_seen_at',
      'last_seen_at', 'last_seen_ip', 'last_device_id', 'decided_by', 'decided_at',
    ]);
    expect(cols('adb_proxy_devices')).toEqual(['device_id', 'port', 'enabled', 'created_at']);
  });

  it('rejects a proxy row for a device that does not exist', () => {
    expect(() =>
      db.insert(schema.adbProxyDevices).values({ deviceId: 'MISSING', port: 6500, createdAt: new Date() }).run(),
    ).toThrow();
  });

  it('round-trips a proxy row and a key row through the Drizzle tables', () => {
    db.insert(schema.devices).values({ id: 'SER1' }).run();
    db.insert(schema.adbProxyDevices).values({ deviceId: 'SER1', port: 6500, createdAt: new Date(1000) }).run();
    expect(db.select().from(schema.adbProxyDevices).all()).toEqual([
      { deviceId: 'SER1', port: 6500, enabled: true, createdAt: new Date(1000) },
    ]);
    db.insert(schema.adbProxyKeys).values({
      keyId: 'abc', publicKey: 'pub', status: 'approved', deviceIds: ['SER1'],
      firstSeenAt: new Date(1000), lastSeenAt: new Date(2000),
    }).run();
    expect(db.select().from(schema.adbProxyKeys).all()[0]).toMatchObject({ keyId: 'abc', deviceIds: ['SER1'], comment: null });
  });

  it('forgetDeviceRow removes a device and its proxy row on the real schema', () => {
    db.insert(schema.devices).values({ id: 'SER1' }).run();
    db.insert(schema.adbProxyDevices).values({ deviceId: 'SER1', port: 6500, createdAt: new Date() }).run();
    expect(forgetDeviceRow(db, 'SER1')).toBe(true);
    expect(db.select().from(schema.devices).where(eq(schema.devices.id, 'SER1')).all()).toHaveLength(0);
    expect(db.select().from(schema.adbProxyDevices).all()).toHaveLength(0);
  });
});
