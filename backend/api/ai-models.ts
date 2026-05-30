import { asc, eq } from 'drizzle-orm';
import { ClaudeCliProvider } from '../services/claude-cli-provider';
import { registerEndpoint } from './api-service';
import { aiModels, aiProviders, aiTiers } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { AiModelRouter } from '../services/ai-model-router';
import type { RateLimitCache } from '../services/ai-model-router';
import type { AiModelConfig } from '../../shared/types/ai-models';

export function registerAiModelEndpoints(
  db: AppDatabase,
  router: AiModelRouter,
  rateLimitCache: RateLimitCache,
): void {
  // GET /v1/ai/models — list all models
  registerEndpoint('GET', '/v1/ai/models', (_req, res) => {
    const rows = db.select({
      id: aiModels.id,
      name: aiModels.name,
      provider: aiModels.provider,
      providerId: aiModels.providerId,
      providerName: aiProviders.name,
      model: aiModels.model,
      enabled: aiModels.enabled,
      priority: aiModels.priority,
      cooldownMinutes: aiModels.cooldownMinutes,
      tierId: aiModels.tierId,
      tierName: aiTiers.name,
      createdAt: aiModels.createdAt,
      updatedAt: aiModels.updatedAt,
    })
      .from(aiModels)
      .leftJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
      .leftJoin(aiTiers, eq(aiModels.tierId, aiTiers.id))
      .orderBy(asc(aiModels.priority))
      .all();

    const data: AiModelConfig[] = rows.map(row => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      providerId: row.providerId ?? null,
      providerName: row.providerName ?? null,
      model: row.model ?? null,
      enabled: row.enabled ?? true,
      priority: row.priority,
      cooldownMinutes: row.cooldownMinutes ?? 10,
      tierId: row.tierId ?? null,
      tierName: row.tierName ?? null,
      createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
    }));

    res.json({ success: true, data });
  }, { requires: ['core.settings:read'] });

  // POST /v1/ai/models — create model config
  registerEndpoint('POST', '/v1/ai/models', (req, res) => {
    const { name, providerId, model, enabled, cooldownMinutes, tierId } = req.body;

    if (!name || !providerId) {
      res.status(400).json({ success: false, error: 'name and providerId are required' });
      return;
    }

    // Lookup provider
    const provider = db.select().from(aiProviders).where(eq(aiProviders.id, providerId)).get();
    if (!provider) {
      res.status(400).json({ success: false, error: 'Provider not found' });
      return;
    }

    // Default to the High tier's id if tierId not provided OR explicitly null.
    // The UI's add-model form initializes tierId to null until the tiers list
    // loads; an early submit posts tierId: null, which must not orphan the
    // model (orphans are invisible to the tier-aware queries that drive the
    // TierPicker's enabledModelCount and the AiModelRouter's fallback chain).
    const resolvedTierId: number | null = (tierId !== undefined && tierId !== null)
      ? tierId
      : (db.select().from(aiTiers).where(eq(aiTiers.name, 'High')).get()?.id ?? null);

    // Determine priority: one more than the current max
    const allModels = router.getModels();
    const maxPriority = allModels.reduce((max, m) => Math.max(max, m.priority), -1);

    const now = new Date();
    const result = db.insert(aiModels).values({
      name,
      provider: provider.type,
      providerId,
      model: model || null,
      enabled: enabled !== false,
      priority: maxPriority + 1,
      cooldownMinutes: cooldownMinutes ?? 10,
      tierId: resolvedTierId,
      createdAt: now,
      updatedAt: now,
    }).run();

    const createdId = Number(result.lastInsertRowid);
    const createdRows = db.select({
      id: aiModels.id,
      name: aiModels.name,
      provider: aiModels.provider,
      providerId: aiModels.providerId,
      providerName: aiProviders.name,
      model: aiModels.model,
      enabled: aiModels.enabled,
      priority: aiModels.priority,
      cooldownMinutes: aiModels.cooldownMinutes,
      tierId: aiModels.tierId,
      tierName: aiTiers.name,
      createdAt: aiModels.createdAt,
      updatedAt: aiModels.updatedAt,
    })
      .from(aiModels)
      .leftJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
      .leftJoin(aiTiers, eq(aiModels.tierId, aiTiers.id))
      .where(eq(aiModels.id, createdId))
      .all();

    const row = createdRows[0];
    const data: AiModelConfig | null = row
      ? {
          id: row.id,
          name: row.name,
          provider: row.provider,
          providerId: row.providerId ?? null,
          providerName: row.providerName ?? null,
          model: row.model ?? null,
          enabled: row.enabled ?? true,
          priority: row.priority,
          cooldownMinutes: row.cooldownMinutes ?? 10,
          tierId: row.tierId ?? null,
          tierName: row.tierName ?? null,
          createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
        }
      : null;

    res.json({ success: true, data });
  }, { requires: ['core.settings:write'] });

  // PUT /v1/ai/models/reorder — reorder by array of ids
  // MUST be registered before /:id to avoid Express matching "reorder" as :id
  registerEndpoint('PUT', '/v1/ai/models/reorder', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      res.status(400).json({ success: false, error: 'ids must be an array' });
      return;
    }

    const now = new Date();
    for (let i = 0; i < ids.length; i++) {
      db.update(aiModels)
        .set({ priority: i, updatedAt: now })
        .where(eq(aiModels.id, ids[i]))
        .run();
    }

    const models = router.getModels();
    const providerMap = buildProviderMap(db);
    res.json({ success: true, data: models.map(m => modelToResponseLegacy(m, providerMap)) });
  }, { requires: ['core.settings:write'] });

  // PUT /v1/ai/models/:id — update model config
  registerEndpoint('PUT', '/v1/ai/models/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = db.select().from(aiModels).where(eq(aiModels.id, id)).get();
    if (!existing) {
      res.status(404).json({ success: false, error: 'Model not found' });
      return;
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    const { name, providerId, model, enabled, cooldownMinutes, tierId } = req.body;

    if (name !== undefined) updates.name = name;
    if (providerId !== undefined) {
      const provider = db.select().from(aiProviders).where(eq(aiProviders.id, providerId)).get();
      if (!provider) {
        res.status(400).json({ success: false, error: 'Provider not found' });
        return;
      }
      updates.providerId = providerId;
      updates.provider = provider.type;
    }
    if (model !== undefined) updates.model = model || null;
    if (enabled !== undefined) updates.enabled = enabled;
    if (cooldownMinutes !== undefined) updates.cooldownMinutes = cooldownMinutes;
    if (tierId !== undefined) {
      // Symmetrical to POST: a PUT body explicitly setting tierId: null must
      // fall back to High rather than orphan the model. (See POST handler
      // for the rationale.)
      updates.tierId = tierId !== null
        ? tierId
        : (db.select().from(aiTiers).where(eq(aiTiers.name, 'High')).get()?.id ?? null);
    }

    db.update(aiModels).set(updates).where(eq(aiModels.id, id)).run();

    const updatedRows = db.select({
      id: aiModels.id,
      name: aiModels.name,
      provider: aiModels.provider,
      providerId: aiModels.providerId,
      providerName: aiProviders.name,
      model: aiModels.model,
      enabled: aiModels.enabled,
      priority: aiModels.priority,
      cooldownMinutes: aiModels.cooldownMinutes,
      tierId: aiModels.tierId,
      tierName: aiTiers.name,
      createdAt: aiModels.createdAt,
      updatedAt: aiModels.updatedAt,
    })
      .from(aiModels)
      .leftJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
      .leftJoin(aiTiers, eq(aiModels.tierId, aiTiers.id))
      .where(eq(aiModels.id, id))
      .all();

    const row = updatedRows[0];
    const data: AiModelConfig | null = row
      ? {
          id: row.id,
          name: row.name,
          provider: row.provider,
          providerId: row.providerId ?? null,
          providerName: row.providerName ?? null,
          model: row.model ?? null,
          enabled: row.enabled ?? true,
          priority: row.priority,
          cooldownMinutes: row.cooldownMinutes ?? 10,
          tierId: row.tierId ?? null,
          tierName: row.tierName ?? null,
          createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
        }
      : null;

    res.json({ success: true, data });
  }, { requires: ['core.settings:write'] });

  // DELETE /v1/ai/models/:id — delete model config
  registerEndpoint('DELETE', '/v1/ai/models/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = db.select().from(aiModels).where(eq(aiModels.id, id)).get();
    if (!existing) {
      res.status(404).json({ success: false, error: 'Model not found' });
      return;
    }

    db.delete(aiModels).where(eq(aiModels.id, id)).run();
    res.json({ success: true });
  }, { requires: ['core.settings:write'] });

  // PUT /v1/ai/models/:id/toggle — toggle enabled
  registerEndpoint('PUT', '/v1/ai/models/:id/toggle', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = db.select().from(aiModels).where(eq(aiModels.id, id)).get();
    if (!existing) {
      res.status(404).json({ success: false, error: 'Model not found' });
      return;
    }

    const newEnabled = !(existing.enabled ?? true);
    db.update(aiModels).set({ enabled: newEnabled, updatedAt: new Date() }).where(eq(aiModels.id, id)).run();

    const updatedRows = db.select({
      id: aiModels.id,
      name: aiModels.name,
      provider: aiModels.provider,
      providerId: aiModels.providerId,
      providerName: aiProviders.name,
      model: aiModels.model,
      enabled: aiModels.enabled,
      priority: aiModels.priority,
      cooldownMinutes: aiModels.cooldownMinutes,
      tierId: aiModels.tierId,
      tierName: aiTiers.name,
      createdAt: aiModels.createdAt,
      updatedAt: aiModels.updatedAt,
    })
      .from(aiModels)
      .leftJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
      .leftJoin(aiTiers, eq(aiModels.tierId, aiTiers.id))
      .where(eq(aiModels.id, id))
      .all();

    const row = updatedRows[0];
    const data: AiModelConfig | null = row
      ? {
          id: row.id,
          name: row.name,
          provider: row.provider,
          providerId: row.providerId ?? null,
          providerName: row.providerName ?? null,
          model: row.model ?? null,
          enabled: row.enabled ?? true,
          priority: row.priority,
          cooldownMinutes: row.cooldownMinutes ?? 10,
          tierId: row.tierId ?? null,
          tierName: row.tierName ?? null,
          createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
        }
      : null;

    res.json({ success: true, data });
  }, { requires: ['core.settings:write'] });

  // POST /v1/ai/models/:id/test — test connection via linked provider
  registerEndpoint('POST', '/v1/ai/models/:id/test', async (req, res) => {
    const id = parseInt(req.params.id);
    const model = db.select().from(aiModels).where(eq(aiModels.id, id)).get();
    if (!model) {
      res.status(404).json({ success: false, error: 'Model not found' });
      return;
    }

    if (!model.providerId) {
      res.json({ success: false, error: 'Model has no linked provider' });
      return;
    }

    const provider = db.select().from(aiProviders).where(eq(aiProviders.id, model.providerId)).get();
    if (!provider) {
      res.json({ success: false, error: 'Linked provider not found' });
      return;
    }

    try {
      const result = await testModelConnection(provider, model);
      res.json(result);
    } catch (err: any) {
      res.json({ success: false, error: err.message || 'Unknown error' });
    }
  }, { requires: ['core.settings:write'] });

  // GET /v1/ai/rate-limits — rate limit info for all models
  registerEndpoint('GET', '/v1/ai/rate-limits', (_req, res) => {
    res.json({ success: true, data: router.getRateLimits() });
  }, { requires: ['core.settings:read'] });
}

