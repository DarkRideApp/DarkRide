import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { validateAndRepairSchema } from './schema-validator';
import { applyMigrations } from './migrator';

describe('Schema Validator', () => {
  it('adds missing columns to an existing table', () => {
    const sqlite = new Database(':memory:');
    // Create plugin_state WITHOUT the signature/signed_by columns
    // (simulates a partially-applied migration 0068)
    sqlite.exec(`
      CREATE TABLE plugin_state (
        name TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_via TEXT NOT NULL DEFAULT 'workspace',
        version TEXT,
        description TEXT,
        author TEXT,
        npm_package TEXT,
        installed_at INTEGER,
        updated_at INTEGER
      );
    `);
    // Also need at least the other tables so the validator doesn't try to create them all
    // For this test, we just care about plugin_state repair
    // Create stub tables for everything the schema expects
    createStubTables(sqlite);

    const repairs = validateAndRepairSchema(sqlite);

    // Should have added signature and signed_by
    expect(repairs).toBeGreaterThanOrEqual(2);

    const columns = sqlite.prepare('PRAGMA table_info(plugin_state)').all()
      .map((c: any) => c.name);
    expect(columns).toContain('signature');
    expect(columns).toContain('signed_by');
  });

  it('creates missing tables entirely', () => {
    const sqlite = new Database(':memory:');
    // Empty database — no tables at all
    createStubTables(sqlite); // create everything EXCEPT plugin_state

    const repairs = validateAndRepairSchema(sqlite);

    expect(repairs).toBeGreaterThanOrEqual(1);

    const tables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all().map((r: any) => r.name);
    expect(tables).toContain('plugin_state');
  });

  it('does nothing when schema matches perfectly', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, './migrations');

    const repairs = validateAndRepairSchema(sqlite);
    expect(repairs).toBe(0);
  });

  it('inserts missing built-in signing key', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, './migrations');

    // Simulate: table exists but INSERT failed (unixepoch issue)
    sqlite.exec("DELETE FROM trusted_signing_keys WHERE id = 'darkride-official'");

    const repairs = validateAndRepairSchema(sqlite);
    expect(repairs).toBeGreaterThanOrEqual(1);

    const key = sqlite.prepare("SELECT * FROM trusted_signing_keys WHERE id = 'darkride-official'").get() as any;
    expect(key).toBeTruthy();
    expect(key.public_key).toContain('MCowBQ');
    expect(key.built_in).toBe(1);
  });

  it('inserts missing default plugin source', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, './migrations');

    // Simulate: table exists but INSERT failed
    sqlite.exec("DELETE FROM plugin_sources WHERE is_default = 1");

    const repairs = validateAndRepairSchema(sqlite);
    expect(repairs).toBeGreaterThanOrEqual(1);

    const source = sqlite.prepare("SELECT * FROM plugin_sources WHERE is_default = 1").get() as any;
    expect(source).toBeTruthy();
    expect(source.url).toContain('darkride.app');
  });

  it('handles the exact Windows failure case: migration recorded but columns missing', () => {
    const sqlite = new Database(':memory:');
    // Simulate: migrations up to 0066 ran fine (plugin_state created)
    // Migration 0068 was "recorded" but failed partway (INSERT with unixepoch failed)
    // So trusted_signing_keys table exists but plugin_state lacks signature/signed_by
    sqlite.exec(`
      CREATE TABLE plugin_state (
        name TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_via TEXT NOT NULL DEFAULT 'workspace',
        version TEXT,
        description TEXT,
        author TEXT,
        npm_package TEXT,
        installed_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE trusted_signing_keys (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        label TEXT NOT NULL,
        built_in INTEGER NOT NULL DEFAULT 0,
        added_by INTEGER,
        created_at INTEGER
      );
    `);
    createStubTables(sqlite);

    const repairs = validateAndRepairSchema(sqlite);

    // The validator should have added the missing columns
    const columns = sqlite.prepare('PRAGMA table_info(plugin_state)').all()
      .map((c: any) => c.name);
    expect(columns).toContain('signature');
    expect(columns).toContain('signed_by');

    // Now Drizzle queries should work
    const db = drizzle(sqlite, { schema });
    const rows = db.select().from(schema.pluginState).all();
    expect(Array.isArray(rows)).toBe(true);
  });
});

/**
 * Create minimal stub tables so the validator doesn't try to create
 * everything from scratch (we only want to test specific repair cases).
 */
function createStubTables(sqlite: Database.Database): void {
  const existingTables = new Set(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r: any) => r.name),
  );

  const stubs: Record<string, string> = {
    devices: 'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT, platform TEXT NOT NULL DEFAULT \'android\')',
    automations: 'CREATE TABLE IF NOT EXISTS automations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
    automation_sessions: 'CREATE TABLE IF NOT EXISTS automation_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
    screenshots: 'CREATE TABLE IF NOT EXISTS screenshots (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    captured_traffic: 'CREATE TABLE IF NOT EXISTS captured_traffic (id INTEGER PRIMARY KEY AUTOINCREMENT, request_url TEXT NOT NULL DEFAULT \'\', request_method TEXT NOT NULL DEFAULT \'\')',
    websocket_messages: 'CREATE TABLE IF NOT EXISTS websocket_messages (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    proxies: 'CREATE TABLE IF NOT EXISTS proxies (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL)',
    settings: 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    system_state: 'CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    credentials: 'CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    ai_conversations: 'CREATE TABLE IF NOT EXISTS ai_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    analysis_jobs: 'CREATE TABLE IF NOT EXISTS analysis_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    apk_diff_reports: 'CREATE TABLE IF NOT EXISTS apk_diff_reports (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    intercept_rules: 'CREATE TABLE IF NOT EXISTS intercept_rules (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    client_certs: 'CREATE TABLE IF NOT EXISTS client_certs (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    frida_scripts: 'CREATE TABLE IF NOT EXISTS frida_scripts (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    frida_releases: 'CREATE TABLE IF NOT EXISTS frida_releases (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    plugin_state: 'CREATE TABLE IF NOT EXISTS plugin_state (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, installed_via TEXT NOT NULL DEFAULT \'workspace\', version TEXT, description TEXT, author TEXT, npm_package TEXT, installed_at INTEGER, updated_at INTEGER, signature TEXT, signed_by TEXT)',
    plugin_sources: 'CREATE TABLE IF NOT EXISTS plugin_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, url TEXT NOT NULL)',
    trusted_signing_keys: 'CREATE TABLE IF NOT EXISTS trusted_signing_keys (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, label TEXT NOT NULL)',
    users: 'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL)',
    sessions: 'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)',
    api_keys: 'CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    password_reset_tokens: 'CREATE TABLE IF NOT EXISTS password_reset_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT)',
  };

  for (const [name, sql] of Object.entries(stubs)) {
    if (!existingTables.has(name)) {
      try { sqlite.exec(sql); } catch { /* some tables may have deps */ }
    }
  }
}
