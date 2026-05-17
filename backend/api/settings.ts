import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { settings } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { APK_RETENTION_FLOOR } from '../services/apk-retention';

const ALLOWED_KEYS = new Set([
  'nordvpn_username', 'nordvpn_password',
  'anthropic_api_key', 'gemini_api_key', 'openrouter_api_key', 'codestral_api_key',
  'ai_provider', 'ollama_base_url', 'ollama_model', 'openrouter_model',
  'ai_chat_provider', 'ai_chat_model',
  'anthropic_oauth_access_token', 'anthropic_oauth_refresh_token', 'anthropic_oauth_expires_at',
  'document_store_url', 'document_store_headers',
  'frida_default_version',
  'analysis_excluded_paths',
  'analysis_ai_prompt',
  'analysis_ai_autorun',
  'diff_ai_prompt',
  'diff_ai_autorun',
  'cloud_provider', 'cloud_endpoint', 'cloud_region', 'cloud_bucket',
  'cloud_access_key', 'cloud_secret_key', 'cloud_local_cache_mb',
  'analysis_tier_research', 'analysis_tier_write',
  'google_play_email', 'google_play_aas_token',
  'notification_base_url',
  'disk_space_threshold',
  'mcp_enabled',
  'oauth_public_base_url',
  'apk_local_retention_count',
]);
const PASSWORD_KEYS = new Set([
  'nordvpn_password',
  'anthropic_api_key', 'gemini_api_key', 'openrouter_api_key', 'codestral_api_key',
  'cloud_secret_key', 'cloud_access_key',
  'anthropic_oauth_access_token', 'anthropic_oauth_refresh_token',
  'google_play_aas_token',
]);

/** Register additional settings keys from plugins */
export function registerPluginSettings(keys: Array<{ key: string; secret?: boolean }>): void {
  for (const { key, secret } of keys) {
    ALLOWED_KEYS.add(key);
    if (secret) PASSWORD_KEYS.add(key);
  }
}

function maskValue(key: string, value: string): string {
  if (PASSWORD_KEYS.has(key)) return '********';
  return value;
}

interface SettingsDefaults {
  analysis_ai_prompt?: string;
  diff_ai_prompt?: string;
}

export function registerSettingsEndpoints(db: AppDatabase, defaults: SettingsDefaults = {}): void {
  // GET /v1/settings/list — list all settings (passwords masked)
  registerEndpoint('GET', '/v1/settings/list', (_req, res) => {
    const rows = db.select().from(settings).all();
    const data = rows.map((row) => ({
      key: row.key,
      value: maskValue(row.key, row.value),
    }));
    res.json({ success: true, data });
  }, { requires: ['core.settings:read'] });

  // GET /v1/settings/:key — get single setting (passwords masked)
  registerEndpoint('GET', '/v1/settings/:key', (req, res) => {
    const key = req.params.key;
    const row = db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .all()[0];

    if (!row) {
      res.status(404).json({ success: false, error: 'Setting not found' });
      return;
    }

    res.json({
      success: true,
      data: { key: row.key, value: maskValue(row.key, row.value) },
    });
  }, { requires: ['core.settings:read'] });

  // PUT /v1/settings/:key — upsert a setting
  registerEndpoint('PUT', '/v1/settings/:key', (req, res) => {
    const key = req.params.key;

    if (!ALLOWED_KEYS.has(key)) {
      res.status(400).json({ success: false, error: `Unknown setting key: ${key}` });
      return;
    }

    let { value } = req.body;
    if (value === undefined || typeof value !== 'string') {
      res.status(400).json({ success: false, error: 'value is required and must be a string' });
      return;
    }

    let warning: string | undefined;

    // Per-key validation and transformation
    if (key === 'apk_local_retention_count') {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < APK_RETENTION_FLOOR) {
        value = String(APK_RETENTION_FLOOR);
        warning = `apk_local_retention_count clamped up to ${APK_RETENTION_FLOOR} — that is the hard minimum.`;
      }
    }

    // Upsert: try update, if no rows affected then insert
    const existing = db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .all()[0];

    if (existing) {
      db.update(settings).set({ value }).where(eq(settings.key, key)).run();
    } else {
      db.insert(settings).values({ key, value }).run();
    }

    const response: any = {
      success: true,
      data: { key, value: maskValue(key, value) },
    };
    if (warning) {
      response.warning = warning;
    }

    res.json(response);
  }, { requires: ['core.settings:write'] });

  // DELETE /v1/settings/:key — delete a setting (revert to default)
  registerEndpoint('DELETE', '/v1/settings/:key', (req, res) => {
    const key = req.params.key;

    if (!ALLOWED_KEYS.has(key)) {
      res.status(400).json({ success: false, error: `Unknown setting key: ${key}` });
      return;
    }

    db.delete(settings).where(eq(settings.key, key)).run();
    res.json({ success: true });
  }, { requires: ['core.settings:write'] });

  // GET /v1/settings/defaults/:key — get the default value for a setting
  registerEndpoint('GET', '/v1/settings/defaults/:key', (req, res) => {
    const key = req.params.key;
    const defaultValue = (defaults as Record<string, string | undefined>)[key];

    if (defaultValue === undefined) {
      res.status(404).json({ success: false, error: `No default value for setting: ${key}` });
      return;
    }

    res.json({ success: true, data: { key, value: defaultValue } });
  }, { requires: ['core.settings:read'] });

}
