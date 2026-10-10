import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TAG = '0101_ai_call_request';

describe('migration 0101: per-request AI usage rows and run tool-call count', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT);`);
    const dir = path.resolve(__dirname, '../../migrations');
    const base = fs.readFileSync(path.join(dir, '0076_add_ai_call_log.sql'), 'utf8');
    for (const stmt of base.split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
    db.prepare(`INSERT INTO users (username) VALUES ('admin')`).run();
    db.prepare(
      `INSERT INTO ai_call_log (started_at, identity_type, actor_user_id, input_tokens, output_tokens, outcome)
       VALUES (1000, 'user', 1, 120, 30, 'success')`,
    ).run();
  });

  function apply() {
    const dir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(dir).find((f) => f.startsWith(TAG))!;
    expect(file).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
  }

  it('applies on a database that already has ai_call_log rows and keeps them', () => {
    apply();
    const row = db.prepare('SELECT input_tokens, output_tokens, tool_calls FROM ai_call_log WHERE id = 1').get() as any;
    expect(row).toEqual({ input_tokens: 120, output_tokens: 30, tool_calls: null });
  });

  it('creates ai_call_request with the expected columns', () => {
    apply();
    const cols = (db.prepare(`PRAGMA table_info(ai_call_request)`).all() as any[]).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'call_id', 'seq', 'started_at', 'model', 'provider_type', 'input_tokens',
      'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'cost_usd', 'fallbacks',
    ]);
  });

  it('stores a request row with a nullable cost and JSON fallbacks', () => {
    apply();
    db.prepare(
      `INSERT INTO ai_call_request (call_id, seq, started_at, model, provider_type, input_tokens,
         cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, fallbacks)
       VALUES (1, 0, 1000, 'mystery-model', 'ollama', 10, 0, 0, 5, NULL, '[{"model":"a","error":"x"}]')`,
    ).run();
    const r = db.prepare('SELECT cost_usd, fallbacks FROM ai_call_request').get() as any;
    expect(r.cost_usd).toBeNull();
    expect(JSON.parse(r.fallbacks)).toEqual([{ model: 'a', error: 'x' }]);
  });

  it('deletes request rows when their run is deleted', () => {
    apply();
    db.prepare(
      `INSERT INTO ai_call_request (call_id, seq, started_at, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens)
       VALUES (1, 0, 1000, 10, 0, 0, 5), (1, 1, 1001, 20, 10, 0, 5)`,
    ).run();
    db.prepare('DELETE FROM ai_call_log WHERE id = 1').run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_call_request').get() as any).n).toBe(0);
  });

  it('is journalled as idx 101 with a when greater than every earlier entry (so it can never be skipped)', () => {
    const j = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/meta/_journal.json'), 'utf8'));
    const entry = j.entries.find((e: any) => e.idx === 101);
    expect(entry?.tag).toBe(TAG);
    const maxOther = Math.max(...j.entries.filter((e: any) => e.idx < 101).map((e: any) => e.when));
    expect(entry.when).toBeGreaterThan(maxOther);
  });
});
