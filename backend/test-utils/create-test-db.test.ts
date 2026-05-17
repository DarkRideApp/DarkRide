import { describe, it, expect } from 'vitest';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../db/schema';
import { createTestDb, generateCreateSQL } from './create-test-db';

// Maps plugin schema — optional, may not exist in public builds
let mapSchema: any;

describe('createTestDb', () => {
  it('should create all schema tables without error', () => {
    const db = createTestDb();
    // Verify we can query every table
    const allTables: SQLiteTable[] = Object.values(schema).filter((v) => {
      try { getTableConfig(v as SQLiteTable); return true; } catch { return false; }
    }) as SQLiteTable[];

    for (const table of allTables) {
      const cfg = getTableConfig(table);
      expect(() => {
        (db as any).run(`SELECT count(*) FROM ${cfg.name}`);
      }).not.toThrow();
    }
  });

  it('should create only requested tables when subset provided', () => {
    const db = createTestDb([schema.settings, schema.devices]);

    // These should work
    db.select().from(schema.settings).all();
    db.select().from(schema.devices).all();

    // This should fail (table not created)
    expect(() => db.select().from(schema.proxies).all()).toThrow();
  });

  it('should auto-create dependency tables when subset uses FKs', () => {
    // apkVersions references trackedApps, so both should be created
    const db = createTestDb([schema.trackedApps, schema.apkVersions]);
    db.insert(schema.trackedApps).values({
      packageName: 'com.test', createdAt: new Date(),
    }).run();
    db.insert(schema.apkVersions).values({
      trackedAppId: 1, versionCode: 1, versionName: '1.0',
      filename: 'test.apk', downloadedAt: new Date(),
    }).run();
    expect(db.select().from(schema.apkVersions).all()).toHaveLength(1);
  });

  it('should support foreignKeys option', () => {
    const db = createTestDb([schema.trackedApps, schema.apkVersions], { foreignKeys: true });

    db.insert(schema.trackedApps).values({
      packageName: 'com.test', appName: 'Test',
      createdAt: new Date(), updatedAt: new Date(),
    }).run();

    // Should succeed with valid FK
    db.insert(schema.apkVersions).values({
      trackedAppId: 1, versionCode: 1, versionName: '1.0',
      filename: 'test.apk', downloadedAt: new Date(),
    }).run();

    // Should fail with invalid FK when foreign_keys is ON
    expect(() => {
      db.insert(schema.apkVersions).values({
        trackedAppId: 999, versionCode: 2, versionName: '2.0',
        filename: 'test2.apk', downloadedAt: new Date(),
      }).run();
    }).toThrow();
  });

  it('should insert and query data in all core tables', () => {
    const db = createTestDb();
    const now = new Date();

    // Insert into several tables to verify schema correctness
    db.insert(schema.devices).values({ id: 'DEV001', name: 'Test' }).run();
    db.insert(schema.automations).values({
      name: 'Auto', code: 'c', passcode: 'p', createdAt: now, updatedAt: now,
    }).run();
    db.insert(schema.automationSessions).values({
      automationId: 1, deviceId: 'DEV001', status: 'success',
      triggerType: 'manual', startedAt: now,
    }).run();
    db.insert(schema.screenshots).values({
      sessionId: 1, filename: 'shot.png', capturedAt: now,
    }).run();
    db.insert(schema.settings).values({ key: 'k', value: 'v' }).run();
    db.insert(schema.blockedDomains).values({ domain: 'example.com', createdAt: now }).run();
    db.insert(schema.credentials).values({
      appId: 'app', username: 'u', password: 'p', createdAt: now, updatedAt: now,
    }).run();

    expect(db.select().from(schema.devices).all()).toHaveLength(1);
    expect(db.select().from(schema.automationSessions).all()).toHaveLength(1);
    expect(db.select().from(schema.screenshots).all()).toHaveLength(1);
  });
});

describe('generateCreateSQL', () => {
  it('should generate valid SQL for table with autoincrement PK', () => {
    const sql = generateCreateSQL(schema.proxies);
    expect(sql).toContain('CREATE TABLE proxies');
    expect(sql).toContain('id integer PRIMARY KEY AUTOINCREMENT');
    expect(sql).toContain('url text NOT NULL');
    expect(sql).toContain("failure_count integer DEFAULT 0");
    expect(sql).toContain('enabled integer DEFAULT 1');
  });

  it('should generate valid SQL for table with text PK', () => {
    const sql = generateCreateSQL(schema.settings);
    expect(sql).toContain('key text PRIMARY KEY');
    expect(sql).toContain('value text NOT NULL');
  });

  it('should generate UNIQUE constraint for columns', () => {
    const sql = generateCreateSQL(schema.blockedDomains);
    expect(sql).toContain('domain text NOT NULL UNIQUE');
  });

  it('should generate REFERENCES for foreign keys', () => {
    const sql = generateCreateSQL(schema.screenshots);
    expect(sql).toContain('REFERENCES automation_sessions(id)');
  });

  it('should generate composite PRIMARY KEY', () => {
    const sql = generateCreateSQL(schema.apiEndpointSessions);
    expect(sql).toContain('PRIMARY KEY(endpoint_id, session_id)');
  });

  it.skipIf(!mapSchema)('should generate composite UNIQUE constraints', () => {
    const sql = generateCreateSQL(mapSchema.mapVersions);
    expect(sql).toContain('UNIQUE(map_config_id, variable_hash)');
  });

  it('should handle string defaults with quotes', () => {
    const sql = generateCreateSQL(schema.devices);
    expect(sql).toContain("DEFAULT 'android'");
  });

  it('should handle boolean defaults as 0/1', () => {
    const sql = generateCreateSQL(schema.automations);
    expect(sql).toContain('requires_https_capture integer DEFAULT 0');
    expect(sql).toContain('enabled integer DEFAULT 1');
  });

  it.skipIf(!mapSchema)('should handle real column types', () => {
    const sql = generateCreateSQL(mapSchema.mapConfigs);
    expect(sql).toContain('bounds_min_lat real NOT NULL');
  });
});
