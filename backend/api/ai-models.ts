import { asc, eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { aiModels, aiProviders, aiTiers } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { AiModelRouter } from '../services/ai-model-router';
import type { RateLimitCache } from '../services/ai-model-router';
import type { AiModelConfig } from '../../shared/types/ai-models';
import { getProviderDescriptor } from '../../shared/lib/ai-provider-catalog';
import { testModel } from '../services/ai/provider-ops';
import { cleanName } from './ai-providers';

/** A model name as stored: trimmed, with blank meaning "use the provider's default". */
function storedModel(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * A blank model falls back to the provider's default. A provider type without one (such as
 * openai-compatible, where every server names its own models) cannot run a blank row, so it is rejected
 * here rather than failing at request time. Returns the error, or null when the pair is valid. Types that
 * are no longer in the catalog are not checked: the router skips them anyway.
 */
function missingModelError(providerType: string, model: string | null): string | null {
  const d = getProviderDescriptor(providerType);
  if (!d || d.defaultModel || model !== null) return null;
  return `${d.label} has no default model. Choose a model.`;
}

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
    const cleanedName = cleanName(name);
    if (!cleanedName.ok) {
      res.status(400).json({ success: false, error: cleanedName.error });
      return;
    }

    // Lookup provider
    const provider = db.select().from(aiProviders).where(eq(aiProviders.id, providerId)).get();
    if (!provider) {
      res.status(400).json({ success: false, error: 'Provider not found' });
      return;
    }

    const modelName = storedModel(model);
    const modelError = missingModelError(provider.type, modelName);
    if (modelError) {
      res.status(400).json({ success: false, error: modelError });
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
      name: cleanedName.value,
      provider: provider.type,
      providerId,
      model: modelName,
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

    if (name !== undefined) {
      const cleanedName = cleanName(name);
      if (!cleanedName.ok) {
        res.status(400).json({ success: false, error: cleanedName.error });
        return;
      }
      updates.name = cleanedName.value;
    }
    let finalProvider: typeof aiProviders.$inferSelect | undefined;
    if (providerId !== undefined) {
      finalProvider = db.select().from(aiProviders).where(eq(aiProviders.id, providerId)).get();
      if (!finalProvider) {
        res.status(400).json({ success: false, error: 'Provider not found' });
        return;
      }
      updates.providerId = providerId;
      updates.provider = finalProvider.type;
    } else if (existing.providerId !== null) {
      finalProvider = db.select().from(aiProviders).where(eq(aiProviders.id, existing.providerId)).get();
    }
    const finalModel = model !== undefined ? storedModel(model) : storedModel(existing.model);
    // Checked on every PUT, not only when providerId or model is in the body. That is safe because every row
    // that predates this rule sits on a provider type with a default. If a type ever loses its default, its
    // blank rows need a data migration first, or they could no longer be edited (the toggle endpoint is unaffected).
    const modelError = finalProvider ? missingModelError(finalProvider.type, finalModel) : null;
    if (modelError) {
      res.status(400).json({ success: false, error: modelError });
      return;
    }
    if (model !== undefined) updates.model = storedModel(model);
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
      res.json(await testModel(provider, model));
    } catch (err: any) {
      res.json({ success: false, error: err?.message || 'Unknown error' });
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