// Legacy helper used only by the reorder endpoint (returns plain model row shape)
function modelToResponseLegacy(
  row: typeof aiModels.$inferSelect,
  providerMap: Map<number, typeof aiProviders.$inferSelect>,
): AiModelConfig {
  const provider = row.providerId ? providerMap.get(row.providerId) : undefined;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    providerId: row.providerId ?? null,
    providerName: provider?.name ?? null,
    model: row.model ?? null,
    enabled: row.enabled ?? true,
    priority: row.priority,
    cooldownMinutes: row.cooldownMinutes ?? 10,
    tierId: row.tierId ?? null,
    tierName: null, // reorder doesn't join tiers; tierName not needed for reorder response
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
  };
}

function buildProviderMap(db: AppDatabase): Map<number, typeof aiProviders.$inferSelect> {
  const all = db.select().from(aiProviders).all();
  const map = new Map<number, typeof aiProviders.$inferSelect>();
  for (const p of all) map.set(p.id, p);
  return map;
}

async function testModelConnection(
  provider: typeof aiProviders.$inferSelect,
  model: typeof aiModels.$inferSelect,
): Promise<{ success: true; model: string } | { success: false; error: string }> {
  const type = provider.type;
  const apiKey = provider.apiKey || undefined;
  const modelName = model.model;
  const baseUrl = provider.baseUrl || undefined;

  try {
    switch (type) {
      case 'anthropic': {
        if (!apiKey) return { success: false, error: 'No Anthropic API key configured' };
        const m = modelName || 'claude-sonnet-4-20250514';
        return await callTestEndpoint(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        }, {
          model: m, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
        }, m);
      }

      case 'gemini': {
        if (!apiKey) return { success: false, error: 'No Gemini API key configured' };
        const m = modelName || 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
        return await callTestEndpoint(url, {}, {
          contents: [{ parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }, m);
      }

      case 'ollama': {
        const base = baseUrl || 'http://localhost:11434';
        const m = modelName || 'llama3.2';
        return await callTestEndpoint(`${base}/api/chat`, {}, {
          model: m, messages: [{ role: 'user', content: 'hi' }], stream: false,
          options: { num_predict: 1 },
        }, m);
      }

      case 'openrouter': {
        if (!apiKey) return { success: false, error: 'No OpenRouter API key configured' };
        const m = modelName || 'anthropic/claude-sonnet-4-20250514';
        return await callTestEndpoint('https://openrouter.ai/api/v1/chat/completions', {
          'Authorization': `Bearer ${apiKey}`,
        }, {
          model: m, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
        }, m);
      }

      case 'codestral': {
        if (!apiKey) return { success: false, error: 'No Codestral API key configured' };
        const m = modelName || 'codestral-latest';
        return await callTestEndpoint('https://codestral.mistral.ai/v1/chat/completions', {
          'Authorization': `Bearer ${apiKey}`,
        }, {
          model: m, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
        }, m);
      }

      case 'claude-cli': {
        // Claude Code models run via the local `claude` CLI, not an HTTP
        // endpoint. apiKey, when set, is a CLAUDE_CODE_OAUTH_TOKEN. Verify both
        // that the binary works AND that it can actually drive a tool with this
        // auth — a wrong/stale token authenticates but text-leaks tool calls,
        // so a version check alone would falsely pass.
        const version = await ClaudeCliProvider.getVersion(apiKey);
        if (!version) return { success: false, error: 'Claude CLI not found or not working' };
        const tool = await ClaudeCliProvider.testToolUse(apiKey, modelName || 'sonnet');
        if (!tool.ok) return { success: false, error: tool.reason || 'Claude CLI cannot use tools' };
        return { success: true, model: modelName || 'claude-cli' };
      }

      default:
        return { success: false, error: `Unknown provider: ${type}` };
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
