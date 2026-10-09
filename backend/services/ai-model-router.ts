import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';
import { aiModels, aiProviders, aiTiers } from '../db/schema';
import {
  AiProviderError,
  AllModelsFailedError,
  AuthError,
  ConnectionError,
  ModelRefusedError,
  NoModelsConfiguredError,
  QuotaExhaustedError,
  RateLimitError,
  UnknownProviderError,
  isFallbackEligible,
} from './ai/errors';
import { parseRateLimitHeaders, type ParsedRateLimitHeaders } from './ai/rate-limit';
import { createProvider } from './ai/registry';
import type { AiCompleteRequest, AiProvider, AiProviderConfig, AiStreamingProvider, AiStreamOptions } from './ai/dialect';
import { isCliProvider, isKnownProviderType } from '../../shared/lib/ai-provider-catalog';
import type {
  AiMessage,
  AiToolDefinition,
  AiStreamEvent,
} from '../../shared/types/ai-chat';
import type { AiRateLimitInfo } from '../../shared/types/ai-models';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('ai-model-router');

type ModelRow = typeof aiModels.$inferSelect;
type ProviderRow = typeof aiProviders.$inferSelect;
interface Attempt { model: string; error: string }

const CLI_SKIP_REASON = 'uses claude-cli which does not support HTTP streaming';

/** True when the caller's own signal has fired: whatever the provider threw or returned, it is not a provider failure. */
const callerAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** True when two reads of a provider row describe the same credential and endpoint. */
const sameCredential = (a: ProviderRow, b: ProviderRow): boolean =>
  a.type === b.type
  && (a.apiKey ?? null) === (b.apiKey ?? null)
  && (a.baseUrl ?? null) === (b.baseUrl ?? null)
  && a.updatedAt?.getTime() === b.updatedAt?.getTime();

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
    // A rate limit reported inside a stream has an empty Headers object. Parsing it would give an all-null
    // result that wipes the last known limits, so only parse headers that actually hold something.
    const parsed = headers && provider && [...headers.keys()].length > 0 ? parseRateLimitHeaders(provider, headers) : null;
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

  /** Forget the cooldown and parsed headers of these models, e.g. after their provider's key was corrected. */
  clear(modelIds: number[]): void {
    for (const id of modelIds) this.cache.delete(id);
  }

  getAll(): Map<number, RateLimitEntry> {
    return this.cache;
  }
}

// ── AiModelRouter ────────────────────────────────────────────────────

export interface AiModelRouterOptions {
  providerFactory?: (typeId: string, config: AiProviderConfig) => AiProvider;
}

export class AiModelRouter {
  private makeProvider: (typeId: string, config: AiProviderConfig) => AiProvider;

