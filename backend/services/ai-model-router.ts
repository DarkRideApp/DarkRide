import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';
import { aiModels, aiProviders, aiTiers } from '../db/schema';
import {
  createProvider,
  RateLimitError,
  parseRateLimitHeaders,
  type AiProvider,
  type AiProviderConfig,
  type ParsedRateLimitHeaders,
} from './ai-provider';
import type {
  AiMessage,
  AiToolDefinition,
  AiStreamEvent,
} from '../../shared/types/ai-chat';
import type { AiRateLimitInfo } from '../../shared/types/ai-models';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('ai-model-router');

// ── Rate limit cache ─────────────────────────────────────────────────

interface RateLimitEntry {
  headers: ParsedRateLimitHeaders | null;
  last429At: number | null;
}

export class RateLimitCache {
  private cache = new Map<number, RateLimitEntry>();

  get(modelId: number): RateLimitEntry | undefined {
    return this.cache.get(modelId);
  }

  set(modelId: number, entry: RateLimitEntry): void {
    this.cache.set(modelId, entry);
  }

  record429(modelId: number, headers?: Headers, provider?: string): void {
    const existing = this.cache.get(modelId);
    const parsed = headers && provider ? parseRateLimitHeaders(provider, headers) : null;
    this.cache.set(modelId, {
      headers: parsed ?? existing?.headers ?? null,
      last429At: Date.now(),
    });
  }

  recordSuccess(modelId: number, headers: Headers | undefined, provider: string): void {
    const parsed = headers ? parseRateLimitHeaders(provider, headers) : null;
    const existing = this.cache.get(modelId);
    this.cache.set(modelId, {
      headers: parsed ?? existing?.headers ?? null,
      last429At: existing?.last429At ?? null,
    });
  }

  isInCooldown(modelId: number, cooldownMinutes: number): boolean {
    const entry = this.cache.get(modelId);
    if (!entry?.last429At) return false;
    const cooldownMs = cooldownMinutes * 60 * 1000;
    return Date.now() - entry.last429At < cooldownMs;
  }

  cooldownEndsAt(modelId: number, cooldownMinutes: number): number | null {
    const entry = this.cache.get(modelId);
    if (!entry?.last429At) return null;
    const endsAt = entry.last429At + cooldownMinutes * 60 * 1000;
    return endsAt > Date.now() ? endsAt : null;
  }

  getAll(): Map<number, RateLimitEntry> {
    return this.cache;
  }
}

// ── AiModelRouter ────────────────────────────────────────────────────

export class AiModelRouter {
  constructor(
    private db: AppDatabase,
    private rateLimitCache: RateLimitCache,
  ) {}

  getModels() {
    return this.db
      .select()
      .from(aiModels)
      .orderBy(asc(aiModels.priority))
      .all();
  }

  getEnabledModels() {
    return this.db
      .select()
      .from(aiModels)
      .where(eq(aiModels.enabled, true))
      .orderBy(asc(aiModels.priority))
      .all();
  }

  getRateLimits(): AiRateLimitInfo[] {
    const models = this.getModels();
    return models.map((m) => {
      const entry = this.rateLimitCache.get(m.id);
      const cooldownMins = m.cooldownMinutes ?? 10;
      return {
        modelId: m.id,
        modelName: m.name,
        provider: m.provider,
        inCooldown: this.rateLimitCache.isInCooldown(m.id, cooldownMins),
        cooldownEndsAt: this.rateLimitCache.cooldownEndsAt(m.id, cooldownMins),
        requestsLimit: entry?.headers?.requestsLimit ?? null,
        requestsRemaining: entry?.headers?.requestsRemaining ?? null,
        requestsReset: entry?.headers?.requestsReset ?? null,
        tokensLimit: entry?.headers?.tokensLimit ?? null,
        tokensRemaining: entry?.headers?.tokensRemaining ?? null,
        tokensReset: entry?.headers?.tokensReset ?? null,
      };
    });
  }

  /**
   * Returns the enabled models for the requested tier name, falling down
   * (to higher sort_order = cheaper) then up (to lower sort_order = more
   * capable) when the requested tier is empty. Throws when every tier is
   * empty. An unknown tier name is treated as "empty" and follows the
   * same fallback path.
   */
  getModelsForTier(tierName: string) {
    const allTiers = this.db.select().from(aiTiers).orderBy(asc(aiTiers.sortOrder)).all();
    if (allTiers.length === 0) {
      throw new Error('No AI models configured. Add one in Settings → Integrations.');
    }

    const requested = allTiers.find(t => t.name === tierName);
    const orderedFallback: typeof allTiers = [];
    if (requested) {
      orderedFallback.push(requested);
      orderedFallback.push(...allTiers.filter(t => t.sortOrder > requested.sortOrder).sort((a, b) => a.sortOrder - b.sortOrder));
      orderedFallback.push(...allTiers.filter(t => t.sortOrder < requested.sortOrder).sort((a, b) => b.sortOrder - a.sortOrder));
    } else {
      orderedFallback.push(...allTiers);
    }

    for (const tier of orderedFallback) {
      const models = this.db.select().from(aiModels)
        .where(and(eq(aiModels.tierId, tier.id), eq(aiModels.enabled, true)))
        .orderBy(asc(aiModels.priority))
        .all();
      if (models.length > 0) return models;
    }

    throw new Error('No AI models configured. Add one in Settings → Integrations.');
  }

