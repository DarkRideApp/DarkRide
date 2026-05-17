import { eq } from 'drizzle-orm';
import type { AppDatabase } from './index';
import { settings, aiProviders } from './schema';
import { createLoggers } from '../logs';

const { log } = createLoggers('migrate-ai-providers');

/**
 * Idempotent data migration: moves credentials from ai_models rows into
 * deduplicated ai_providers entries, and migrates legacy settings keys.
 *
 * Runs at startup after schema migrations. Uses raw SQL to read credential
 * columns that have been removed from the Drizzle schema on aiModels.
 */
export function migrateAiProviders(db: AppDatabase): void {
  const sqlite = (db as any).session?.client ?? (db as any).$client;
  if (!sqlite) return;

  // ── Ensure schema exists (Drizzle migrator may have skipped 0024) ──────
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      api_key TEXT,
      base_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Add provider_id column if missing (idempotent — PRAGMA check avoids duplicate ALTER)
  const cols: { name: string }[] = sqlite.prepare(`PRAGMA table_info(ai_models)`).all();
  if (!cols.some((c) => c.name === 'provider_id')) {
    sqlite.exec(`ALTER TABLE ai_models ADD COLUMN provider_id INTEGER REFERENCES ai_providers(id)`);
    log('Added provider_id column to ai_models');
  }

  // ── Step 1: Migrate existing ai_models rows that lack a provider_id ──
  const orphanedModels: {
    id: number;
    name: string;
    provider: string;
    api_key: string | null;
    base_url: string | null;
  }[] = sqlite.prepare(
    `SELECT id, name, provider, api_key, base_url
     FROM ai_models WHERE provider_id IS NULL`
  ).all();

  if (orphanedModels.length > 0) {
    // Group by (provider, api_key, base_url) to deduplicate
    const providerKey = (m: typeof orphanedModels[0]) =>
      `${m.provider}|${m.api_key ?? ''}|${m.base_url ?? ''}`;

    const grouped = new Map<string, typeof orphanedModels>();
    for (const m of orphanedModels) {
      const key = providerKey(m);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(m);
    }

    const providerNames: Record<string, string> = {
      anthropic: 'Anthropic',
      gemini: 'Google Gemini',
      ollama: 'Ollama',
      openrouter: 'OpenRouter',
      codestral: 'Codestral',
    };

    let count = 0;
    const now = new Date();

    for (const [, models] of grouped) {
      const first = models[0];

      // Check if a matching provider already exists
      const existingProvider = sqlite.prepare(
        `SELECT id FROM ai_providers WHERE type = ? AND COALESCE(api_key, '') = ? AND COALESCE(base_url, '') = ?`
      ).get(first.provider, first.api_key ?? '', first.base_url ?? '');

      let providerId: number;

      if (existingProvider) {
        providerId = (existingProvider as any).id;
      } else {
        const providerName = providerNames[first.provider] || first.provider;
        const result = db.insert(aiProviders).values({
          name: providerName,
          type: first.provider,
          apiKey: first.api_key || null,
          baseUrl: first.base_url || null,
          createdAt: now,
          updatedAt: now,
        }).run();
        providerId = Number(result.lastInsertRowid);
        count++;
      }

      // Link all models in this group to the provider
      for (const m of models) {
        sqlite.prepare(
          `UPDATE ai_models SET provider_id = ? WHERE id = ?`
        ).run(providerId, m.id);
      }
    }

    if (count > 0) {
      log(`Created ${count} AI provider(s) from existing model credentials`);
    }
  }

  // ── Step 2: Migrate legacy settings keys ─────────────────────────────
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

  // Collect providers that have API keys in settings
  const legacyProviderTypes = ['anthropic', 'gemini', 'openrouter', 'codestral', 'ollama'];
  const now = new Date();
  let legacyCount = 0;

  for (const providerType of legacyProviderTypes) {
    const apiKey = getVal(apiKeyMap[providerType] || '');
    const baseUrl = providerType === 'ollama' ? getVal('ollama_base_url') : '';

    // Skip if no credentials
    if (!apiKey && providerType !== 'ollama') continue;
    if (providerType === 'ollama' && !baseUrl) continue;

    // Check if a matching provider already exists
    const existing = sqlite.prepare(
      `SELECT id FROM ai_providers WHERE type = ? AND COALESCE(api_key, '') = ? AND COALESCE(base_url, '') = ?`
    ).get(providerType, apiKey, baseUrl);

    if (existing) continue;

    db.insert(aiProviders).values({
      name: `${providerNames[providerType] || providerType} (Settings)`,
      type: providerType,
      apiKey: apiKey || null,
      baseUrl: baseUrl || null,
      createdAt: now,
      updatedAt: now,
    }).run();
    legacyCount++;
  }

  if (legacyCount > 0) {
    log(`Migrated ${legacyCount} legacy settings provider(s) to ai_providers`);
  }
}
