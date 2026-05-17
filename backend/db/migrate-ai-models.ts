import { eq } from 'drizzle-orm';
import type { AppDatabase } from './index';
import { settings, aiModels } from './schema';
import { createLoggers } from '../logs';

const { log } = createLoggers('migrate-ai-models');

/**
 * One-time migration: reads legacy ai_chat_provider / ai_provider settings
 * and inserts matching rows into the aiModels table if it's empty.
 * Does NOT delete old settings (they're still used by code completion).
 *
 * Uses raw SQL for INSERT because credential columns (api_key, base_url,
 * oauth_*) have been removed from the Drizzle schema but still exist in SQLite.
 */
export function migrateAiSettingsToModels(db: AppDatabase): void {
  const sqlite = (db as any).session?.client ?? (db as any).$client;
  if (!sqlite) return;

  // Only migrate if table is empty
  const existing = sqlite.prepare('SELECT id FROM ai_models LIMIT 1').all();
  if (existing.length > 0) return;

  const getVal = (key: string): string => {
    const row = db.select().from(settings).where(eq(settings.key, key)).all()[0];
    return row?.value ?? '';
  };

  const apiKeyMap: Record<string, string> = {
    anthropic: 'anthropic_api_key',
    gemini: 'gemini_api_key',
    openrouter: 'openrouter_api_key',
    codestral: 'codestral_api_key',
  };

  const providerNames: Record<string, string> = {
    anthropic: 'Anthropic',
    gemini: 'Google Gemini',
    ollama: 'Ollama',
    openrouter: 'OpenRouter',
    codestral: 'Codestral',
  };

  const insertStmt = sqlite.prepare(`
    INSERT INTO ai_models (name, provider, model, api_key, base_url,
      oauth_access_token, oauth_refresh_token, oauth_expires_at,
      priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const now = Date.now();

  // Migrate ai_chat_provider first (primary chat provider)
  const chatProvider = getVal('ai_chat_provider');
  if (chatProvider) {
    const name = providerNames[chatProvider] || chatProvider;
    insertStmt.run(
      `${name} (Chat)`,
      chatProvider,
      getVal('ai_chat_model') || null,
      getVal(apiKeyMap[chatProvider] || '') || null,
      chatProvider === 'ollama' ? (getVal('ollama_base_url') || null) : null,
      chatProvider === 'anthropic' ? (getVal('anthropic_oauth_access_token') || null) : null,
      chatProvider === 'anthropic' ? (getVal('anthropic_oauth_refresh_token') || null) : null,
      chatProvider === 'anthropic' && getVal('anthropic_oauth_expires_at')
        ? parseInt(getVal('anthropic_oauth_expires_at'))
        : null,
      count,
      now,
      now,
    );
    count++;
  }

  // Migrate ai_provider if different from chat provider
  const aiProvider = getVal('ai_provider');
  if (aiProvider && aiProvider !== chatProvider) {
    const name = providerNames[aiProvider] || aiProvider;
    insertStmt.run(
      `${name} (Fallback)`,
      aiProvider,
      getVal(`${aiProvider}_model`) || null,
      getVal(apiKeyMap[aiProvider] || '') || null,
      aiProvider === 'ollama' ? (getVal('ollama_base_url') || null) : null,
      aiProvider === 'anthropic' ? (getVal('anthropic_oauth_access_token') || null) : null,
      aiProvider === 'anthropic' ? (getVal('anthropic_oauth_refresh_token') || null) : null,
      aiProvider === 'anthropic' && getVal('anthropic_oauth_expires_at')
        ? parseInt(getVal('anthropic_oauth_expires_at'))
        : null,
      count,
      now,
      now,
    );
    count++;
  }

  if (count > 0) {
    log(`Migrated ${count} AI model(s) from legacy settings`);
  }
}
