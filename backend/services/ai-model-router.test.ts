import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { RateLimitCache, AiModelRouter } from './ai-model-router';
import { RateLimitError } from './ai/errors';
import { createTestDb } from '../test-utils/create-test-db';
import {
  QuotaExhaustedError, AuthError, OverloadedError, ConnectionError, OutputLimitError, AllModelsFailedError,
  NoModelsConfiguredError, UnknownProviderError, RateLimitError as RLE,
} from './ai/errors';

const { aiModels, aiProviders } = schema;

type Script = Array<{ type: 'text' | 'usage' | 'tool' | 'throw'; value?: any }>;
/** A provider whose stream plays the script; keyed by the model name via the config.model field. */
function scripted(scripts: Record<string, Script>) {
  return vi.fn((_type: string, cfg: any) => ({
    name: 'x',
    createStreamingRequest: async function* () {
      for (const step of scripts[cfg.model] ?? []) {
        if (step.type === 'throw') throw step.value;
        if (step.type === 'text') yield { type: 'text' as const, text: step.value };
        if (step.type === 'usage') yield { type: 'usage' as const, inputTokens: step.value[0], outputTokens: step.value[1] };
        if (step.type === 'tool') yield { type: 'tool_use' as const, id: 'call_1', name: step.value, input: {} };
      }
    },
    complete: async () => { const s = scripts[cfg.model]?.find((x) => x.type === 'throw'); if (s) throw s.value; return 'done:' + cfg.model; },
  }) as any);
}

