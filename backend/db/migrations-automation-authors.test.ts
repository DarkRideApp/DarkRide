import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION = '0104_automation_authors';

describe(`migration ${MIGRATION}: who last saved each script's code`, () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
      CREATE TABLE automations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT NOT NULL);`);
    db.exec(`INSERT INTO users (username) VALUES ('admin'); INSERT INTO automations (name, code) VALUES ('old script', 'x');`);
  });

  function apply() {
    const dir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(dir).find((f) => f.startsWith(MIGRATION))!;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
  }
  const authors = () => db.prepare('SELECT * FROM automation_authors').all() as any[];

  it('creates an empty table, so every existing script starts without an author', () => {
    apply();
    expect(authors()).toEqual([]);
  });

  it('defaults the scope snapshot to an empty list', () => {
    apply();
    db.exec(`INSERT INTO automation_authors (automation_id, user_id, updated_at) VALUES (1, 1, 0)`);
    expect(authors()[0].scopes).toBe('[]');
  });

  it('allows only one author row per automation', () => {
    apply();
    db.exec(`INSERT INTO automation_authors (automation_id, user_id, updated_at) VALUES (1, 1, 0)`);
    expect(() => db.exec(`INSERT INTO automation_authors (automation_id, user_id, updated_at) VALUES (1, 1, 0)`)).toThrow();
  });

  it('deletes the author row with its automation', () => {
    apply();
    db.exec(`INSERT INTO automation_authors (automation_id, user_id, updated_at) VALUES (1, 1, 0)`);
    db.exec(`DELETE FROM automations WHERE id = 1`);
    expect(authors()).toEqual([]);
  });

  it('keeps the row but clears the user when the user is deleted', () => {
    apply();
    db.exec(`INSERT INTO automation_authors (automation_id, user_id, scopes, updated_at) VALUES (1, 1, '["core.devices:shell"]', 0)`);
    db.exec(`DELETE FROM users WHERE id = 1`);
    const rows = authors();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
  });

  it('is journalled as idx 104 with a when greater than every earlier entry (so it can never be skipped)', () => {
    const j = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/meta/_journal.json'), 'utf8'));
    const entry = j.entries.find((e: any) => e.idx === 104);
    expect(entry?.tag).toBe(MIGRATION);
    expect(entry.breakpoints).toBe(true);
    const maxEarlier = Math.max(...j.entries.filter((e: any) => e.idx < 104).map((e: any) => e.when));
    expect(entry.when).toBeGreaterThan(maxEarlier);
  });
});
