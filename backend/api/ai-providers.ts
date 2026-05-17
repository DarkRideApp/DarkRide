import { eq } from 'drizzle-orm';
import { spawn } from 'child_process';
import { registerEndpoint } from './api-service';
import { aiProviders, aiModels } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { AiProviderConfig } from '../../shared/types/ai-providers';
import { AI_PROVIDER_TYPES } from '../../shared/types/ai-providers';

function providerToResponse(row: typeof aiProviders.$inferSelect): AiProviderConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type as AiProviderConfig['type'],
    hasApiKey: !!row.apiKey,
    baseUrl: row.baseUrl,
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
  };
}

export function registerAiProviderEndpoints(db: AppDatabase): void {
  // GET /v1/ai/providers — list all (credentials masked)
  registerEndpoint('GET', '/v1/ai/providers', (_req, res) => {
    const providers = db.select().from(aiProviders).all();
    res.json({ success: true, data: providers.map(providerToResponse) });
  }, { requires: ['core.settings:read'] });

  // POST /v1/ai/providers — create
  registerEndpoint('POST', '/v1/ai/providers', (req, res) => {
    const { name, type, apiKey, baseUrl } = req.body;

    if (!name || !type) {
      res.status(400).json({ success: false, error: 'name and type are required' });
      return;
    }

    if (!AI_PROVIDER_TYPES.includes(type)) {
      res.status(400).json({ success: false, error: `Invalid type. Must be one of: ${AI_PROVIDER_TYPES.join(', ')}` });
      return;
    }

    const now = new Date();
    const result = db.insert(aiProviders).values({
      name,
      type,
      apiKey: apiKey || null,
      baseUrl: baseUrl || null,
      createdAt: now,
      updatedAt: now,
    }).run();

    const created = db.select().from(aiProviders).where(eq(aiProviders.id, Number(result.lastInsertRowid))).get();
    res.json({ success: true, data: created ? providerToResponse(created) : null });
  }, { requires: ['core.settings:write'] });

  // PUT /v1/ai/providers/:id — update
  registerEndpoint('PUT', '/v1/ai/providers/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    if (!existing) {
      res.status(404).json({ success: false, error: 'Provider not found' });
      return;
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    const { name, type, apiKey, baseUrl } = req.body;

    if (name !== undefined) updates.name = name;
    if (type !== undefined) {
      if (!AI_PROVIDER_TYPES.includes(type)) {
        res.status(400).json({ success: false, error: 'Invalid type' });
        return;
      }
      updates.type = type;
    }
    if (apiKey !== undefined) updates.apiKey = apiKey || null;
    if (baseUrl !== undefined) updates.baseUrl = baseUrl || null;

    db.update(aiProviders).set(updates).where(eq(aiProviders.id, id)).run();

    // If type changed, sync the denormalized provider string on linked models
    if (type !== undefined) {
      db.update(aiModels)
        .set({ provider: type, updatedAt: new Date() })
        .where(eq(aiModels.providerId, id))
        .run();
    }

    const updated = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    res.json({ success: true, data: updated ? providerToResponse(updated) : null });
  }, { requires: ['core.settings:write'] });

  // DELETE /v1/ai/providers/:id — delete (reject if models reference it)
  registerEndpoint('DELETE', '/v1/ai/providers/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    if (!existing) {
      res.status(404).json({ success: false, error: 'Provider not found' });
      return;
    }

    // Check if any models reference this provider
    const linkedModels = db.select().from(aiModels).where(eq(aiModels.providerId, id)).all();
    if (linkedModels.length > 0) {
      res.status(409).json({
        success: false,
        error: `Cannot delete provider: ${linkedModels.length} model(s) still reference it`,
      });
      return;
    }

    db.delete(aiProviders).where(eq(aiProviders.id, id)).run();
    res.json({ success: true });
  }, { requires: ['core.settings:write'] });

  // GET /v1/ai/providers/:id/models — list available models from provider
  registerEndpoint('GET', '/v1/ai/providers/:id/models', async (req, res) => {
    const id = parseInt(req.params.id);
    const provider = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found' });
      return;
    }

    try {
      const models = await fetchProviderModels(provider);
      res.json({ success: true, data: models });
    } catch (err: any) {
      res.json({ success: false, error: err.message || 'Failed to fetch models', data: [] });
    }
  }, { requires: ['core.settings:read'] });

  // POST /v1/ai/providers/:id/test — test connection
  registerEndpoint('POST', '/v1/ai/providers/:id/test', async (req, res) => {
    const id = parseInt(req.params.id);
    const provider = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found' });
      return;
    }

    try {
      const result = await testProviderConnection(provider);
      res.json(result);
    } catch (err: any) {
      res.json({ success: false, error: err.message || 'Unknown error' });
    }
  }, { requires: ['core.settings:write'] });
}

