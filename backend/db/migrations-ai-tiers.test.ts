import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

function applyMigration(sqlite: Database.Database, filename: string) {
  const sql = readFileSync(join(__dirname, '../../migrations', filename), 'utf-8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) sqlite.exec(trimmed);
  }
}

describe('migration 0082_ai_tiers', () => {
  function bootstrapWithOldSchema(): Database.Database {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE ai_providers (id INTEGER PRIMARY KEY, name TEXT, api_key TEXT);
      CREATE TABLE ai_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_id INTEGER,
        model TEXT,
        enabled INTEGER DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        cooldown_minutes INTEGER DEFAULT 10,
        task_type TEXT DEFAULT 'all',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    return sqlite;
  }

  it('creates ai_tiers table seeded with High and Low', () => {
    const sqlite = bootstrapWithOldSchema();
    applyMigration(sqlite, '0082_ai_tiers.sql');
    const tiers = sqlite.prepare('SELECT name, sort_order, is_hardcoded FROM ai_tiers ORDER BY sort_order').all();
    expect(tiers).toEqual([
      { name: 'High', sort_order: 0, is_hardcoded: 1 },
      { name: 'Low', sort_order: 1, is_hardcoded: 1 },
    ]);
  });

  it('migrates existing ai_models rows onto the High tier', () => {
    const sqlite = bootstrapWithOldSchema();
    sqlite.prepare(`INSERT INTO ai_models (name, provider, task_type, created_at, updated_at) VALUES ('m1', 'p', 'all', 1, 1)`).run();
    sqlite.prepare(`INSERT INTO ai_models (name, provider, task_type, created_at, updated_at) VALUES ('m2', 'p', 'research', 1, 1)`).run();
    sqlite.prepare(`INSERT INTO ai_models (name, provider, task_type, created_at, updated_at) VALUES ('m3', 'p', 'write', 1, 1)`).run();

    applyMigration(sqlite, '0082_ai_tiers.sql');

    const models = sqlite.prepare(`
      SELECT m.name, t.name AS tier_name
      FROM ai_models m LEFT JOIN ai_tiers t ON m.tier_id = t.id
      ORDER BY m.name
    `).all();
    expect(models).toEqual([
      { name: 'm1', tier_name: 'High' },
      { name: 'm2', tier_name: 'High' },
      { name: 'm3', tier_name: 'High' },
    ]);
  });

  it('drops the task_type column', () => {
    const sqlite = bootstrapWithOldSchema();
    applyMigration(sqlite, '0082_ai_tiers.sql');
    const columns = sqlite.prepare(`PRAGMA table_info(ai_models)`).all() as Array<{ name: string }>;
    expect(columns.map(c => c.name)).not.toContain('task_type');
    expect(columns.map(c => c.name)).toContain('tier_id');
  });

  it('converts analysis_tier_*_model settings to analysis_tier_* tier names', () => {
    const sqlite = bootstrapWithOldSchema();
    sqlite.prepare(`INSERT INTO settings (key, value) VALUES ('analysis_tier_research_model', '7')`).run();
    sqlite.prepare(`INSERT INTO settings (key, value) VALUES ('analysis_tier_write_model', '9')`).run();

    applyMigration(sqlite, '0082_ai_tiers.sql');

    const settings = sqlite.prepare(`SELECT key, value FROM settings ORDER BY key`).all();
    expect(settings).toEqual([
      { key: 'analysis_tier_research', value: 'Low' },
      { key: 'analysis_tier_write', value: 'High' },
    ]);
  });
});
