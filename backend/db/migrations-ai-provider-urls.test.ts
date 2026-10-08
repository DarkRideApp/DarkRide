import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

describe('migration 0100: null base_url on providers that ignored it', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE ai_providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, api_key TEXT, base_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    const ins = db.prepare(`INSERT INTO ai_providers (name, type, base_url, created_at, updated_at) VALUES (?, ?, ?, 0, 0)`);
    ins.run('or', 'openrouter', 'http://stale:11434');
    ins.run('gem', 'gemini', 'http://stale:11434');
    ins.run('oll', 'ollama', 'http://keep:11434');
    ins.run('ant', 'anthropic', 'https://proxy.test');
    ins.run('cs', 'codestral', 'https://api.mistral.ai');
    ins.run('or2', 'openrouter', null);
  });

  function apply() {
    const dir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(dir).find((f) => f.startsWith('0100_ai_provider_ignored_base_urls'))!;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
  }
  const url = (name: string) => (db.prepare('SELECT base_url FROM ai_providers WHERE name = ?').get(name) as any).base_url;

  it('nulls openrouter and gemini only', () => {
    apply();
    expect(url('or')).toBeNull();
    expect(url('gem')).toBeNull();
    expect(url('oll')).toBe('http://keep:11434');
    expect(url('ant')).toBe('https://proxy.test');
    expect(url('cs')).toBe('https://api.mistral.ai');
    expect(url('or2')).toBeNull();
  });
  it('is harmless to run twice', () => { apply(); apply(); expect(url('oll')).toBe('http://keep:11434'); });

  it('is journalled as idx 100 with a when greater than every earlier entry (so it can never be skipped)', () => {
    const j = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/meta/_journal.json'), 'utf8'));
    const entry = j.entries.find((e: any) => e.idx === 100);
    expect(entry?.tag).toBe('0100_ai_provider_ignored_base_urls');
    // Only entries before this migration count: later migrations legitimately have a greater `when`.
    const maxEarlier = Math.max(...j.entries.filter((e: any) => e.idx < 100).map((e: any) => e.when));
    expect(entry.when).toBeGreaterThan(maxEarlier);
  });
});
