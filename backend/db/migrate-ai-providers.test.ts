import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { migrateAiProviders } from './migrate-ai-providers';
import { applyMigrations } from '../test-utils/create-test-db';
import { AiModelRouter, RateLimitCache } from '../services/ai-model-router';
import { stubFetch, textResponse } from '../services/ai/test-helpers';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

function createTestDb() {
  const sqlite = new Database(':memory:');

  sqlite.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE ai_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      api_key TEXT,
      base_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE ai_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_id INTEGER REFERENCES ai_providers(id),
      model TEXT,
      api_key TEXT,
      base_url TEXT,
      oauth_access_token TEXT,
      oauth_refresh_token TEXT,
      oauth_expires_at INTEGER,
      enabled INTEGER DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      cooldown_minutes INTEGER DEFAULT 10,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('migrateAiProviders', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    const created = createTestDb();
    sqlite = created.sqlite;
    db = created.db;
  });

  it('should do nothing when no orphaned models and no legacy settings', () => {
    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT * FROM ai_providers').all();
    expect(providers).toHaveLength(0);
  });

  it('should create providers from orphaned model credentials', () => {
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, model, api_key, base_url, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('My Anthropic', 'anthropic', 'claude-sonnet-4-20250514', 'sk-ant-123', null, 0, now, now);

    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT * FROM ai_providers').all() as any[];
    expect(providers).toHaveLength(1);
    expect(providers[0].type).toBe('anthropic');
    expect(providers[0].api_key).toBe('sk-ant-123');
    expect(providers[0].name).toBe('Anthropic');

    // Model should be linked
    const models = sqlite.prepare('SELECT provider_id FROM ai_models').all() as any[];
    expect(models[0].provider_id).toBe(providers[0].id);
  });

  it('should deduplicate models sharing same credentials', () => {
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, model, api_key, base_url, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Claude Sonnet', 'anthropic', 'claude-sonnet-4-20250514', 'sk-ant-shared', null, 0, now, now);
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, model, api_key, base_url, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Claude Opus', 'anthropic', 'claude-opus-4-20250514', 'sk-ant-shared', null, 1, now, now);

    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT * FROM ai_providers').all() as any[];
    expect(providers).toHaveLength(1);

    // Both models linked to same provider
    const models = sqlite.prepare('SELECT provider_id FROM ai_models ORDER BY id').all() as any[];
    expect(models[0].provider_id).toBe(providers[0].id);
    expect(models[1].provider_id).toBe(providers[0].id);
  });

  it('should create separate providers for different credentials', () => {
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, model, api_key, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('Anthropic', 'anthropic', null, 'sk-ant-123', 0, now, now);
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, model, api_key, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('Gemini', 'gemini', null, 'gem-key-456', 1, now, now);

    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT * FROM ai_providers ORDER BY id').all() as any[];
    expect(providers).toHaveLength(2);
    expect(providers[0].type).toBe('anthropic');
    expect(providers[1].type).toBe('gemini');
  });

  it('should be idempotent — does not create duplicates on second run', () => {
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, model, api_key, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('My Anthropic', 'anthropic', null, 'sk-ant-123', 0, now, now);

    migrateAiProviders(db as any);
    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT * FROM ai_providers').all();
    expect(providers).toHaveLength(1);
  });

  it('should skip models that already have a provider_id', () => {
    const now = Date.now();
    // Create a provider first
    sqlite.prepare(`
      INSERT INTO ai_providers (name, type, api_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('Existing', 'anthropic', 'sk-ant-already', now, now);

    // Model already linked
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, provider_id, model, api_key, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Linked Model', 'anthropic', 1, null, 'sk-ant-already', 0, now, now);

    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT * FROM ai_providers').all();
    expect(providers).toHaveLength(1); // no new provider created
  });

  it('should migrate legacy settings API keys into providers', () => {
    sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('anthropic_api_key', 'sk-ant-from-settings');

    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT * FROM ai_providers').all() as any[];
    expect(providers).toHaveLength(1);
    expect(providers[0].type).toBe('anthropic');
    expect(providers[0].api_key).toBe('sk-ant-from-settings');
    expect(providers[0].name).toContain('Anthropic');
  });

  it('should not duplicate legacy settings providers if already migrated from models', () => {
    const now = Date.now();
    // Model has same key as settings
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, model, api_key, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('My Anthropic', 'anthropic', null, 'sk-ant-same', 0, now, now);
    sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('anthropic_api_key', 'sk-ant-same');

    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT * FROM ai_providers').all();
    expect(providers).toHaveLength(1);
  });

  it('drops a stale Base URL on OpenRouter and Gemini rows, keeping one provider per credential', () => {
    const now = Date.now();
    const insert = sqlite.prepare(`
      INSERT INTO ai_models (name, provider, model, api_key, base_url, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // The old form posted whatever was in the Base URL field, and these types ignored it.
    insert.run('Router A', 'openrouter', null, 'or-legacy-000000', 'http://localhost:11434', 0, now, now);
    insert.run('Router B', 'openrouter', null, 'or-legacy-000000', null, 1, now, now);
    insert.run('Gem', 'gemini', null, 'gem-legacy-000000', 'http://localhost:11434', 2, now, now);
    insert.run('Local', 'ollama', null, null, 'http://192.168.1.5:11434', 3, now, now);

    migrateAiProviders(db as any);
    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT type, base_url FROM ai_providers ORDER BY id').all();
    expect(providers).toEqual([
      { type: 'openrouter', base_url: null },
      { type: 'gemini', base_url: null },
      { type: 'ollama', base_url: 'http://192.168.1.5:11434' },   // a type that always used the field keeps it
    ]);
    const links = sqlite.prepare('SELECT provider_id FROM ai_models ORDER BY id').all() as any[];
    expect(links[0].provider_id).toBe(links[1].provider_id);
  });

  it('should migrate OAuth model without carrying OAuth fields (removed)', () => {
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, oauth_access_token, oauth_refresh_token, oauth_expires_at, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('OAuth Model', 'anthropic', 'oat-token', 'refresh-token', 9999999999, 0, now, now);

    migrateAiProviders(db as any);

    const providers = sqlite.prepare('SELECT * FROM ai_providers').all() as any[];
    expect(providers).toHaveLength(1);
    expect(providers[0].type).toBe('anthropic');
    // OAuth columns no longer exist in ai_providers schema
    expect(providers[0].oauth_access_token).toBeUndefined();
    expect(providers[0].oauth_refresh_token).toBeUndefined();
    expect(providers[0].oauth_expires_at).toBeUndefined();
  });
});

describe('upgrading a database with an OpenRouter model from before providers existed', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('stores no Base URL, so requests go to the OpenRouter default', async () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite);
    const now = Date.now();
    // Credentials on the model, no provider_id, and a stale Ollama URL left by the old form.
    sqlite.prepare(`INSERT INTO ai_models (name, provider, provider_id, model, api_key, base_url, enabled, priority, tier_id, created_at, updated_at)
      VALUES ('OpenRouter (Chat)', 'openrouter', NULL, NULL, 'or-legacy-000000', 'http://localhost:11434', 1, 0, 1, ?, ?)`).run(now, now);
    const db = drizzle(sqlite, { schema });

    migrateAiProviders(db as any);
    migrateAiProviders(db as any);

    expect(sqlite.prepare('SELECT type, base_url FROM ai_providers').all()).toEqual([{ type: 'openrouter', base_url: null }]);
    const stub = stubFetch(() => textResponse('{}', 418));
    const router = new AiModelRouter(db as any, new RateLimitCache());
    await (async () => {
      for await (const _ of router.createStreamingRequest([{ role: 'user', content: 'hi' }], '', [], { tier: 'High' })) { /* drain */ }
    })().catch(() => undefined);
    expect(stub.calls.map((c) => c.url)).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });
});
