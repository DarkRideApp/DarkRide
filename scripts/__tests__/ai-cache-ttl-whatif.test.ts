import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../../backend/db/schema';
import { applyMigrations } from '../../backend/db/migrator';
import { parseArgs, runCacheTtlWhatIf } from '../ai-cache-ttl-whatif';

const NOW = new Date(2026, 9, 16, 12, 0, 0);

describe('parseArgs', () => {
  it('defaults to the last 30 days of the database DATABASE_PATH names', () => {
    expect(parseArgs([], { DATABASE_PATH: '/srv/darkride.db' })).toEqual({ dbPath: '/srv/darkride.db', days: 30 });
  });

  it('falls back to ./data/darkride.db when DATABASE_PATH is not set', () => {
    expect(parseArgs([], {})).toEqual({ dbPath: './data/darkride.db', days: 30 });
  });

  it('takes --db and --days from the command line over the environment', () => {
    expect(parseArgs(['--db', 'copy.db', '--days', '7'], { DATABASE_PATH: '/srv/darkride.db' })).toEqual({ dbPath: 'copy.db', days: 7 });
  });

  it('rejects a window that is not a whole number of days from 1 to 365', () => {
    for (const bad of ['0', '-3', '2.5', 'abc', '366', '']) {
      expect(() => parseArgs(['--days', bad], {})).toThrow('--days must be a whole number from 1 to 365');
    }
    expect(() => parseArgs(['--days'], {})).toThrow('--days must be a whole number from 1 to 365');
  });

  it('rejects an option it does not know and a --db with no path', () => {
    expect(() => parseArgs(['--frobnicate'], {})).toThrow('Unknown option: --frobnicate');
    expect(() => parseArgs(['--db'], {})).toThrow('--db needs a path');
  });
});

describe('runCacheTtlWhatIf', () => {
  let templateDir: string;
  let template: string;
  let dir: string;
  let dbPath: string;

  // Applying every migration takes seconds, so it is done once and each test gets a copy.
  beforeAll(() => {
    templateDir = mkdtempSync(join(tmpdir(), 'ai-cache-ttl-template-'));
    template = join(templateDir, 'template.db');
    const sqlite = new Database(template);
    applyMigrations(sqlite, './migrations');
    sqlite.close();
  }, 120_000);
  afterAll(() => rmSync(templateDir, { recursive: true, force: true }));

  /** A real database file with every migration applied, seeded through the schema. */
  function seed(fill: (db: ReturnType<typeof drizzle<typeof schema>>, userId: number) => void): void {
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite, { schema });
    const now = new Date();
    const userId = db.insert(schema.users).values({
      username: 'alice', providerId: 'core.password', scopes: [], createdAt: now, updatedAt: now,
    }).returning({ id: schema.users.id }).get().id;
    fill(db, userId);
    sqlite.close();
  }

  function addRun(db: ReturnType<typeof drizzle<typeof schema>>, userId: number, startedAt: Date, input: number, model = 'claude-opus-5-5'): void {
    const id = db.insert(schema.aiCallLog).values({
      startedAt, identityType: 'user', actorUserId: userId, effectiveScopes: [], pageContext: 'dashboard',
    }).returning({ id: schema.aiCallLog.id }).get().id;
    db.insert(schema.aiCallRequest).values({ callId: id, seq: 0, startedAt, model, providerType: 'anthropic', inputTokens: input }).run();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-cache-ttl-'));
    dbPath = join(dir, 'darkride.db');
    copyFileSync(template, dbPath);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a real database and prints the verdict for the chat that went quiet for twenty minutes', () => {
    const t0 = new Date(NOW.getTime() - 3 * 3600_000);
    seed((db, userId) => {
      addRun(db, userId, t0, 100_000);
      addRun(db, userId, new Date(t0.getTime() + 20 * 60_000), 110_000);
    });
    const text = runCacheTtlWhatIf({ dbPath, days: 7, now: NOW });
    expect(text).toContain('over the last 7 days');
    const row = text.split('\n').find((l) => l.startsWith('chat '))!;
    expect(row.split(/\s{2,}/).map((c) => c.trim())).toEqual(['chat', '2', '1', '1', '0', '20m 00s', '20m 00s', '$1.05', '$0.90', '$0.15', '1h']);
  });

  it('prices a model with the ai_model_prices setting', () => {
    const t0 = new Date(NOW.getTime() - 3600_000);
    seed((db, userId) => {
      db.insert(schema.settings).values({
        key: 'ai_model_prices', value: JSON.stringify({ 'house-model': { input: 10, output: 0, cacheRead: 1, cacheWrite: 12.5 } }),
      }).run();
      addRun(db, userId, t0, 1_000_000, 'house-model');
    });
    const text = runCacheTtlWhatIf({ dbPath, days: 7, now: NOW });
    expect(text.split('\n').find((l) => l.startsWith('chat '))).toContain('$12.50');
    expect(text).not.toContain('no known price');
  });

  it('leaves the database file byte for byte as it was', () => {
    const t0 = new Date(NOW.getTime() - 3600_000);
    seed((db, userId) => addRun(db, userId, t0, 5000));
    const before = readFileSync(dbPath);
    runCacheTtlWhatIf({ dbPath, days: 7, now: NOW });
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('says so when the window holds no requests', () => {
    seed(() => undefined);
    expect(runCacheTtlWhatIf({ dbPath, days: 7, now: NOW })).toBe('No AI requests recorded in the last 7 days.\n');
  });

  it('names the path when the database file is not there', () => {
    expect(() => runCacheTtlWhatIf({ dbPath: join(dir, 'missing.db'), days: 7, now: NOW })).toThrow(`No database at ${join(dir, 'missing.db')}`);
  });
});
