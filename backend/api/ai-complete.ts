import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { settings } from '../db/schema';
import { buildAiReferencePrompt } from '../../shared/api-reference';
import type { AppDatabase } from '../db/index';
import type { AiModelRouter } from '../services/ai-model-router';
import { createProvider } from '../services/ai/registry';
import { AiProviderError, NoModelsConfiguredError } from '../services/ai/errors';
import { redact } from '../services/ai/http';
import type { AiCompleteRequest, AiProvider } from '../services/ai/dialect';
import { getProviderDescriptor } from '../../shared/lib/ai-provider-catalog';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('ai-complete');

let _cachedSystemPrompt: string | undefined;

function getSystemPrompt(): string {
  if (!_cachedSystemPrompt) {
    _cachedSystemPrompt =
      'You are a code completion engine for TypeScript automation scripts that control Android devices via a DeviceAPI. ' +
      'You receive code context with a `<CURSOR>` marker. Return ONLY the code that should be inserted at the cursor position. ' +
      'No explanations, no markdown fences, no repeating existing code.' +
      buildAiReferencePrompt();
  }
  return _cachedSystemPrompt;
}

const SYSTEM_PROMPT = getSystemPrompt();

function getSetting(db: AppDatabase, key: string): string | undefined {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .all()[0];
  return row?.value || undefined;
}

// ── Legacy settings (deprecated) ─────────────────────────────────────
// Installs that predate AI models configured completion through the `ai_provider` setting and one key
// setting per provider. That path stays, read-only, for installs with no Low tier model, and is built
// through the same registry as everything else.

interface LegacyConfig { keySetting?: string; urlSetting?: string; modelSetting?: string; model?: string; baseUrl?: string }

const LEGACY: Record<string, LegacyConfig> = {
  anthropic: { keySetting: 'anthropic_api_key', model: 'claude-haiku-4-5-20251001' },
  gemini: { keySetting: 'gemini_api_key' },                                                  // catalog default model
  ollama: { urlSetting: 'ollama_base_url', modelSetting: 'ollama_model', model: 'qwen2.5-coder:1.5b' },
  openrouter: { keySetting: 'openrouter_api_key', modelSetting: 'openrouter_model' },        // catalog default model
  // Legacy settings have no Base URL field, and these keys were issued for the Codestral host.
  codestral: { keySetting: 'codestral_api_key', model: 'codestral-latest', baseUrl: 'https://codestral.mistral.ai/v1' },
};

let warnedLegacy = false;

type Legacy = { provider: AiProvider } | { status: number; error: string } | null;

function legacyProvider(db: AppDatabase): Legacy {
  const type = getSetting(db, 'ai_provider');
  if (!type) return null;
  const cfg = Object.prototype.hasOwnProperty.call(LEGACY, type) ? LEGACY[type] : undefined;
  const d = getProviderDescriptor(type);
  if (!cfg || !d) return { status: 400, error: `Unknown AI provider: ${type}` };
  const apiKey = cfg.keySetting ? getSetting(db, cfg.keySetting) : undefined;
  if (cfg.keySetting && !apiKey) return { status: 400, error: `${d.shortName} API key not configured` };
  const baseUrl = (cfg.urlSetting ? getSetting(db, cfg.urlSetting) : undefined) ?? cfg.baseUrl;
  const model = (cfg.modelSetting ? getSetting(db, cfg.modelSetting) : undefined) ?? cfg.model;
  return { provider: createProvider(type, { apiKey, baseUrl, model }) };
}

// ── Handler ──────────────────────────────────────────────────────────

/**
 * POST /v1/ai/complete. Completes from the Low tier only (never a slower, more expensive tier), falling
 * back to the deprecated settings when no Low tier model exists. Status by error class: 400 for missing
 * configuration, 502 for any provider error (its message is already redacted by the transport), 500 with a
 * generic message for anything else. When the client goes away (the editor cancels on every keystroke) the
 * upstream call is aborted and nothing is written or logged as an error.
 *
 * Exported so it can be called with the minimal `res` the WebSocket REST adapter builds.
 */
export function completeHandler(db: AppDatabase, router: AiModelRouter) {
  return async (req: any, res: any): Promise<void> => {
    const { prefix, suffix } = req.body || {};
    if (!prefix && !suffix) {
      res.status(400).json({ success: false, error: 'prefix or suffix is required' });
      return;
    }

    const ac = new AbortController();
    // The WebSocket REST adapter's res has no event emitter. A close after the response finished is normal.
    if (typeof res.on === 'function') res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const gone = () => ac.signal.aborted;

    const request: AiCompleteRequest = {
      prefix: prefix || '',
      suffix: suffix || '',
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: 256,
      stopSequences: ['\n\n\n'],
      temperature: 0,
      signal: ac.signal,
    };

    try {
      let completion: string;
      try {
        completion = await router.completeText(request, { tier: 'Low', strict: true });
      } catch (err) {
        if (!(err instanceof NoModelsConfiguredError)) throw err;
        const legacy = legacyProvider(db);
        if (!legacy) {
          res.status(400).json({ success: false, error: 'No AI provider configured' });
          return;
        }
        if ('error' in legacy) {
          res.status(legacy.status).json({ success: false, error: legacy.error });
          return;
        }
        // The editor asks for a completion every few hundred milliseconds while typing: say it once per process.
        if (!warnedLegacy) {
          warnedLegacy = true;
          log('Using deprecated ai_provider settings for /v1/ai/complete; add a model to the Low tier instead');
        }
        completion = await legacy.provider.complete(request);
      }
      // A provider that drains a stream returns partial text on abort; the client is gone either way.
      if (gone()) return;
      res.json({ success: true, data: { completion } });
    } catch (err: any) {
      if (gone()) return;
      if (err instanceof AiProviderError) {
        log(`Completion failed: ${err.name}`);
        res.status(502).json({ success: false, error: err.message || err.name });
        return;
      }
      // Not a classified provider failure, so the message may hold anything: keep it in the server log only.
      // Masked and capped anyway, since log lines are streamed to live log viewers.
      error(`Completion failed unexpectedly: ${err?.name ?? 'Error'}: ${redact(String(err?.message ?? err)).slice(0, 500)}`);
      res.status(500).json({ success: false, error: 'Inline completion failed' });
    }
  };
}

export function registerAiCompleteEndpoints(db: AppDatabase, router: AiModelRouter): void {
  registerEndpoint('POST', '/v1/ai/complete', completeHandler(db, router));
}
