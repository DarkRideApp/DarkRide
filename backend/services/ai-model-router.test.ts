import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { RateLimitCache, AiModelRouter } from './ai-model-router';
import { RateLimitError } from './ai-provider';
import * as aiProviderModule from './ai-provider';
import { createTestDb } from '../test-utils/create-test-db';

const { aiModels, aiProviders } = schema;

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

function insertProvider(
  db: BetterSQLite3Database<typeof schema>,
  overrides: Partial<typeof aiProviders.$inferInsert> = {},
) {
  const now = new Date();
  const result = db.insert(aiProviders).values({
    name: 'Test Provider',
    type: 'openrouter',
    apiKey: 'sk-test',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return Number(result.lastInsertRowid);
}

function insertModel(
  db: BetterSQLite3Database<typeof schema>,
  overrides: Partial<typeof aiModels.$inferInsert> & { _providerId?: number } = {},
) {
  const now = new Date();
  const { _providerId, ...rest } = overrides;
  return db.insert(aiModels).values({
    name: 'Test Model',
    provider: 'openrouter',
    providerId: _providerId ?? null,
    priority: 0,
    createdAt: now,
    updatedAt: now,
    ...rest,
  }).run();
}

function insertTier(
  db: BetterSQLite3Database<typeof schema>,
  name: string,
  sortOrder: number,
  isHardcoded = false,
) {
  return db.insert(schema.aiTiers).values({
    name,
    sortOrder,
    isHardcoded,
    createdAt: 1,
    updatedAt: 1,
  }).run();
}

// ── RateLimitCache ──────────────────────────────────────────────────

describe('RateLimitCache', () => {
  let cache: RateLimitCache;

  beforeEach(() => {
    cache = new RateLimitCache();
  });

  describe('isInCooldown', () => {
    it('should return false when no entry exists', () => {
      expect(cache.isInCooldown(1, 10)).toBe(false);
    });

    it('should return false when last429At is null', () => {
      cache.set(1, { headers: null, last429At: null });
      expect(cache.isInCooldown(1, 10)).toBe(false);
    });

    it('should return true when within cooldown period', () => {
      cache.set(1, { headers: null, last429At: Date.now() - 5 * 60 * 1000 }); // 5 min ago
      expect(cache.isInCooldown(1, 10)).toBe(true); // 10 min cooldown
    });

    it('should return false when cooldown has expired', () => {
      cache.set(1, { headers: null, last429At: Date.now() - 15 * 60 * 1000 }); // 15 min ago
      expect(cache.isInCooldown(1, 10)).toBe(false); // 10 min cooldown
    });

    it('should respect different cooldown durations', () => {
      cache.set(1, { headers: null, last429At: Date.now() - 3 * 60 * 1000 }); // 3 min ago
      expect(cache.isInCooldown(1, 2)).toBe(false); // 2 min cooldown -> expired
      expect(cache.isInCooldown(1, 5)).toBe(true);  // 5 min cooldown -> still active
    });
  });

  describe('cooldownEndsAt', () => {
    it('should return null when no entry exists', () => {
      expect(cache.cooldownEndsAt(1, 10)).toBeNull();
    });

    it('should return null when last429At is null', () => {
      cache.set(1, { headers: null, last429At: null });
      expect(cache.cooldownEndsAt(1, 10)).toBeNull();
    });

    it('should return timestamp when cooldown is active', () => {
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      cache.set(1, { headers: null, last429At: fiveMinAgo });
      const endsAt = cache.cooldownEndsAt(1, 10);
      expect(endsAt).not.toBeNull();
      // Should be fiveMinAgo + 10 minutes
      expect(endsAt).toBe(fiveMinAgo + 10 * 60 * 1000);
    });

    it('should return null when cooldown has expired', () => {
      cache.set(1, { headers: null, last429At: Date.now() - 15 * 60 * 1000 });
      expect(cache.cooldownEndsAt(1, 10)).toBeNull();
    });
  });

  describe('record429', () => {
    it('should set last429At to current time', () => {
      const before = Date.now();
      cache.record429(1);
      const entry = cache.get(1);
      expect(entry).toBeDefined();
      expect(entry!.last429At).toBeGreaterThanOrEqual(before);
      expect(entry!.last429At).toBeLessThanOrEqual(Date.now());
    });

    it('should parse headers when provider and headers provided', () => {
      const headers = new Headers({
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '0',
      });
      cache.record429(1, headers, 'openrouter');
      const entry = cache.get(1);
      expect(entry!.headers).not.toBeNull();
      expect(entry!.headers!.requestsLimit).toBe(1000);
      expect(entry!.headers!.requestsRemaining).toBe(0);
    });

    it('should preserve existing headers if new headers not provided', () => {
      const headers = new Headers({
        'x-ratelimit-limit-requests': '500',
      });
      cache.record429(1, headers, 'openrouter');
      // Record another 429 without headers
      cache.record429(1);
      const entry = cache.get(1);
      expect(entry!.headers!.requestsLimit).toBe(500);
    });
  });

  describe('recordSuccess', () => {
    it('should update headers but not clear last429At', () => {
      const past429 = Date.now() - 60000;
      cache.set(1, { headers: null, last429At: past429 });

      const headers = new Headers({
        'x-ratelimit-remaining-requests': '900',
      });
      cache.recordSuccess(1, headers, 'openrouter');

      const entry = cache.get(1);
      expect(entry!.last429At).toBe(past429);
      expect(entry!.headers!.requestsRemaining).toBe(900);
    });

    it('should handle undefined headers gracefully', () => {
      cache.recordSuccess(1, undefined, 'openrouter');
      const entry = cache.get(1);
      expect(entry!.headers).toBeNull();
      expect(entry!.last429At).toBeNull();
    });

    it('should preserve existing headers when new headers undefined', () => {
      const headers = new Headers({
        'x-ratelimit-limit-requests': '1000',
      });
      cache.record429(1, headers, 'openrouter');

      cache.recordSuccess(1, undefined, 'openrouter');
      const entry = cache.get(1);
      expect(entry!.headers!.requestsLimit).toBe(1000);
    });
  });

  describe('getAll', () => {
    it('should return empty map initially', () => {
      expect(cache.getAll().size).toBe(0);
    });

    it('should return all entries', () => {
      cache.record429(1);
      cache.record429(2);
      expect(cache.getAll().size).toBe(2);
    });
  });
});

// ── AiModelRouter ───────────────────────────────────────────────────

describe('AiModelRouter', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let cache: RateLimitCache;
  let router: AiModelRouter;
  let defaultProviderId: number;
  let highTierId: number;

  beforeEach(() => {
    db = createTestDb();
    sqlite = (db as any).$client as Database.Database;
    cache = new RateLimitCache();
    router = new AiModelRouter(db as any, cache);
    defaultProviderId = insertProvider(db);
    // Seed the two hardcoded tiers
    const highResult = insertTier(db, 'High', 0, true);
    highTierId = Number(highResult.lastInsertRowid);
    insertTier(db, 'Low', 1, true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getModels', () => {
    it('should return empty array when no models exist', () => {
      expect(router.getModels()).toEqual([]);
    });

    it('should return models ordered by priority', () => {
      insertModel(db, { name: 'Low Priority', priority: 2, _providerId: defaultProviderId });
      insertModel(db, { name: 'High Priority', priority: 0, _providerId: defaultProviderId });
      insertModel(db, { name: 'Mid Priority', priority: 1, _providerId: defaultProviderId });

      const models = router.getModels();
      expect(models).toHaveLength(3);
      expect(models[0].name).toBe('High Priority');
      expect(models[1].name).toBe('Mid Priority');
      expect(models[2].name).toBe('Low Priority');
    });

    it('should return disabled models too', () => {
      insertModel(db, { name: 'Enabled', enabled: true, _providerId: defaultProviderId });
      insertModel(db, { name: 'Disabled', enabled: false, _providerId: defaultProviderId });

      const models = router.getModels();
      expect(models).toHaveLength(2);
    });
  });

  describe('getEnabledModels', () => {
    it('should return only enabled models', () => {
      insertModel(db, { name: 'Enabled', enabled: true, priority: 0, _providerId: defaultProviderId });
      insertModel(db, { name: 'Disabled', enabled: false, priority: 1, _providerId: defaultProviderId });

      const models = router.getEnabledModels();
      expect(models).toHaveLength(1);
      expect(models[0].name).toBe('Enabled');
    });

    it('should return enabled models ordered by priority', () => {
      insertModel(db, { name: 'Second', enabled: true, priority: 1, _providerId: defaultProviderId });
      insertModel(db, { name: 'First', enabled: true, priority: 0, _providerId: defaultProviderId });

      const models = router.getEnabledModels();
      expect(models).toHaveLength(2);
      expect(models[0].name).toBe('First');
      expect(models[1].name).toBe('Second');
    });
  });

  describe('getRateLimits', () => {
    it('should return rate limit info for each model', () => {
      insertModel(db, { name: 'OpenRouter Model', provider: 'openrouter', priority: 0, _providerId: defaultProviderId });
      const geminiProviderId = insertProvider(db, { name: 'Gemini', type: 'gemini', apiKey: 'gem-key' });
      insertModel(db, { name: 'Gemini Model', provider: 'gemini', priority: 1, _providerId: geminiProviderId });

      const limits = router.getRateLimits();
      expect(limits).toHaveLength(2);
      expect(limits[0].modelName).toBe('OpenRouter Model');
      expect(limits[0].provider).toBe('openrouter');
      expect(limits[0].inCooldown).toBe(false);
      expect(limits[0].cooldownEndsAt).toBeNull();
    });

    it('should reflect cooldown state from cache', () => {
      insertModel(db, { name: 'Model', cooldownMinutes: 10, _providerId: defaultProviderId });

      const models = router.getModels();
      const modelId = models[0].id;
      cache.record429(modelId);

      const limits = router.getRateLimits();
      expect(limits[0].inCooldown).toBe(true);
      expect(limits[0].cooldownEndsAt).not.toBeNull();
    });

    it('should include parsed rate limit headers', () => {
      insertModel(db, { name: 'Model', _providerId: defaultProviderId });
      const models = router.getModels();
      const modelId = models[0].id;

      const headers = new Headers({
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '500',
        'x-ratelimit-limit-tokens': '100000',
      });
      cache.record429(modelId, headers, 'openrouter');

      const limits = router.getRateLimits();
      expect(limits[0].requestsLimit).toBe(1000);
      expect(limits[0].requestsRemaining).toBe(500);
      expect(limits[0].tokensLimit).toBe(100000);
      expect(limits[0].tokensRemaining).toBeNull();
    });

    it('should use default 10-minute cooldown when cooldownMinutes is null', () => {
      insertModel(db, { name: 'Model', cooldownMinutes: null as any, _providerId: defaultProviderId });
      const models = router.getModels();
      cache.record429(models[0].id);

      const limits = router.getRateLimits();
      expect(limits[0].inCooldown).toBe(true);
    });
  });

  describe('createStreamingRequest', () => {
    it('should throw when no models are configured', async () => {
      const gen = router.createStreamingRequest(
        [{ role: 'user', content: 'hi' }],
        'system prompt',
        [],
      );

      await expect(collectAsyncIterator(gen)).rejects.toThrow(
        'No AI models configured',
      );
    });

    it('should throw when all enabled models are disabled', async () => {
      insertModel(db, { name: 'Disabled', enabled: false, tierId: highTierId, _providerId: defaultProviderId });

      const gen = router.createStreamingRequest(
        [{ role: 'user', content: 'hi' }],
        'system prompt',
        [],
      );

      await expect(collectAsyncIterator(gen)).rejects.toThrow(
        'No AI models configured',
      );
    });

    it('should skip models in cooldown and use fallback', async () => {
      insertModel(db, { name: 'Cooldown Model', priority: 0, cooldownMinutes: 10, tierId: highTierId, _providerId: defaultProviderId });
      const geminiProviderId = insertProvider(db, { name: 'Gemini', type: 'gemini', apiKey: 'key' });
      insertModel(db, { name: 'Available Model', priority: 1, provider: 'gemini', tierId: highTierId, _providerId: geminiProviderId });

      const models = router.getModels();
      // Put first model in cooldown
      cache.record429(models[0].id);

      // Spy on createProvider to return a mock provider
      vi.spyOn(aiProviderModule, 'createProvider').mockReturnValue({
        name: 'gemini',
        lastResponseHeaders: undefined,
        buildHeaders: () => ({}),
        formatTools: () => [],
        createStreamingRequest: async function* () {
          yield { type: 'text' as const, text: 'from fallback' };
        },
      });

      const events = await collectAsyncIterator(
        router.createStreamingRequest(
          [{ role: 'user', content: 'hi' }],
          'system prompt',
          [],
        ),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text', text: 'from fallback' });
      // createProvider should have been called only once (for the available model)
      expect(aiProviderModule.createProvider).toHaveBeenCalledTimes(1);
      expect(aiProviderModule.createProvider).toHaveBeenCalledWith('gemini', expect.any(Object));
    });

    it('should fall back on RateLimitError (429)', async () => {
      insertModel(db, { name: 'Model A', priority: 0, tierId: highTierId, _providerId: defaultProviderId });
      const geminiProviderId = insertProvider(db, { name: 'Gemini', type: 'gemini', apiKey: 'key' });
      insertModel(db, { name: 'Model B', priority: 1, provider: 'gemini', tierId: highTierId, _providerId: geminiProviderId });

      let callCount = 0;
      vi.spyOn(aiProviderModule, 'createProvider').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First provider throws RateLimitError
          return {
            name: 'openrouter',
            lastResponseHeaders: undefined,
            buildHeaders: () => ({}),
            formatTools: () => [],
            createStreamingRequest: async function* () {
              throw new RateLimitError('rate limited', new Headers());
            },
          };
        }
        // Second provider succeeds
        return {
          name: 'gemini',
          lastResponseHeaders: new Headers(),
          buildHeaders: () => ({}),
          formatTools: () => [],
          createStreamingRequest: async function* () {
            yield { type: 'text' as const, text: 'fallback response' };
          },
        };
      });

      const events = await collectAsyncIterator(
        router.createStreamingRequest(
          [{ role: 'user', content: 'hi' }],
          'system prompt',
          [],
        ),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text', text: 'fallback response' });
      // Both providers should have been attempted
      expect(callCount).toBe(2);
    });

    it('should rethrow non-rate-limit errors without fallback', async () => {
      insertModel(db, { name: 'Model A', priority: 0, tierId: highTierId, _providerId: defaultProviderId });
      insertModel(db, { name: 'Model B', priority: 1, tierId: highTierId, _providerId: defaultProviderId });

      vi.spyOn(aiProviderModule, 'createProvider').mockReturnValue({
        name: 'openrouter',
        lastResponseHeaders: undefined,
        buildHeaders: () => ({}),
        formatTools: () => [],
        createStreamingRequest: async function* () {
          throw new Error('API key invalid');
        },
      });

      const gen = router.createStreamingRequest(
        [{ role: 'user', content: 'hi' }],
        'system prompt',
        [],
      );

      await expect(collectAsyncIterator(gen)).rejects.toThrow('API key invalid');
      // Should only have called createProvider once (no fallback for non-429 errors)
      expect(aiProviderModule.createProvider).toHaveBeenCalledTimes(1);
    });

    it('should throw when all models are rate-limited or in cooldown', async () => {
      insertModel(db, { name: 'Model 1', priority: 0, cooldownMinutes: 10, tierId: highTierId, _providerId: defaultProviderId });
      insertModel(db, { name: 'Model 2', priority: 1, cooldownMinutes: 10, tierId: highTierId, _providerId: defaultProviderId });

      const models = router.getModels();
      cache.record429(models[0].id);
      cache.record429(models[1].id);

      const gen = router.createStreamingRequest(
        [{ role: 'user', content: 'hi' }],
        'system prompt',
        [],
      );

      await expect(collectAsyncIterator(gen)).rejects.toThrow(
        'All AI models are rate-limited or unavailable',
      );
    });

    it('should record 429 in cache on RateLimitError', async () => {
      insertModel(db, { name: 'Only Model', priority: 0, tierId: highTierId, _providerId: defaultProviderId });
      const models = router.getModels();

      const responseHeaders = new Headers({
        'x-ratelimit-remaining-requests': '0',
      });

      vi.spyOn(aiProviderModule, 'createProvider').mockReturnValue({
        name: 'openrouter',
        lastResponseHeaders: undefined,
        buildHeaders: () => ({}),
        formatTools: () => [],
        createStreamingRequest: async function* () {
          throw new RateLimitError('rate limited', responseHeaders);
        },
      });

      const gen = router.createStreamingRequest(
        [{ role: 'user', content: 'hi' }],
        'system prompt',
        [],
      );

      await expect(collectAsyncIterator(gen)).rejects.toThrow();

      // Verify the cache recorded the 429
      expect(cache.isInCooldown(models[0].id, 10)).toBe(true);
    });

    it('should record success headers in cache on successful stream', async () => {
      insertModel(db, { name: 'Model', tierId: highTierId, _providerId: defaultProviderId });
      const models = router.getModels();

      const responseHeaders = new Headers({
        'x-ratelimit-remaining-requests': '999',
      });

      vi.spyOn(aiProviderModule, 'createProvider').mockReturnValue({
        name: 'openrouter',
        lastResponseHeaders: responseHeaders,
        buildHeaders: () => ({}),
        formatTools: () => [],
        createStreamingRequest: async function* () {
          yield { type: 'text' as const, text: 'ok' };
        },
      });

      await collectAsyncIterator(
        router.createStreamingRequest(
          [{ role: 'user', content: 'hi' }],
          'system prompt',
          [],
        ),
      );

      const entry = cache.get(models[0].id);
      expect(entry).toBeDefined();
      expect(entry!.headers!.requestsRemaining).toBe(999);
    });
  });

  describe('tier-based routing', () => {
    function getTierId(name: string): number {
      return (sqlite.prepare(`SELECT id FROM ai_tiers WHERE name = ?`).get(name) as any).id;
    }

    it('getModelsForTier returns the tier models in priority order', () => {
      const lowId = getTierId('Low');
      insertModel(db, { name: 'a', priority: 1, tierId: lowId, _providerId: defaultProviderId });
      insertModel(db, { name: 'b', priority: 0, tierId: lowId, _providerId: defaultProviderId });
      const models = router.getModelsForTier('Low');
      expect(models.map(m => m.name)).toEqual(['b', 'a']);
    });

    it('falls up when requested tier is empty with nothing below', () => {
      const highId = getTierId('High');
      insertModel(db, { name: 'on-high', priority: 0, tierId: highId, _providerId: defaultProviderId });
      const models = router.getModelsForTier('Low');
      expect(models.map(m => m.name)).toEqual(['on-high']);
    });

    it('prefers falling down over falling up', () => {
      sqlite.prepare(
        `INSERT INTO ai_tiers (name, sort_order, is_hardcoded, created_at, updated_at) VALUES ('Cheapest', 2, 0, 1, 1)`
      ).run();
      const highId = getTierId('High');
      const cheapestId = getTierId('Cheapest');
      insertModel(db, { name: 'on-high', priority: 0, tierId: highId, _providerId: defaultProviderId });
      insertModel(db, { name: 'on-cheapest', priority: 0, tierId: cheapestId, _providerId: defaultProviderId });
      const models = router.getModelsForTier('Low');
      expect(models.map(m => m.name)).toEqual(['on-cheapest']);
    });

    it('throws when every tier is empty', () => {
      expect(() => router.getModelsForTier('High')).toThrow(/No AI models configured/);
    });

    it('treats unknown tier names as empty and falls back', () => {
      const highId = getTierId('High');
      insertModel(db, { name: 'on-high', priority: 0, tierId: highId, _providerId: defaultProviderId });
      const models = router.getModelsForTier('NonExistent');
      expect(models.map(m => m.name)).toEqual(['on-high']);
    });

    it('only returns enabled models from a tier', () => {
      const highId = getTierId('High');
      insertModel(db, { name: 'enabled', priority: 0, tierId: highId, enabled: true, _providerId: defaultProviderId });
      insertModel(db, { name: 'disabled', priority: 1, tierId: highId, enabled: false, _providerId: defaultProviderId });
      const models = router.getModelsForTier('High');
      expect(models.map(m => m.name)).toEqual(['enabled']);
    });
  });

  describe('createProviderForModelId', () => {
    it('should return a provider for a valid model with linked provider', () => {
      insertModel(db, { name: 'Valid Model', provider: 'openrouter', _providerId: defaultProviderId });
      const models = router.getModels();

      vi.spyOn(aiProviderModule, 'createProvider').mockReturnValue({
        name: 'openrouter',
        buildHeaders: () => ({}),
        formatTools: () => [],
        createStreamingRequest: async function* () { yield { type: 'text' as const, text: 'ok' }; },
      });

      const provider = router.createProviderForModelId(models[0].id);
      expect(provider).toBeDefined();
      expect(provider.name).toBe('openrouter');
      expect(aiProviderModule.createProvider).toHaveBeenCalledWith('openrouter', expect.any(Object));
    });

    it('should throw for a non-existent model ID', () => {
      expect(() => router.createProviderForModelId(9999)).toThrow('AI model with id 9999 not found');
    });

    it('should throw for a model without a linked provider', () => {
      insertModel(db, { name: 'No Provider', provider: 'openrouter', _providerId: undefined as any });
      const models = router.getModels();

      expect(() => router.createProviderForModelId(models[0].id)).toThrow('has no provider linked');
    });

    it('should throw when provider row does not exist for referenced ID', () => {
      // FK enforcement is off in test DB, so we can insert with a non-existent provider_id
      const now = new Date();
      db.insert(aiModels).values({
        name: 'Orphan Model',
        provider: 'openrouter',
        providerId: 9999,
        priority: 0,
        createdAt: now,
        updatedAt: now,
      }).run();

      const models = router.getModels();
      const orphan = models.find(m => m.name === 'Orphan Model')!;

      expect(() => router.createProviderForModelId(orphan.id)).toThrow('Provider for AI model');
    });

    it('should work for models in cooldown (bypasses cooldown check)', () => {
      insertModel(db, { name: 'Cooldown Model', provider: 'openrouter', cooldownMinutes: 10, _providerId: defaultProviderId });
      const models = router.getModels();
      cache.record429(models[0].id);

      vi.spyOn(aiProviderModule, 'createProvider').mockReturnValue({
        name: 'openrouter',
        buildHeaders: () => ({}),
        formatTools: () => [],
        createStreamingRequest: async function* () { yield { type: 'text' as const, text: 'ok' }; },
      });

      // Should succeed even though model is in cooldown
      const provider = router.createProviderForModelId(models[0].id);
      expect(provider).toBeDefined();
    });

    it('should work for disabled models (bypasses enabled check)', () => {
      insertModel(db, { name: 'Disabled Model', provider: 'openrouter', enabled: false, _providerId: defaultProviderId });
      const models = router.getModels();

      vi.spyOn(aiProviderModule, 'createProvider').mockReturnValue({
        name: 'openrouter',
        buildHeaders: () => ({}),
        formatTools: () => [],
        createStreamingRequest: async function* () { yield { type: 'text' as const, text: 'ok' }; },
      });

      const provider = router.createProviderForModelId(models[0].id);
      expect(provider).toBeDefined();
    });
  });
});

// Helper to drain an async iterable into an array
async function collectAsyncIterator<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
  }
  return results;
}
