import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../../db/schema';
import { createAutomationsApi } from '../automations-api';

function makeDb() {
  const sqlite = new Database(':memory:');
  // Mirror the actual `automations` table schema from backend/db/schema.ts.
  sqlite.exec(`
    CREATE TABLE automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      passcode TEXT NOT NULL,
      requires_device INTEGER NOT NULL DEFAULT 1,
      requires_https_capture INTEGER DEFAULT 0,
      timeout_ms INTEGER DEFAULT 300000,
      is_rule INTEGER DEFAULT 0,
      is_capture_rule INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      schedule TEXT,
      device_filter TEXT,
      -- Managed-automations columns (migration 0093) — keep in sync with schema.ts
      managed_by TEXT,
      managed_key TEXT,
      current_default_code TEXT,
      base_default_code TEXT,
      is_overridden INTEGER NOT NULL DEFAULT 0,
      allow_user_override INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      emit_failure_notification INTEGER NOT NULL DEFAULT 0,
      -- Migration 0094 — revert-to-default snapshots
      current_default_schedule TEXT,
      current_default_enabled INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

describe('AutomationsApi', () => {
  it('list returns rows mapped to AutomationRow shape', async () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    (db as any).$client.prepare(
      `INSERT INTO automations
        (name, code, passcode, requires_device, requires_https_capture,
         timeout_ms, is_rule, is_capture_rule, priority, enabled,
         schedule, device_filter, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, 300000, 0, 0, 0, 1, NULL, NULL, ?, ?)`,
    ).run('a', 'console.log("hi")', 'pw', now, now);

    const api = createAutomationsApi(db);
    const rows = await api.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('a');
    expect(rows[0].code).toBe('console.log("hi")');
    expect(rows[0].requiresDevice).toBe(true);
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].schedule).toBeNull();
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('list returns empty array when no rows', async () => {
    const api = createAutomationsApi(makeDb());
    expect(await api.list()).toEqual([]);
  });
});