async function testProviderConnection(
  provider: typeof aiProviders.$inferSelect,
): Promise<{ success: true; model: string } | { success: false; error: string }> {
  const type = provider.type;
  const apiKey = provider.apiKey || undefined;
  const baseUrl = provider.baseUrl || undefined;

  try {
    switch (type) {
      case 'anthropic': {
        if (!apiKey) return { success: false, error: 'No Anthropic API key configured' };
        const m = 'claude-sonnet-4-20250514';
        return await callTestEndpoint(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        }, {
          model: m, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
        }, m);
      }

      case 'gemini': {
        if (!apiKey) return { success: false, error: 'No Gemini API key configured' };
        const m = 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
        return await callTestEndpoint(url, {}, {
          contents: [{ parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }, m);
      }

      case 'ollama': {
        const base = baseUrl || 'http://localhost:11434';
        const m = 'llama3.2';
        return await callTestEndpoint(`${base}/api/chat`, {}, {
          model: m, messages: [{ role: 'user', content: 'hi' }], stream: false,
          options: { num_predict: 1 },
        }, m);
      }

      case 'openrouter': {
        if (!apiKey) return { success: false, error: 'No OpenRouter API key configured' };
        const m = 'anthropic/claude-sonnet-4-20250514';
        return await callTestEndpoint('https://openrouter.ai/api/v1/chat/completions', {
          'Authorization': `Bearer ${apiKey}`,
        }, {
          model: m, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
        }, m);
      }

      case 'codestral': {
        if (!apiKey) return { success: false, error: 'No Codestral API key configured' };
        const m = 'codestral-latest';
        return await callTestEndpoint('https://codestral.mistral.ai/v1/chat/completions', {
          'Authorization': `Bearer ${apiKey}`,
        }, {
          model: m, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
        }, m);
      }

      case 'claude-cli': {
        return await new Promise((resolve) => {
          const env = apiKey
            ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: apiKey }
            : undefined;
          const child = spawn('claude', ['--version'], { env });
          const timer = setTimeout(() => {
            child.kill();
            resolve({ success: false, error: 'Claude CLI not found or not working' });
          }, 15000);
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
              resolve({ success: true, model: 'claude-cli' });
            } else {
              resolve({ success: false, error: 'Claude CLI not found or not working' });
            }
          });
          child.on('error', () => {
            clearTimeout(timer);
            resolve({ success: false, error: 'Claude CLI not found or not working' });
          });
        });
      }

      default:
        return { success: false, error: `Unknown provider type: ${type}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message || 'Unknown error' };
  }
}

async function callTestEndpoint(
  url: string,
  extraHeaders: Record<string, string>,
  body: any,
  model: string,
): Promise<{ success: true; model: string } | { success: false; error: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (res.ok || res.status === 429) {
    return { success: true, model };
  }

  const errorBody = await res.text();
  try {
    const parsed = JSON.parse(errorBody);
    const msg = parsed.error?.message || parsed.error?.type || parsed.error || errorBody;
    return { success: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  } catch {
    return { success: false, error: `HTTP ${res.status}: ${errorBody.slice(0, 200)}` };
  }
}

/** Fetch available model IDs from a provider's API. Returns {id, name} pairs. */
async function fetchProviderModels(
  provider: typeof aiProviders.$inferSelect,
): Promise<{ id: string; name: string }[]> {
  const type = provider.type;
  const apiKey = provider.apiKey || undefined;
  const baseUrl = provider.baseUrl || undefined;

  switch (type) {
    case 'anthropic': {
      if (!apiKey) throw new Error('No Anthropic API key configured');
      const res = await fetch(`${baseUrl || 'https://api.anthropic.com'}/v1/models`, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
      const data = await res.json() as { data?: { id: string; display_name?: string }[] };
      return (data.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
    }

    case 'ollama': {
      const base = baseUrl || 'http://localhost:11434';
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
      const data = await res.json() as { models?: { name: string; model: string }[] };
      return (data.models || []).map((m) => ({ id: m.model || m.name, name: m.name }));
    }

    case 'openrouter': {
      if (!apiKey) throw new Error('No OpenRouter API key configured');
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
      const data = await res.json() as { data?: { id: string; name: string }[] };
      return (data.data || []).map((m) => ({ id: m.id, name: m.name || m.id }));
    }

    case 'gemini': {
      if (!apiKey) throw new Error('No Gemini API key configured');
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
      const data = await res.json() as { models?: { name: string; displayName?: string }[] };
      return (data.models || []).map((m) => {
        // name is "models/gemini-2.0-flash" — strip the prefix
        const id = m.name.replace(/^models\//, '');
        return { id, name: m.displayName || id };
      });
    }

    case 'codestral': {
      if (!apiKey) throw new Error('No Codestral API key configured');
      const res = await fetch('https://codestral.mistral.ai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Codestral returned ${res.status}`);
      const data = await res.json() as { data?: { id: string }[] };
      return (data.data || []).map((m) => ({ id: m.id, name: m.id }));
    }

    case 'claude-cli':
      // Aliases always resolve to the latest model, so they never go stale.
      // Specific versions are useful for pinning to a known release.
      return [
        { id: 'opus', name: 'Claude Opus (Latest)' },
        { id: 'sonnet', name: 'Claude Sonnet (Latest)' },
        { id: 'haiku', name: 'Claude Haiku (Latest)' },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      ];

    default:
      return [];
  }
}