  constructor(
    private db: AppDatabase,
    private rateLimitCache: RateLimitCache,
    opts: AiModelRouterOptions = {},
  ) {
    this.makeProvider = opts.providerFactory ?? createProvider;
  }

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
   * Returns the enabled models for the requested tier name, in priority order.
   *
   * By default, when the requested tier is empty it falls down (to higher
   * sort_order = cheaper) then up (to lower sort_order = more capable); an
   * unknown tier name is treated as empty and follows the same path.
   *
   * With `strict`, only the named tier is considered and it never falls to
   * another; an unknown name counts as empty. claude-cli models (resolved by
   * the provider row's type) are dropped, since the CLI has no HTTP
   * completion, so a tier holding only CLI models counts as empty.
   *
   * Throws NoModelsConfiguredError when nothing usable is found.
   */
  getModelsForTier(tierName: string, opts: { strict?: boolean } = {}): ModelRow[] {
    const allTiers = this.db.select().from(aiTiers).orderBy(asc(aiTiers.sortOrder)).all();
    if (allTiers.length === 0) throw new NoModelsConfiguredError();

    const requested = allTiers.find(t => t.name === tierName);
    let order: typeof allTiers;
    if (opts.strict) {
      // Only the named tier: completion must never drift to a slower, more expensive tier.
      order = requested ? [requested] : [];
    } else if (requested) {
      order = [
        requested,
        ...allTiers.filter(t => t.sortOrder > requested.sortOrder).sort((a, b) => a.sortOrder - b.sortOrder),
        ...allTiers.filter(t => t.sortOrder < requested.sortOrder).sort((a, b) => b.sortOrder - a.sortOrder),
      ];
    } else {
      order = allTiers;
    }

    const typeById = new Map(this.db.select().from(aiProviders).all().map((p) => [p.id, p.type as string]));
    const typeOf = (m: ModelRow): string => (m.providerId ? typeById.get(m.providerId) : undefined) ?? m.provider;

    for (const tier of order) {
      let models = this.db.select().from(aiModels)
        .where(and(eq(aiModels.tierId, tier.id), eq(aiModels.enabled, true)))
        .orderBy(asc(aiModels.priority))
        .all();
      // The CLI has no HTTP completion, so a strict tier holding only CLI models has nothing usable.
      if (opts.strict) models = models.filter((m) => !isCliProvider(typeOf(m)));
      if (models.length > 0) return models;
    }

    throw new NoModelsConfiguredError();
  }

  /**
   * Walk the models in order and yield one built provider per usable model. Every model that is
   * passed over gets a line in `attempts`, which becomes part of the all-failed message. The type
   * comes from the provider row, which is authoritative; `ai_models.provider` is a denormalised copy.
   */
  private *candidates(
    models: ModelRow[],
    attempts: Attempt[],
  ): Generator<{ model: ModelRow; row: ProviderRow; provider: AiProvider }> {
    const providerMap = new Map(this.db.select().from(aiProviders).all().map((p) => [p.id, p]));
    for (const model of models) {
      const row = model.providerId ? providerMap.get(model.providerId) : undefined;
      const typeId: string = row?.type ?? model.provider;
      if (isCliProvider(typeId)) {
        attempts.push({ model: model.name, error: CLI_SKIP_REASON });
        continue;
      }
      const cooldownMins = model.cooldownMinutes ?? 10;
      if (this.rateLimitCache.isInCooldown(model.id, cooldownMins)) {
        const endsAt = this.rateLimitCache.cooldownEndsAt(model.id, cooldownMins);
        const minsLeft = endsAt ? Math.ceil((endsAt - Date.now()) / 60000) : '?';
        attempts.push({ model: model.name, error: `in cooldown (${minsLeft}m left)` });
        continue;
      }
      if (!model.providerId) {
        attempts.push({ model: model.name, error: 'no provider linked' });
        continue;
      }
      if (!row) {
        attempts.push({ model: model.name, error: 'provider not found' });
        continue;
      }
      if (!isKnownProviderType(row.type)) {
        error(`Model "${model.name}" skipped: unknown provider type "${row.type}"`);
        attempts.push({ model: model.name, error: `unknown provider type "${row.type}"` });
        continue;
      }
      let provider: AiProvider;
      try {
        provider = this.createProviderForModel(model, row);
      } catch (err) {
        if (!(err instanceof UnknownProviderError)) throw err;
        error(`Model "${model.name}" skipped: ${err.message}`);
        attempts.push({ model: model.name, error: err.message });
        continue;
      }
      // A stored configuration that cannot be used is skipped like a missing provider: it is not a
      // provider failure, so it starts no cooldown and does not stop the rest of the tier.
      try {
        provider.validate?.();
      } catch (err) {
        if (!(err instanceof AiProviderError)) throw err;
        error(`Model "${model.name}" skipped: ${err.message}`);
        attempts.push({ model: model.name, error: err.message });
        continue;
      }
      yield { model, row, provider };
    }
  }

  /**
   * Start the cooldown an eligible failure calls for. Quota and auth belong to the credential, so
   * every model on the same provider entry cools down. Rate limits and connection failures cool
   * down only the model. Overload is transient and starts none, and so does a permission denial
   * (a 403), which refuses one model or request without proving the key is bad.
   */
  private recordFailure(model: ModelRow, row: ProviderRow, err: unknown): void {
    // `row` is the provider entry as it was when the attempt started. If the user has since saved a
    // different key, URL, or type (or deleted the entry), this failure belongs to the old credential
    // and must not cool down the corrected one.
    const current = this.db.select().from(aiProviders).where(eq(aiProviders.id, row.id)).all()[0];
    if (!current || !sameCredential(row, current)) {
      log(`Model "${model.name}" failure predates a change to its provider, no cooldown started`);
      return;
    }
    if (err instanceof QuotaExhaustedError || err instanceof AuthError) {
      for (const sibling of this.db.select().from(aiModels).where(eq(aiModels.providerId, row.id)).all()) {
        this.rateLimitCache.record429(sibling.id);
      }
    } else if (err instanceof RateLimitError) {
      this.rateLimitCache.record429(model.id, err.headers, row.type);
    } else if (err instanceof ConnectionError) {
      this.rateLimitCache.record429(model.id);
    }
  }

  private describeAttempt(err: unknown): string {
    if (err instanceof RateLimitError) return 'rate limited';
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Stream from the first usable model of the tier, falling back to the next on a quota, rate-limit,
   * overload, auth, permission, refusal, or connection failure, but only while nothing has been yielded: once text or a
   * tool call went out, a fallback would duplicate output, so the error is rethrown. Usage events are
   * held until the first content event (or the normal end of the stream) and discarded if the stream
   * fails first, so a fallback never double counts. A caller abort is never treated as a provider
   * failure: it surfaces as the signal's reason with no fallback, no cooldown, and no held usage
   * released.
   */
  async *createStreamingRequest(
    messages: AiMessage[],
    systemPrompt: string,
    tools: AiToolDefinition[],
    options?: AiStreamOptions,
  ): AsyncIterable<AiStreamEvent> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const models = this.getModelsForTier(options?.tier ?? 'High');
    const attempts: Attempt[] = [];
    let lastError: unknown;
    let failures = 0;
    const refusals: ModelRefusedError[] = [];

    for (const { model, row, provider } of this.candidates(models, attempts)) {
      signal?.throwIfAborted();
      let yielded = false;
      const held: AiStreamEvent[] = [];
      // The models passed over before this one, attached to every usage event it reports so the
      // fallback chain can be recorded with the request. Absent when the first candidate serves.
      const passedOver = attempts.slice();
      const withChain = (e: AiStreamEvent): AiStreamEvent =>
        e.type === 'usage' && passedOver.length > 0 ? { ...e, fallbacks: passedOver.map((a) => ({ ...a })) } : e;
      try {
        for await (const raw of provider.createStreamingRequest(messages, systemPrompt, tools, options)) {
          const event = withChain(raw);
          if (!yielded) {
            if (event.type === 'usage') { held.push(event); continue; }
            yielded = true;
            const release = held.splice(0);
            for (const u of release) yield u;
          }
          yield event;
        }
      } catch (err) {
        // A cancelled request surfaces as the signal's reason (AbortError, or TimeoutError for a turn
        // timeout), never as the provider error that raced the abort.
        signal?.throwIfAborted();
        if (yielded || !isFallbackEligible(err)) throw err;
        log(`Model "${model.name}" (${row.type}) failed with ${(err as Error).name}, trying next...`);
        this.recordFailure(model, row, err);
        attempts.push({ model: model.name, error: this.describeAttempt(err) });
        lastError = err;
        failures++;
        if (err instanceof ModelRefusedError) refusals.push(err);
        continue;
      }
      // A stream that stopped because the caller aborted says nothing about the provider, and the
      // usage it reported before content belongs to a turn the caller abandoned.
      if (callerAborted(signal)) return;
      for (const u of held) yield u;   // a stream that produced only usage still reports it
      this.rateLimitCache.recordSuccess(model.id, provider.lastResponseHeaders, row.type);
      log(`Request served by model "${model.name}" (${row.type})`);
      return;
    }

    signal?.throwIfAborted();
    // Every model that was tried refused: the first refusal is the useful message (it names the safeguard and what to do
    // about it), where "all models are rate-limited or unavailable" would send the user looking at the wrong thing.
    if (failures > 0 && refusals.length === failures) throw refusals[0];
    throw new AllModelsFailedError(attempts, lastError !== undefined ? { cause: lastError } : {});
  }

  /**
   * A streaming provider bound to one tier: each request goes through this router, so it falls back past rate limits,
   * outages and refusals within the tier (and on to the next). Unlike `createProviderForModelId` it is not pinned to a
   * single model, and it respects cooldowns.
   */
  providerForTier(tier: string): AiStreamingProvider {
    return {
      name: 'router',
      createStreamingRequest: (messages, systemPrompt, tools, options) =>
        this.createStreamingRequest(messages, systemPrompt, tools, { ...options, tier }),
    };
  }

  /**
   * One-shot text completion over the named tier with the same fallback and abort policy as
   * streaming. With `strict`, only that tier is considered.
   */
  async completeText(req: AiCompleteRequest, opts: { tier: string; strict?: boolean }): Promise<string> {
    const signal = req.signal;
    signal?.throwIfAborted();
    const models = this.getModelsForTier(opts.tier, { strict: opts.strict });
    const attempts: Attempt[] = [];
    let lastError: unknown;

    for (const { model, row, provider } of this.candidates(models, attempts)) {
      signal?.throwIfAborted();
      // The factory seam allows streaming-only providers; those cannot complete, so try the next model.
      const complete = (provider as Partial<AiProvider>).complete;
      if (typeof complete !== 'function') {
        attempts.push({ model: model.name, error: 'does not support completion' });
        continue;
      }
      try {
        const text = await complete.call(provider, req);
        // A drained stream returns its partial text when the caller aborts; that is not a success.
        signal?.throwIfAborted();
        // No success log here: inline completion calls this on every pause in typing.
        this.rateLimitCache.recordSuccess(model.id, provider.lastResponseHeaders, row.type);
        return text;
      } catch (err) {
        signal?.throwIfAborted();
        if (!isFallbackEligible(err)) throw err;
        log(`Model "${model.name}" (${row.type}) failed with ${(err as Error).name}, trying next...`);
        this.recordFailure(model, row, err);
        attempts.push({ model: model.name, error: this.describeAttempt(err) });
        lastError = err;
      }
    }

    signal?.throwIfAborted();
    throw new AllModelsFailedError(attempts, lastError !== undefined ? { cause: lastError } : {});
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

    const providerRow = this.providerRowOf(model);
    if (isCliProvider(providerRow?.type ?? model.provider)) {
      throw new Error(`Model "${model.name}" uses claude-cli which does not support HTTP streaming. Use ClaudeCliAgent instead.`);
    }

    if (!model.providerId) {
      throw new Error(`AI model "${model.name}" has no provider linked`);
    }

    if (!providerRow) {
      throw new Error(`Provider for AI model "${model.name}" not found`);
    }

    return this.createProviderForModel(model, providerRow);
  }

  /**
   * Whether a model runs through the CLI rather than HTTP. The linked provider row's type is
   * authoritative; `model.provider` is a denormalised copy used only when no row is linked or found.
   */
  isCliModel(model: ModelRow): boolean {
    return isCliProvider(this.providerRowOf(model)?.type ?? model.provider);
  }

  private providerRowOf(model: ModelRow): ProviderRow | undefined {
    if (!model.providerId) return undefined;
    return this.db.select().from(aiProviders).where(eq(aiProviders.id, model.providerId)).all()[0];
  }

  private createProviderForModel(model: ModelRow, providerRow: ProviderRow): AiProvider {
    const config: AiProviderConfig = {
      apiKey: providerRow.apiKey ?? undefined,
      baseUrl: providerRow.baseUrl ?? undefined,
      model: model.model ?? undefined,
    };
    return this.makeProvider(providerRow.type, config);
  }
}