const logger = vi.hoisted(() => ({ log: vi.fn(), error: vi.fn() }));
vi.mock('../logs', () => ({
  createLoggers: () => logger,
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

    it('keeps the last known headers when the 429 carries an empty Headers object, but still sets last429At', () => {
      // A rate limit reported inside a stream has no HTTP headers to read, so its Headers object is empty.
      cache.recordSuccess(1, new Headers({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '40',
      }), 'anthropic');
      const before = Date.now();
      cache.record429(1, new Headers(), 'anthropic');
      const entry = cache.get(1);
      expect(entry!.headers).toMatchObject({ requestsLimit: 50, requestsRemaining: 40 });
      expect(entry!.last429At).toBeGreaterThanOrEqual(before);
    });

    it('replaces the last known headers when the 429 carries real headers', () => {
      cache.recordSuccess(1, new Headers({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '40',
      }), 'anthropic');
      cache.record429(1, new Headers({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '0',
      }), 'anthropic');
      expect(cache.get(1)!.headers).toMatchObject({ requestsLimit: 50, requestsRemaining: 0 });
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

  describe('clear', () => {
    it('deletes the entries of the given model ids and leaves the others', () => {
      const headers = new Headers({ 'x-ratelimit-limit-requests': '1000' });
      cache.record429(1, headers, 'openrouter');
      cache.record429(2);
      cache.record429(3);
      cache.clear([1, 3, 99]);
      expect(cache.get(1)).toBeUndefined();
      expect(cache.get(3)).toBeUndefined();
      expect(cache.isInCooldown(1, 10)).toBe(false);
      expect(cache.isInCooldown(2, 10)).toBe(true);
      expect(cache.getAll().size).toBe(1);
    });

    it('is a no-op for an empty list', () => {
      cache.record429(1);
      cache.clear([]);
      expect(cache.isInCooldown(1, 10)).toBe(true);
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

      // Inject a factory that returns a mock provider
      const factory = vi.fn().mockReturnValue({
        name: 'gemini',
        lastResponseHeaders: undefined,
        createStreamingRequest: async function* () {
          yield { type: 'text' as const, text: 'from fallback' };
        },
      });
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });

      const events = await collectAsyncIterator(
        router.createStreamingRequest(
          [{ role: 'user', content: 'hi' }],
          'system prompt',
          [],
        ),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text', text: 'from fallback' });
      // The factory should have been called only once (for the available model)
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith('gemini', expect.any(Object));
    });

    it('should fall back on RateLimitError (429)', async () => {
      insertModel(db, { name: 'Model A', priority: 0, tierId: highTierId, _providerId: defaultProviderId });
      const geminiProviderId = insertProvider(db, { name: 'Gemini', type: 'gemini', apiKey: 'key' });
      insertModel(db, { name: 'Model B', priority: 1, provider: 'gemini', tierId: highTierId, _providerId: geminiProviderId });

      let callCount = 0;
      const factory = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First provider throws RateLimitError
          return {
            name: 'openrouter',
            lastResponseHeaders: undefined,
            createStreamingRequest: async function* () {
              throw new RateLimitError('rate limited', new Headers());
            },
          };
        }
        // Second provider succeeds
        return {
          name: 'gemini',
          lastResponseHeaders: new Headers(),
          createStreamingRequest: async function* () {
            yield { type: 'text' as const, text: 'fallback response' };
          },
        };
      });
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });

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

      const factory = vi.fn().mockReturnValue({
        name: 'openrouter',
        lastResponseHeaders: undefined,
        createStreamingRequest: async function* () {
          throw new Error('API key invalid');
        },
      });
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });

      const gen = router.createStreamingRequest(
        [{ role: 'user', content: 'hi' }],
        'system prompt',
        [],
      );

      await expect(collectAsyncIterator(gen)).rejects.toThrow('API key invalid');
      // Should only have called the factory once (no fallback for non-429 errors)
      expect(factory).toHaveBeenCalledTimes(1);
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

      const factory = vi.fn().mockReturnValue({
        name: 'openrouter',
        lastResponseHeaders: undefined,
        createStreamingRequest: async function* () {
          throw new RateLimitError('rate limited', responseHeaders);
        },
      });
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });

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

      const factory = vi.fn().mockReturnValue({
        name: 'openrouter',
        lastResponseHeaders: responseHeaders,
        createStreamingRequest: async function* () {
          yield { type: 'text' as const, text: 'ok' };
        },
      });
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });

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

    it('uses an injected providerFactory instead of the module createProvider', async () => {
      // The suite seeds a provider and the two hardcoded tiers but no model: add one.
      insertModel(db, { name: 'Injected', tierId: highTierId, _providerId: defaultProviderId });
      const seen: Array<[string, any]> = [];
      const factory = vi.fn((typeId: string, cfg: any) => {
        seen.push([typeId, cfg]);
        return { name: typeId, createStreamingRequest: async function* () { yield { type: 'text' as const, text: 'hi' }; } } as any;
      });
      const injected = new AiModelRouter(db as any, cache, { providerFactory: factory });
      const out: any[] = [];
      for await (const e of injected.createStreamingRequest([{ role: 'user', content: 'x' }], 's', [])) out.push(e);
      expect(out).toEqual([{ type: 'text', text: 'hi' }]);
      expect(factory).toHaveBeenCalledTimes(1);
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

      const factory = vi.fn().mockReturnValue({
        name: 'openrouter',
        createStreamingRequest: async function* () { yield { type: 'text' as const, text: 'ok' }; },
      });
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });

      const provider = router.createProviderForModelId(models[0].id);
      expect(provider).toBeDefined();
      expect(provider.name).toBe('openrouter');
      expect(factory).toHaveBeenCalledWith('openrouter', expect.any(Object));
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

      const factory = vi.fn().mockReturnValue({
        name: 'openrouter',
        createStreamingRequest: async function* () { yield { type: 'text' as const, text: 'ok' }; },
      });
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });

      // Should succeed even though model is in cooldown
      const provider = router.createProviderForModelId(models[0].id);
      expect(provider).toBeDefined();
    });

    it('should work for disabled models (bypasses enabled check)', () => {
      insertModel(db, { name: 'Disabled Model', provider: 'openrouter', enabled: false, _providerId: defaultProviderId });
      const models = router.getModels();

      const factory = vi.fn().mockReturnValue({
        name: 'openrouter',
        createStreamingRequest: async function* () { yield { type: 'text' as const, text: 'ok' }; },
      });
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });

      const provider = router.createProviderForModelId(models[0].id);
      expect(provider).toBeDefined();
    });

    it('builds the provider from the provider row type, not the denormalised model.provider', () => {
      const gem = insertProvider(db, { name: 'G', type: 'gemini', apiKey: 'k' });
      insertModel(db, { name: 'Stale', provider: 'openrouter', _providerId: gem });
      const factory = scripted({});
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });
      router.createProviderForModelId(router.getModels()[0].id);
      expect(factory.mock.calls[0][0]).toBe('gemini');
    });

    it('rejects a model whose provider row is the CLI even when model.provider holds a stale HTTP type', () => {
      const cli = insertProvider(db, { name: 'CLI', type: 'claude-cli', apiKey: null });
      insertModel(db, { name: 'Stale CLI', provider: 'openrouter', _providerId: cli });
      const factory = scripted({});
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });
      expect(() => router.createProviderForModelId(router.getModels()[0].id))
        .toThrow('uses claude-cli which does not support HTTP streaming');
      expect(factory).not.toHaveBeenCalled();
    });

    it('builds an HTTP provider when model.provider says CLI but the provider row is HTTP', () => {
      const gem = insertProvider(db, { name: 'G', type: 'gemini', apiKey: 'k' });
      insertModel(db, { name: 'Stale HTTP', provider: 'claude-cli', _providerId: gem });
      const factory = scripted({});
      router = new AiModelRouter(db as any, cache, { providerFactory: factory });
      router.createProviderForModelId(router.getModels()[0].id);
      expect(factory.mock.calls[0][0]).toBe('gemini');
    });

    it('falls back to model.provider for the CLI check when no provider is linked', () => {
      insertModel(db, { name: 'Unlinked CLI', provider: 'claude-cli', _providerId: undefined as any });
      expect(() => router.createProviderForModelId(router.getModels()[0].id))
        .toThrow('uses claude-cli which does not support HTTP streaming');
    });
  });

  describe('isCliModel', () => {
    it('reads the provider row type over the denormalised model.provider', () => {
      const cli = insertProvider(db, { name: 'CLI', type: 'claude-cli', apiKey: null });
      const gem = insertProvider(db, { name: 'G', type: 'gemini', apiKey: 'k' });
      insertModel(db, { name: 'Row CLI', provider: 'openrouter', priority: 0, _providerId: cli });
      insertModel(db, { name: 'Row HTTP', provider: 'claude-cli', priority: 1, _providerId: gem });
      const [rowCli, rowHttp] = router.getModels();
      expect(router.isCliModel(rowCli)).toBe(true);
      expect(router.isCliModel(rowHttp)).toBe(false);
    });

    it('uses model.provider when the model has no provider row', () => {
      insertModel(db, { name: 'Unlinked CLI', provider: 'claude-cli', priority: 0, _providerId: undefined as any });
      insertModel(db, { name: 'Orphan', provider: 'openrouter', priority: 1, providerId: 9999 } as any);
      const [unlinked, orphan] = router.getModels();
      expect(router.isCliModel(unlinked)).toBe(true);
      expect(router.isCliModel(orphan)).toBe(false);
    });
  });

  describe('fallback policy', () => {
    // A and B sit on different provider entries (credentials). Quota and auth failures cool down
    // every model that shares a credential, so a same-credential fallback target would be skipped.
    let r: AiModelRouter;
    const scripts: Record<string, Script> = {};
    let providerB: number;
    beforeEach(() => {
      for (const k of Object.keys(scripts)) delete scripts[k];
      providerB = insertProvider(db, { name: 'Second', type: 'openrouter', apiKey: 'k2' });
      insertModel(db, { name: 'A', model: 'A', priority: 0, tierId: highTierId, _providerId: defaultProviderId });
      insertModel(db, { name: 'B', model: 'B', priority: 1, tierId: highTierId, _providerId: providerB });
      r = new AiModelRouter(db as any, cache, { providerFactory: scripted(scripts) });
    });
    const two = (a: Script, b: Script) => { scripts.A = a; scripts.B = b; cache.getAll().clear(); };
    const run = () => collectAsyncIterator(r.createStreamingRequest([{ role: 'user', content: 'x' }], 's', []));

    it('falls back on quota, overload, auth, and connection errors before any content', async () => {
      for (const err of [new QuotaExhaustedError('no credits'), new OverloadedError('busy'), new AuthError('bad key'), new ConnectionError('refused')]) {
        cache.getAll().clear();
        two([{ type: 'throw', value: err }], [{ type: 'text', value: 'from B' }]);
        expect(await run()).toEqual([{ type: 'text', text: 'from B' }]);
      }
    });

    it('does not fall back once content was yielded', async () => {
      const factory = scripted(scripts);
      r = new AiModelRouter(db as any, cache, { providerFactory: factory });
      two([{ type: 'text', value: 'partial' }, { type: 'throw', value: new OverloadedError('mid-stream') }], [{ type: 'text', value: 'B' }]);
      await expect(run()).rejects.toBeInstanceOf(OverloadedError);
      expect(factory.mock.calls.map((c) => c[1].model)).toEqual(['A']);
      expect(cache.getAll().size).toBe(0);
    });

    it('a tool call as the first content also blocks fallback', async () => {
      const factory = scripted(scripts);
      r = new AiModelRouter(db as any, cache, { providerFactory: factory });
      two([{ type: 'usage', value: [3, 0] }, { type: 'tool', value: 'list_devices' }, { type: 'throw', value: new ConnectionError('reset') }],
        [{ type: 'text', value: 'B' }]);
      const seen: any[] = [];
      const err = await (async () => { for await (const e of r.createStreamingRequest([{ role: 'user', content: 'x' }], 's', [])) seen.push(e); })()
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConnectionError);
      expect(seen.map((e) => e.type)).toEqual(['usage', 'tool_use']);
      expect(factory.mock.calls.map((c) => c[1].model)).toEqual(['A']);
      expect(cache.getAll().size).toBe(0);
    });

    it('content followed by a quota error starts no cooldown', async () => {
      two([{ type: 'text', value: 'partial' }, { type: 'throw', value: new QuotaExhaustedError('no credits') }], [{ type: 'text', value: 'B' }]);
      await expect(run()).rejects.toBeInstanceOf(QuotaExhaustedError);
      expect(cache.getAll().size).toBe(0);
    });

    it('a consumer that stops early records neither a failure nor a success', async () => {
      const factory = scripted(scripts);
      r = new AiModelRouter(db as any, cache, { providerFactory: factory });
      two([{ type: 'text', value: 'one' }, { type: 'text', value: 'two' }], [{ type: 'text', value: 'B' }]);
      const seen: any[] = [];
      for await (const e of r.createStreamingRequest([{ role: 'user', content: 'x' }], 's', [])) { seen.push(e); break; }
      expect(seen).toEqual([{ type: 'text', text: 'one' }]);
      expect(cache.getAll().size).toBe(0);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('a quota error cools disabled siblings on the credential but not unlinked rows or other credentials', async () => {
      insertModel(db, { name: 'A-off', model: 'A-off', priority: 5, enabled: false, tierId: highTierId, _providerId: defaultProviderId });
      insertModel(db, { name: 'Unlinked', model: 'U', priority: 6, tierId: highTierId });
      const otherId = insertProvider(db, { name: 'Third', type: 'openrouter', apiKey: 'k3' });
      insertModel(db, { name: 'Elsewhere', model: 'E', priority: 7, tierId: highTierId, _providerId: otherId });
      two([{ type: 'throw', value: new QuotaExhaustedError('no credits') }], [{ type: 'text', value: 'B' }]);
      expect(await run()).toEqual([{ type: 'text', text: 'B' }]);
      const byName = Object.fromEntries(r.getModels().map((m) => [m.name, m.id]));
      expect(cache.isInCooldown(byName.A, 10)).toBe(true);
      expect(cache.isInCooldown(byName['A-off'], 10)).toBe(true);
      expect(cache.isInCooldown(byName.Unlinked, 10)).toBe(false);
      expect(cache.isInCooldown(byName.Elsewhere, 10)).toBe(false);
      expect(cache.isInCooldown(byName.B, 10)).toBe(false);
    });

    it('does not fall back on an output-limit error, abort, or a generic error', async () => {
      for (const err of [new OutputLimitError('long'), new DOMException('aborted', 'AbortError'), new Error('boom')]) {
        two([{ type: 'throw', value: err }], [{ type: 'text', value: 'B' }]);
        await expect(run()).rejects.toBe(err);
      }
    });

    it('holds usage until content and discards it when the stream fails first', async () => {
      two([{ type: 'usage', value: [100, 0] }, { type: 'throw', value: new QuotaExhaustedError('no credits') }],
        [{ type: 'usage', value: [7, 0] }, { type: 'text', value: 'B' }, { type: 'usage', value: [0, 3] }]);
      const events = await run();
      const inTokens = events.filter((e: any) => e.type === 'usage').reduce((n: number, e: any) => n + e.inputTokens, 0);
      expect(inTokens).toBe(7);
    });

    it('releases held usage ahead of the first content event, in order', async () => {
      two([{ type: 'usage', value: [5, 0] }, { type: 'text', value: 'hi' }], []);
      expect(await run()).toEqual([{ type: 'usage', inputTokens: 5, outputTokens: 0 }, { type: 'text', text: 'hi' }]);
    });

    it('a stream that produced only usage still reports it', async () => {
      two([{ type: 'usage', value: [5, 1] }], []);
      expect(await run()).toEqual([{ type: 'usage', inputTokens: 5, outputTokens: 1 }]);
    });

    it('throws AllModelsFailedError carrying each reason, starting with the legacy text', async () => {
      two([{ type: 'throw', value: new RLE('x', new Headers()) }], [{ type: 'throw', value: new AuthError('Anthropic API error (401): bad key') }]);
      const err: any = await run().catch((e) => e);
      expect(err).toBeInstanceOf(AllModelsFailedError);
      expect(err.message).toBe('All AI models are rate-limited or unavailable:\nA: rate limited\nB: Anthropic API error (401): bad key');
      expect(err.attempts).toHaveLength(2);
      expect(err.cause).toBeInstanceOf(AuthError);
    });

    it('quota and auth errors cool down every model on the same credential; rate limits only the model', async () => {
      insertModel(db, { name: 'A2', model: 'A2', priority: 2, tierId: highTierId, _providerId: defaultProviderId });
      scripts.A2 = [{ type: 'text', value: 'A2' }];
      const byName = Object.fromEntries(r.getModels().map((m) => [m.name, m.id]));
      for (const err of [new QuotaExhaustedError('no credits'), new AuthError('bad key')]) {
        two([{ type: 'throw', value: err }], [{ type: 'text', value: 'B' }]);
        expect(await run()).toEqual([{ type: 'text', text: 'B' }]);
        expect(cache.isInCooldown(byName.A, 10)).toBe(true);
        expect(cache.isInCooldown(byName.A2, 10)).toBe(true);    // same credential as A
        expect(cache.isInCooldown(byName.B, 10)).toBe(false);
      }

      two([{ type: 'throw', value: new RLE('x', new Headers()) }], [{ type: 'text', value: 'B' }]);
      await run();
      expect(cache.isInCooldown(byName.A, 10)).toBe(true);
      expect(cache.isInCooldown(byName.A2, 10)).toBe(false);   // a rate limit is per model
    });

    describe('a failure that arrives after the provider was edited', () => {
      // A provider whose stream for model A runs `midFlight` and then throws `err`, as a request
      // sent with the old key would when the user saves a corrected key while it is in flight.
      const editing = (err: unknown, midFlight: () => void) => {
        const base = scripted(scripts);
        return vi.fn((type: string, cfg: any) => cfg.model !== 'A' ? base(type, cfg) : {
          name: 'x',
          createStreamingRequest: async function* () { midFlight(); throw err; },
          complete: async () => { midFlight(); throw err; },
        }) as any;
      };
      const ids = () => Object.fromEntries(r.getModels().map((m) => [m.name, m.id]));

      it('starts no cooldown when the key changed while the request was in flight', async () => {
        insertModel(db, { name: 'A2', model: 'A2', priority: 2, tierId: highTierId, _providerId: defaultProviderId });
        two([], [{ type: 'text', value: 'B' }]);
        r = new AiModelRouter(db as any, cache, { providerFactory: editing(new AuthError('bad key'), () => {
          db.update(aiProviders).set({ apiKey: 'corrected-placeholder' }).where(eq(aiProviders.id, defaultProviderId)).run();
        }) });
        logger.log.mockClear();
        expect(await run()).toEqual([{ type: 'text', text: 'B' }]);
        expect(cache.isInCooldown(ids().A, 10)).toBe(false);
        expect(cache.isInCooldown(ids().A2, 10)).toBe(false);
        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('predates a change to its provider'));
      });

      it('starts no cooldown when the base URL or type changed, or the provider was deleted, on either path', async () => {
        const low = db.select().from(schema.aiTiers).all().find((t) => t.name === 'Low')!;
        const edits: Array<() => void> = [
          () => db.update(aiProviders).set({ baseUrl: 'http://127.0.0.1:9/v1' }).where(eq(aiProviders.id, defaultProviderId)).run(),
          () => db.update(aiProviders).set({ type: 'gemini' }).where(eq(aiProviders.id, defaultProviderId)).run(),
        ];
        for (const edit of edits) {
          db.update(aiProviders).set({ type: 'openrouter', baseUrl: null }).where(eq(aiProviders.id, defaultProviderId)).run();
          two([], [{ type: 'text', value: 'B' }]);
          r = new AiModelRouter(db as any, cache, { providerFactory: editing(new ConnectionError('refused'), edit) });
          await run();
          expect(cache.isInCooldown(ids().A, 10)).toBe(false);
        }
        // completeText path with a quota failure on a provider that is renamed only: still cools down.
        db.update(aiModels).set({ tierId: low.id }).run();
        cache.getAll().clear();
        r = new AiModelRouter(db as any, cache, { providerFactory: editing(new QuotaExhaustedError('no credits'), () => {
          db.update(aiProviders).set({ name: 'Renamed only' }).where(eq(aiProviders.id, defaultProviderId)).run();
        }) });
        await r.completeText({ prefix: 'a', suffix: 'b' }, { tier: 'Low', strict: true });
        expect(cache.isInCooldown(ids().A, 10)).toBe(true);
        // completeText path with the key changed: no cooldown.
        cache.getAll().clear();
        r = new AiModelRouter(db as any, cache, { providerFactory: editing(new QuotaExhaustedError('no credits'), () => {
          db.update(aiProviders).set({ apiKey: 'another-placeholder' }).where(eq(aiProviders.id, defaultProviderId)).run();
        }) });
        await r.completeText({ prefix: 'a', suffix: 'b' }, { tier: 'Low', strict: true });
        expect(cache.isInCooldown(ids().A, 10)).toBe(false);
        // Deleted provider: the failure cannot be attributed to the current credential either.
        r = new AiModelRouter(db as any, cache, { providerFactory: editing(new AuthError('bad key'), () => {
          db.update(aiModels).set({ providerId: null }).where(eq(aiModels.providerId, defaultProviderId)).run();
          db.delete(aiProviders).where(eq(aiProviders.id, defaultProviderId)).run();
        }) });
        await r.completeText({ prefix: 'a', suffix: 'b' }, { tier: 'Low', strict: true });
        expect(cache.isInCooldown(ids().A, 10)).toBe(false);
      });

      it('still cools down when the provider is unchanged', async () => {
        insertModel(db, { name: 'A2', model: 'A2', priority: 2, tierId: highTierId, _providerId: defaultProviderId });
        two([], [{ type: 'text', value: 'B' }]);
        r = new AiModelRouter(db as any, cache, { providerFactory: editing(new AuthError('bad key'), () => undefined) });
        expect(await run()).toEqual([{ type: 'text', text: 'B' }]);
        expect(cache.isInCooldown(ids().A, 10)).toBe(true);
        expect(cache.isInCooldown(ids().A2, 10)).toBe(true);
      });
    });

    it('a model cooled down by a credential failure is skipped on the next request', async () => {
      two([{ type: 'throw', value: new QuotaExhaustedError('no credits') }], [{ type: 'throw', value: new OverloadedError('busy') }]);
      await run().catch(() => undefined);
      scripts.A = [{ type: 'text', value: 'A' }];
      const err: any = await run().catch((e) => e);
      expect(err).toBeInstanceOf(AllModelsFailedError);
      expect(err.message).toMatch(/\nA: in cooldown \(\d+m left\)\nB: busy$/);
    });

    it('overload starts no cooldown', async () => {
      two([{ type: 'throw', value: new OverloadedError('busy') }], [{ type: 'text', value: 'B' }]);
      await run();
      expect(cache.isInCooldown(r.getModels()[0].id, 10)).toBe(false);
    });

    it('a connection failure cools the model down and falls back', async () => {
      two([{ type: 'throw', value: new ConnectionError('refused') }], [{ type: 'text', value: 'B' }]);
      expect(await run()).toEqual([{ type: 'text', text: 'B' }]);
      expect(cache.isInCooldown(r.getModels().find((m) => m.name === 'A')!.id, 10)).toBe(true);
    });

    it('cooldowns honour each model\'s own cooldownMinutes', async () => {
      vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
      try {
        const id = r.getModels().find((m) => m.name === 'A')!.id;
        db.update(aiModels).set({ cooldownMinutes: 1 }).where(eq(aiModels.id, id)).run();
        two([{ type: 'throw', value: new ConnectionError('refused') }], [{ type: 'text', value: 'B' }]);
        await run();
        const limit = () => r.getRateLimits().find((l) => l.modelId === id)!;
        expect(limit().cooldownEndsAt).toBe(Date.now() + 60_000);
        vi.setSystemTime(Date.now() + 59_999);
        expect(limit().inCooldown).toBe(true);
        vi.setSystemTime(Date.now() + 1);
        expect(limit().inCooldown).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('abort passes through, does not fall back, and drops usage that was being held', async () => {
      const abort = new DOMException('aborted', 'AbortError');
      two([{ type: 'usage', value: [100, 0] }, { type: 'throw', value: abort }], [{ type: 'text', value: 'B' }]);
      const seen: any[] = [];
      await expect((async () => { for await (const e of r.createStreamingRequest([{ role: 'user', content: 'x' }], 's', [])) seen.push(e); })())
        .rejects.toBe(abort);
      expect(seen).toEqual([]);                      // the held usage event was never emitted
    });

    it('reports claude-cli rows in the failure message with the legacy text', async () => {
      const cli = insertProvider(db, { name: 'CLI', type: 'claude-cli', apiKey: null });
      insertModel(db, { name: 'C', provider: 'claude-cli', priority: -1, tierId: highTierId, _providerId: cli });
      two([{ type: 'throw', value: new QuotaExhaustedError('no credits') }], [{ type: 'throw', value: new OverloadedError('busy') }]);
      const err: any = await run().catch((e) => e);
      expect(err).toBeInstanceOf(AllModelsFailedError);
      expect(err.message).toContain('C: uses claude-cli which does not support HTTP streaming');
    });

    it('skips a claude-cli provider row even when model.provider holds a stale HTTP type', async () => {
      const cli = insertProvider(db, { name: 'CLI', type: 'claude-cli', apiKey: null });
      insertModel(db, { name: 'C', provider: 'openrouter', priority: -1, tierId: highTierId, _providerId: cli });
      const factory = scripted(scripts);
      r = new AiModelRouter(db as any, cache, { providerFactory: factory });
      two([{ type: 'text', value: 'A' }], []);
      expect(await run()).toEqual([{ type: 'text', text: 'A' }]);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('skips unknown provider types with an error line instead of throwing', async () => {
      const weird = insertProvider(db, { name: 'Weird', type: 'retired-type' as any });
      insertModel(db, { name: 'W', provider: 'retired-type', priority: -1, tierId: highTierId, _providerId: weird });
      logger.error.mockClear();
      two([{ type: 'text', value: 'A' }], []);
      expect(await run()).toEqual([{ type: 'text', text: 'A' }]);   // W sorts first and is skipped
      expect(logger.error).toHaveBeenCalledWith('Model "W" skipped: unknown provider type "retired-type"');
    });

    it('lists an unknown provider type in the failure message', async () => {
      const weird = insertProvider(db, { name: 'Weird', type: 'retired-type' as any });
      insertModel(db, { name: 'W', provider: 'retired-type', priority: -1, tierId: highTierId, _providerId: weird });
      two([{ type: 'throw', value: new OverloadedError('busy') }], [{ type: 'throw', value: new OverloadedError('busy') }]);
      const err: any = await run().catch((e) => e);
      expect(err.message).toContain('W: unknown provider type "retired-type"');
    });

    it('skips a model whose provider cannot be built with UnknownProviderError', async () => {
      const base = scripted(scripts);
      const factory = vi.fn((type: string, cfg: any) => {
        if (cfg.model === 'A') throw new UnknownProviderError('Unknown AI provider: x');
        return base(type, cfg);
      });
      r = new AiModelRouter(db as any, cache, { providerFactory: factory as any });
      two([], [{ type: 'text', value: 'B' }]);
      expect(await run()).toEqual([{ type: 'text', text: 'B' }]);
    });

    it('uses the provider row type, not the denormalised model.provider', async () => {
      const gem = insertProvider(db, { name: 'G', type: 'gemini', apiKey: 'k' });
      insertModel(db, { name: 'M', provider: 'stale-value', priority: -1, tierId: highTierId, _providerId: gem });
      const factory = scripted(scripts);
      r = new AiModelRouter(db as any, cache, { providerFactory: factory });
      two([], []);
      await run();
      expect(factory.mock.calls[0][0]).toBe('gemini');
    });
  });

  describe('caller abort', () => {
    // A caller abort is never a provider failure: no fallback, no cooldown, no aggregate error, no usage.
    const calls: string[] = [];
    let seenOptions: any[];
    let seenRequests: any[];
    let behaviour: Record<string, (signal: AbortSignal | undefined, ctl: AbortController) => AsyncGenerator<any>>;
    let ctl: AbortController;
    let r: AiModelRouter;
    let idA: number;
    let idB: number;

    beforeEach(() => {
      calls.length = 0;
      seenOptions = [];
      seenRequests = [];
      behaviour = {};
      ctl = new AbortController();
      const providerB = insertProvider(db, { name: 'Second', type: 'openrouter', apiKey: 'k2' });
      insertModel(db, { name: 'A', model: 'A', priority: 0, tierId: highTierId, _providerId: defaultProviderId });
      insertModel(db, { name: 'B', model: 'B', priority: 1, tierId: highTierId, _providerId: providerB });
      const low = db.select().from(schema.aiTiers).all().find((t) => t.name === 'Low')!;
      insertModel(db, { name: 'LA', model: 'A', priority: 0, tierId: low.id, _providerId: defaultProviderId });
      insertModel(db, { name: 'LB', model: 'B', priority: 1, tierId: low.id, _providerId: providerB });
      const ids = Object.fromEntries(db.select().from(aiModels).all().map((m) => [m.name, m.id]));
      idA = ids.A;
      idB = ids.B;
      r = new AiModelRouter(db as any, cache, {
        providerFactory: ((_t: string, cfg: any) => ({
          name: 'x',
          createStreamingRequest: (_m: any, _s: any, _tools: any, options: any) => {
            calls.push(cfg.model);
            seenOptions.push(options);
            return (behaviour[cfg.model] ?? (async function* () { yield { type: 'text', text: cfg.model }; }))(options?.signal, ctl);
          },
          complete: async (req: any) => {
            calls.push(cfg.model);
            seenRequests.push(req);
            if (cfg.model === 'A') { ctl.abort(); throw new QuotaExhaustedError('no credits'); }
            return 'done:' + cfg.model;
          },
        })) as any,
      });
    });
    const run = (extra: Record<string, unknown> = {}) => {
      const seen: any[] = [];
      const p = (async () => {
        for await (const e of r.createStreamingRequest([{ role: 'user', content: 'x' }], 's', [], { signal: ctl.signal, ...extra })) seen.push(e);
      })();
      return { seen, p };
    };
    const noCooldown = () => {
      expect(cache.isInCooldown(idA, 10)).toBe(false);
      expect(cache.isInCooldown(idB, 10)).toBe(false);
    };

    it('passes the caller signal object through to the provider unchanged', async () => {
      const { p } = run({ maxOutputTokens: 99 });
      await p;
      expect(seenOptions[0].signal).toBe(ctl.signal);
      expect(seenOptions[0].maxOutputTokens).toBe(99);
    });

    it('passes the completion request, with its signal, through to the provider unchanged', async () => {
      const lowOnlyB = new AiModelRouter(db as any, cache, {
        providerFactory: ((_t: string, cfg: any) => ({
          name: 'x', createStreamingRequest: async function* () {},
          complete: async (req: any) => { seenRequests.push(req); return 'done:' + cfg.model; },
        })) as any,
      });
      const req = { prefix: 'a', suffix: 'b', signal: ctl.signal };
      expect(await lowOnlyB.completeText(req, { tier: 'Low', strict: true })).toBe('done:A');
      expect(seenRequests[0]).toBe(req);
      expect(seenRequests[0].signal).toBe(ctl.signal);
    });

    it('an already-aborted signal sends no request and is not an all-models failure', async () => {
      ctl.abort();
      const { seen, p } = run();
      const err: any = await p.catch((e) => e);
      expect(err?.name).toBe('AbortError');
      expect(err).not.toBeInstanceOf(AllModelsFailedError);
      expect(calls).toEqual([]);
      expect(seen).toEqual([]);
      noCooldown();
    });

    it('an eligible error raised after the caller aborted surfaces as the signal reason, with no fallback or cooldown', async () => {
      const failure = new ConnectionError('socket closed');
      const reason = new DOMException('turn timed out', 'TimeoutError');
      behaviour.A = async function* (_s, c) { yield { type: 'usage', inputTokens: 50, outputTokens: 0 }; c.abort(reason); throw failure; };
      const { seen, p } = run();
      await expect(p).rejects.toBe(reason);
      expect(calls).toEqual(['A']);
      expect(seen).toEqual([]);
      noCooldown();
    });

    it('a provider error that raced a user cancel surfaces as an AbortError', async () => {
      behaviour.A = async function* (_s, c) { c.abort(); throw new RLE('Anthropic API error (429): slow down', new Headers()); };
      const { p } = run();
      const err: any = await p.catch((e) => e);
      expect(err?.name).toBe('AbortError');
      expect(err).toBe(ctl.signal.reason);
      expect(calls).toEqual(['A']);
      noCooldown();
    });

    it('a stream that ends silently because of the abort emits no held usage and does not fall back', async () => {
      behaviour.A = async function* (_s, c) { yield { type: 'usage', inputTokens: 50, outputTokens: 0 }; c.abort(); };
      const { seen, p } = run();
      const err: any = await p.catch((e) => e);
      expect(err).toBeUndefined();
      expect(calls).toEqual(['A']);
      expect(seen).toEqual([]);
      noCooldown();
      expect(cache.get(idA)).toBeUndefined();   // not recorded as a success either
    });

    it('an abort mid-stream after content keeps the content and does not fall back', async () => {
      behaviour.A = async function* (_s, c) { yield { type: 'text', text: 'part' }; c.abort(); throw new DOMException('aborted', 'AbortError'); };
      const { seen, p } = run();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(seen).toEqual([{ type: 'text', text: 'part' }]);
      expect(calls).toEqual(['A']);
      noCooldown();
    });

    it('completeText does not fall back or cool down when the caller aborted', async () => {
      const lowA = db.select().from(aiModels).all().find((m) => m.name === 'LA')!.id;
      const err: any = await r.completeText({ prefix: 'a', suffix: 'b', signal: ctl.signal }, { tier: 'Low', strict: true }).catch((e) => e);
      expect(err?.name).toBe('AbortError');
      expect(err).toBe(ctl.signal.reason);
      expect(calls).toEqual(['A']);
      expect(cache.isInCooldown(lowA, 10)).toBe(false);
    });

    it('completeText rejects with the abort when complete() returned partial text after the caller aborted', async () => {
      const rr = new AiModelRouter(db as any, cache, {
        providerFactory: ((_t: string, cfg: any) => ({
          name: 'x', createStreamingRequest: async function* () {},
          complete: async () => { calls.push(cfg.model); ctl.abort(); return 'partial'; },
        })) as any,
      });
      const lowA = db.select().from(aiModels).all().find((m) => m.name === 'LA')!.id;
      const err: any = await rr.completeText({ prefix: 'a', suffix: 'b', signal: ctl.signal }, { tier: 'Low', strict: true }).catch((e) => e);
      expect(err?.name).toBe('AbortError');
      expect(calls).toEqual(['A']);
      expect(cache.get(lowA)).toBeUndefined();   // no success recorded
    });

    it('completeText with an already-aborted signal sends no request', async () => {
      ctl.abort();
      const err: any = await r.completeText({ prefix: 'a', suffix: 'b', signal: ctl.signal }, { tier: 'Low', strict: true }).catch((e) => e);
      expect(err?.name).toBe('AbortError');
      expect(calls).toEqual([]);
    });
  });

  describe('strict tier and completion', () => {
    it('strict considers only the named tier; an empty Low tier throws NoModelsConfiguredError even when High has models', () => {
      insertModel(db, { name: 'H', priority: 0, tierId: highTierId, _providerId: defaultProviderId });
      const rr = new AiModelRouter(db as any, cache, { providerFactory: scripted({}) });
      expect(() => rr.getModelsForTier('Low', { strict: true })).toThrow(NoModelsConfiguredError);
      expect(rr.getModelsForTier('Low').length).toBe(1);   // non-strict still falls across tiers
    });
    it('strict with an unknown tier name throws NoModelsConfiguredError', () => {
      insertModel(db, { name: 'H', priority: 0, tierId: highTierId, _providerId: defaultProviderId });
      const rr = new AiModelRouter(db as any, cache, { providerFactory: scripted({}) });
      expect(() => rr.getModelsForTier('Nope', { strict: true })).toThrow(NoModelsConfiguredError);
    });
    it('a strict tier holding only claude-cli models counts as empty', () => {
      const cli = insertProvider(db, { name: 'CLI', type: 'claude-cli', apiKey: null });
      const low = db.select().from(schema.aiTiers).all().find((t) => t.name === 'Low')!;
      insertModel(db, { name: 'C', provider: 'claude-cli', priority: 0, tierId: low.id, _providerId: cli });
      const rr = new AiModelRouter(db as any, cache, { providerFactory: scripted({}) });
      expect(() => rr.getModelsForTier('Low', { strict: true })).toThrow(NoModelsConfiguredError);
    });
    it('completeText iterates with the same fallback policy', async () => {
      const low = db.select().from(schema.aiTiers).all().find((t) => t.name === 'Low')!;
      const other = insertProvider(db, { name: 'Other', type: 'openrouter', apiKey: 'k2' });
      insertModel(db, { name: 'A', model: 'A', priority: 0, tierId: low.id, _providerId: defaultProviderId });
      insertModel(db, { name: 'B', model: 'B', priority: 1, tierId: low.id, _providerId: other });
      const rr = new AiModelRouter(db as any, cache, { providerFactory: scripted({ A: [{ type: 'throw', value: new QuotaExhaustedError('no credits') }] }) });
      expect(await rr.completeText({ prefix: 'a', suffix: 'b' }, { tier: 'Low', strict: true })).toBe('done:B');
      const idA = rr.getModels().find((m) => m.name === 'A')!.id;
      expect(cache.isInCooldown(idA, 10)).toBe(true);
    });
    it('a successful completeText writes no log line, since inline completion runs on every pause in typing', async () => {
      const low = db.select().from(schema.aiTiers).all().find((t) => t.name === 'Low')!;
      insertModel(db, { name: 'A', model: 'A', priority: 0, tierId: low.id, _providerId: defaultProviderId });
      const rr = new AiModelRouter(db as any, cache, { providerFactory: scripted({}) });
      logger.log.mockClear();
      expect(await rr.completeText({ prefix: 'a', suffix: 'b' }, { tier: 'Low', strict: true })).toBe('done:A');
      expect(logger.log).not.toHaveBeenCalled();
    });
    it('completeText rethrows a non-eligible error without trying the next model', async () => {
      const low = db.select().from(schema.aiTiers).all().find((t) => t.name === 'Low')!;
      const other = insertProvider(db, { name: 'Other', type: 'openrouter', apiKey: 'k2' });
      insertModel(db, { name: 'A', model: 'A', priority: 0, tierId: low.id, _providerId: defaultProviderId });
      insertModel(db, { name: 'B', model: 'B', priority: 1, tierId: low.id, _providerId: other });
      const boom = new Error('boom');
      const factory = scripted({ A: [{ type: 'throw', value: boom }] });
      const rr = new AiModelRouter(db as any, cache, { providerFactory: factory });
      await expect(rr.completeText({ prefix: 'a', suffix: 'b' }, { tier: 'Low', strict: true })).rejects.toBe(boom);
      expect(factory).toHaveBeenCalledTimes(1);
    });
    it('completeText throws AllModelsFailedError when every candidate fails', async () => {
      const low = db.select().from(schema.aiTiers).all().find((t) => t.name === 'Low')!;
      insertModel(db, { name: 'A', model: 'A', priority: 0, tierId: low.id, _providerId: defaultProviderId });
      const rr = new AiModelRouter(db as any, cache, { providerFactory: scripted({ A: [{ type: 'throw', value: new OverloadedError('busy') }] }) });
      const err: any = await rr.completeText({ prefix: 'a', suffix: 'b' }, { tier: 'Low', strict: true }).catch((e) => e);
      expect(err).toBeInstanceOf(AllModelsFailedError);
      expect(err.message).toBe('All AI models are rate-limited or unavailable:\nA: busy');
    });
    it('completeText skips a provider without complete() and uses the next model', async () => {
      const low = db.select().from(schema.aiTiers).all().find((t) => t.name === 'Low')!;
      const other = insertProvider(db, { name: 'Other', type: 'openrouter', apiKey: 'k2' });
      insertModel(db, { name: 'A', model: 'A', priority: 0, tierId: low.id, _providerId: defaultProviderId });
      insertModel(db, { name: 'B', model: 'B', priority: 1, tierId: low.id, _providerId: other });
      const rr = new AiModelRouter(db as any, cache, {
        providerFactory: ((_t: string, cfg: any) => cfg.model === 'A'
          ? { name: 'x', createStreamingRequest: async function* () {} }
          : { name: 'x', createStreamingRequest: async function* () {}, complete: async () => 'done:B' }) as any,
      });
      expect(await rr.completeText({ prefix: 'a', suffix: 'b' }, { tier: 'Low', strict: true })).toBe('done:B');
    });
    it('completeText throws AllModelsFailedError naming providers without complete()', async () => {
      const low = db.select().from(schema.aiTiers).all().find((t) => t.name === 'Low')!;
      insertModel(db, { name: 'A', model: 'A', priority: 0, tierId: low.id, _providerId: defaultProviderId });
      const rr = new AiModelRouter(db as any, cache, {
        providerFactory: (() => ({ name: 'x', createStreamingRequest: async function* () {} })) as any,
      });
      const err: any = await rr.completeText({ prefix: 'a', suffix: 'b' }, { tier: 'Low', strict: true }).catch((e) => e);
      expect(err).toBeInstanceOf(AllModelsFailedError);
      expect(err.message).toBe('All AI models are rate-limited or unavailable:\nA: does not support completion');
    });
    it('an already-aborted signal wins over a missing model configuration on both paths', async () => {
      const rr = new AiModelRouter(db as any, cache, { providerFactory: scripted({}) });
      const ctl = new AbortController();
      ctl.abort();
      const streamErr: any = await collectAsyncIterator(
        rr.createStreamingRequest([{ role: 'user', content: 'x' }], 's', [], { signal: ctl.signal }),
      ).catch((e) => e);
      expect(streamErr?.name).toBe('AbortError');
      const completeErr: any = await rr.completeText({ prefix: 'a', suffix: 'b', signal: ctl.signal }, { tier: 'Low', strict: true })
        .catch((e) => e);
      expect(completeErr?.name).toBe('AbortError');
    });
    it('NoModelsConfiguredError keeps the legacy message for the non-strict path', () => {
      const rr = new AiModelRouter(db as any, cache, { providerFactory: scripted({}) });
      expect(() => rr.getModelsForTier('High')).toThrow(NoModelsConfiguredError);
      expect(() => rr.getModelsForTier('High')).toThrow('No AI models configured. Add one in Settings → Integrations.');
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
