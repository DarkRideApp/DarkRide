import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION = '0103_ai_conversation_history';

describe(`migration ${MIGRATION}: owner, origin and unfinished flag on ai_conversations`, () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, page_context TEXT NOT NULL, context_id TEXT NOT NULL, title TEXT,
      messages TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, claude_session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    const ins = db.prepare(`INSERT INTO ai_conversations (page_context, context_id, title, messages, created_at, updated_at) VALUES (?, ?, ?, '[]', 0, 0)`);
    ins.run('automations', '', 'a chat');
    ins.run('apk-analysis', '12', 'an analysis run or a chat');
    ins.run('apk-diff', '7', 'an automated diff summary');
  });

  function apply() {
    const dir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(dir).find((f) => f.startsWith(MIGRATION))!;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
  }
  const row = (title: string) => db.prepare('SELECT * FROM ai_conversations WHERE title = ?').get(title) as any;

  it('adds the columns and leaves existing chats without an owner or origin', () => {
    apply();
    const r = row('a chat');
    expect(r.user_id).toBeNull();
    expect(r.origin_path).toBeNull();
    expect(r.unfinished).toBe(0);
    expect(r.automated).toBe(0);
  });

  it('marks existing APK diff conversations as automated and nothing else', () => {
    apply();
    expect(row('an automated diff summary').automated).toBe(1);
    expect(row('an analysis run or a chat').automated).toBe(0);
    expect(row('a chat').automated).toBe(0);
  });

  it('keeps the messages and ids of existing rows', () => {
    const before = db.prepare('SELECT id, messages FROM ai_conversations ORDER BY id').all();
    apply();
    expect(db.prepare('SELECT id, messages FROM ai_conversations ORDER BY id').all()).toEqual(before);
  });

  it('is journalled as idx 103 with a when greater than every earlier entry (so it can never be skipped)', () => {
    const j = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/meta/_journal.json'), 'utf8'));
    const entry = j.entries.find((e: any) => e.idx === 103);
    expect(entry?.tag).toBe(MIGRATION);
    expect(entry.breakpoints).toBe(true);
    const maxEarlier = Math.max(...j.entries.filter((e: any) => e.idx < 103).map((e: any) => e.when));
    expect(entry.when).toBeGreaterThan(maxEarlier);
  });
});