  async *createStreamingRequest(
    messages: AiMessage[],
    systemPrompt: string,
    tools: AiToolDefinition[],
    options?: { signal?: AbortSignal; tier?: string },
  ): AsyncIterable<AiStreamEvent> {
    const models = this.getModelsForTier(options?.tier ?? 'High');

    // Preload all providers into a map for efficient lookup
    const allProviders = this.db.select().from(aiProviders).all();
    const providerMap = new Map<number, typeof aiProviders.$inferSelect>();
    for (const p of allProviders) providerMap.set(p.id, p);

    const errors: string[] = [];

    for (const model of models) {
      const cooldownMins = model.cooldownMinutes ?? 10;

      // Skip claude-cli models — they use ClaudeCliAgent, not HTTP streaming
      if (model.provider === 'claude-cli') {
        errors.push(`${model.name}: uses claude-cli which does not support HTTP streaming`);
        continue;
      }

      // Skip models in cooldown
      if (this.rateLimitCache.isInCooldown(model.id, cooldownMins)) {
        const endsAt = this.rateLimitCache.cooldownEndsAt(model.id, cooldownMins);
        const minsLeft = endsAt ? Math.ceil((endsAt - Date.now()) / 60000) : '?';
        errors.push(`${model.name}: in cooldown (${minsLeft}m left)`);
        continue;
      }

      // Skip models without a linked provider
      if (!model.providerId) {
        errors.push(`${model.name}: no provider linked`);
        continue;
      }

      const providerRow = providerMap.get(model.providerId);
      if (!providerRow) {
        errors.push(`${model.name}: provider not found`);
        continue;
      }

      try {
        const provider = this.createProviderForModel(model, providerRow);
        const stream = provider.createStreamingRequest(messages, systemPrompt, tools, options);

        // Yield all events from the stream
        for await (const event of stream) {
          yield event;
        }

        // Success — capture response headers
        this.rateLimitCache.recordSuccess(model.id, provider.lastResponseHeaders, model.provider);
        log(`Request served by model "${model.name}" (${model.provider})`);
        return;
      } catch (err: any) {
        if (err instanceof RateLimitError) {
          log(`Model "${model.name}" rate limited (429), trying next...`);
          this.rateLimitCache.record429(model.id, err.headers, model.provider);
          errors.push(`${model.name}: rate limited`);
          continue;
        }

        // Non-rate-limit error — don't try fallback, rethrow
        throw err;
      }
    }

    // All models exhausted
    throw new Error(
      `All AI models are rate-limited or unavailable:\n${errors.join('\n')}`,
    );
  }

  /**
   * Create a provider for a specific model ID (bypasses cooldown/enabled checks).
   * Used by tiered model routing where the caller picks specific models.
   */
  createProviderForModelId(modelId: number): AiProvider {
    const model = this.db
      .select()
      .from(aiModels)
      .where(eq(aiModels.id, modelId))
      .all()[0];

    if (!model) {
      throw new Error(`AI model with id ${modelId} not found`);
    }

    if (model.provider === 'claude-cli') {
      throw new Error(`Model "${model.name}" uses claude-cli which does not support HTTP streaming. Use ClaudeCliAgent instead.`);
    }

    if (!model.providerId) {
      throw new Error(`AI model "${model.name}" has no provider linked`);
    }

    const providerRow = this.db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.id, model.providerId))
      .all()[0];

    if (!providerRow) {
      throw new Error(`Provider for AI model "${model.name}" not found`);
    }

    return this.createProviderForModel(model, providerRow);
  }

  private createProviderForModel(
    model: typeof aiModels.$inferSelect,
    providerRow: typeof aiProviders.$inferSelect,
  ): AiProvider {
    const db = this.db;
    const config: AiProviderConfig = {
      apiKey: providerRow.apiKey ?? undefined,
      baseUrl: providerRow.baseUrl ?? undefined,
      model: model.model ?? undefined,
    };

    return createProvider(model.provider, config);
  }
}
