import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { migrateAiSettingsToModels } from './migrate-ai-models';

const { settings } = schema;

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

function createTestDb() {
  const sqlite = new Database(':memory:');

  sqlite.exec(`
    CREATE TABLE ai_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      api_key TEXT,
      base_url TEXT,
      oauth_access_token TEXT,
      oauth_refresh_token TEXT,
      oauth_expires_at INTEGER,
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

    CREATE TABLE settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('migrateAiSettingsToModels', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    const created = createTestDb();
    sqlite = created.sqlite;
    db = created.db;
  });

  it('should do nothing when no legacy settings exist', () => {
    migrateAiSettingsToModels(db as any);
    const models = sqlite.prepare('SELECT * FROM ai_models').all();
    expect(models).toHaveLength(0);
  });

  it('should migrate ai_chat_provider setting', () => {
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'anthropic' }).run();
    db.insert(settings).values({ key: 'anthropic_api_key', value: 'sk-ant-legacy' }).run();
    db.insert(settings).values({ key: 'ai_chat_model', value: 'claude-sonnet-4-20250514' }).run();

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all() as any[];
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('Anthropic (Chat)');
    expect(models[0].provider).toBe('anthropic');
    expect(models[0].api_key).toBe('sk-ant-legacy');
    expect(models[0].model).toBe('claude-sonnet-4-20250514');
    expect(models[0].priority).toBe(0);
  });

  it('should migrate ai_provider as fallback when different from chat provider', () => {
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'anthropic' }).run();
    db.insert(settings).values({ key: 'anthropic_api_key', value: 'sk-ant-chat' }).run();
    db.insert(settings).values({ key: 'ai_provider', value: 'gemini' }).run();
    db.insert(settings).values({ key: 'gemini_api_key', value: 'AIza-fallback' }).run();

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models ORDER BY id').all() as any[];
    expect(models).toHaveLength(2);
    expect(models[0].name).toBe('Anthropic (Chat)');
    expect(models[0].priority).toBe(0);
    expect(models[1].name).toBe('Google Gemini (Fallback)');
    expect(models[1].provider).toBe('gemini');
    expect(models[1].api_key).toBe('AIza-fallback');
    expect(models[1].priority).toBe(1);
  });

  it('should not migrate ai_provider if same as chat provider', () => {
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'anthropic' }).run();
    db.insert(settings).values({ key: 'ai_provider', value: 'anthropic' }).run();
    db.insert(settings).values({ key: 'anthropic_api_key', value: 'sk-ant-key' }).run();

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all() as any[];
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('Anthropic (Chat)');
  });

  it('should not re-migrate if models already exist', () => {
    // Insert an existing model via raw SQL (includes credential columns)
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO ai_models (name, provider, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('Existing Model', 'anthropic', 0, now, now);

    // Add legacy settings that would normally be migrated
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'gemini' }).run();
    db.insert(settings).values({ key: 'gemini_api_key', value: 'AIza-should-not-migrate' }).run();

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all() as any[];
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('Existing Model');
  });

  it('should migrate ollama provider with base_url', () => {
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'ollama' }).run();
    db.insert(settings).values({ key: 'ollama_base_url', value: 'http://localhost:11434' }).run();
    db.insert(settings).values({ key: 'ai_chat_model', value: 'llama3.2' }).run();

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all() as any[];
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('Ollama (Chat)');
    expect(models[0].provider).toBe('ollama');
    expect(models[0].base_url).toBe('http://localhost:11434');
    expect(models[0].model).toBe('llama3.2');
    expect(models[0].api_key).toBeNull();
  });

  it('should migrate anthropic OAuth tokens', () => {
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'anthropic' }).run();
    db.insert(settings).values({ key: 'anthropic_oauth_access_token', value: 'access-token' }).run();
    db.insert(settings).values({ key: 'anthropic_oauth_refresh_token', value: 'refresh-token' }).run();
    db.insert(settings).values({ key: 'anthropic_oauth_expires_at', value: '1700000000000' }).run();

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all() as any[];
    expect(models).toHaveLength(1);
    expect(models[0].oauth_access_token).toBe('access-token');
    expect(models[0].oauth_refresh_token).toBe('refresh-token');
    expect(models[0].oauth_expires_at).toBe(1700000000000);
  });

  it('should migrate openrouter provider', () => {
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'openrouter' }).run();
    db.insert(settings).values({ key: 'openrouter_api_key', value: 'sk-or-key' }).run();

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all() as any[];
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('OpenRouter (Chat)');
    expect(models[0].provider).toBe('openrouter');
    expect(models[0].api_key).toBe('sk-or-key');
  });

  it('should migrate codestral provider', () => {
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'codestral' }).run();
    db.insert(settings).values({ key: 'codestral_api_key', value: 'cs-key' }).run();

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all() as any[];
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('Codestral (Chat)');
    expect(models[0].provider).toBe('codestral');
    expect(models[0].api_key).toBe('cs-key');
  });

  it('should migrate only ai_provider when ai_chat_provider is not set', () => {
    db.insert(settings).values({ key: 'ai_provider', value: 'gemini' }).run();
    db.insert(settings).values({ key: 'gemini_api_key', value: 'AIza-only' }).run();

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all() as any[];
    // ai_chat_provider is empty, so only ai_provider is migrated as fallback
    // But since chat provider is empty string, it differs from 'gemini'
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('Google Gemini (Fallback)');
    expect(models[0].priority).toBe(0);
  });

  it('should handle missing API key gracefully', () => {
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'anthropic' }).run();
    // No anthropic_api_key inserted

    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all() as any[];
    expect(models).toHaveLength(1);
    expect(models[0].api_key).toBeNull();
  });

  it('should be idempotent when called multiple times', () => {
    db.insert(settings).values({ key: 'ai_chat_provider', value: 'anthropic' }).run();
    db.insert(settings).values({ key: 'anthropic_api_key', value: 'sk-ant-key' }).run();

    migrateAiSettingsToModels(db as any);
    migrateAiSettingsToModels(db as any);

    const models = sqlite.prepare('SELECT * FROM ai_models').all();
    expect(models).toHaveLength(1);
  });
});
