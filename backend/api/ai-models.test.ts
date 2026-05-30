import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAiModelEndpoints } from './ai-models';
import { RateLimitCache, AiModelRouter } from '../services/ai-model-router';
import { createTestDb } from '../test-utils/create-test-db';
import { ClaudeCliProvider } from '../services/claude-cli-provider';

const { aiModels, aiProviders, aiTiers } = schema;

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  const cache = new RateLimitCache();
  const router = new AiModelRouter(db as any, cache);
  registerAiModelEndpoints(db as any, router, cache);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return { app, router, cache };
}

function insertProvider(
  db: BetterSQLite3Database<typeof schema>,
  overrides: Partial<typeof aiProviders.$inferInsert> = {},
) {
  const now = new Date();
  const result = db.insert(aiProviders).values({
    name: 'Test Provider',
    type: 'openrouter',
    apiKey: 'sk-test-123',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return Number(result.lastInsertRowid);
}

function insertTier(
  db: BetterSQLite3Database<typeof schema>,
  name: string,
  sortOrder: number,
) {
  const now = Date.now();
  const result = db.insert(aiTiers).values({
    name,
    sortOrder,
    isHardcoded: true,
    createdAt: now,
    updatedAt: now,
  }).run();
  return Number(result.lastInsertRowid);
}

function insertModel(
  db: BetterSQLite3Database<typeof schema>,
  providerId: number,
  overrides: Partial<typeof aiModels.$inferInsert> = {},
) {
  const now = new Date();
  return db.insert(aiModels).values({
    name: 'Test Model',
    provider: 'openrouter',
    providerId,
    priority: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
}

describe('AI Models API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;
  let cache: RateLimitCache;
  let defaultProviderId: number;
  let highTierId: number;
  let lowTierId: number;

  beforeEach(() => {
    db = createTestDb();
    const created = createApp(db);
    app = created.app;
    cache = created.cache;
    // Seed tiers
    highTierId = insertTier(db, 'High', 0);
    lowTierId = insertTier(db, 'Low', 1);
    // Create a default provider for tests
    defaultProviderId = insertProvider(db);
  });

  describe('GET /v1/ai/models', () => {
    it('should return empty list when no models', async () => {
      const res = await request(app).get('/v1/ai/models');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return models with providerId and providerName', async () => {
      insertModel(db, defaultProviderId, { name: 'My OpenRouter', tierId: highTierId });

      const res = await request(app).get('/v1/ai/models');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('My OpenRouter');
      expect(res.body.data[0].providerId).toBe(defaultProviderId);
      expect(res.body.data[0].providerName).toBe('Test Provider');
      // Credential fields should NOT be present
      expect(res.body.data[0].apiKey).toBeUndefined();
      expect(res.body.data[0].hasApiKey).toBeUndefined();
    });

    it('should return models sorted by priority', async () => {
      insertModel(db, defaultProviderId, { name: 'Second', priority: 1 });
      insertModel(db, defaultProviderId, { name: 'First', priority: 0 });

      const res = await request(app).get('/v1/ai/models');
      expect(res.body.data[0].name).toBe('First');
      expect(res.body.data[1].name).toBe('Second');
    });

    it('GET /v1/ai/models returns tierName along with tierId', async () => {
      insertModel(db, defaultProviderId, { name: 'Joined Model', tierId: highTierId });

      const res = await request(app).get('/v1/ai/models');
      expect(res.status).toBe(200);
      expect(res.body.data[0].tierName).toBe('High');
      expect(typeof res.body.data[0].tierId).toBe('number');
    });
  });

  describe('POST /v1/ai/models', () => {
    it('should create a new model linked to provider', async () => {
      const res = await request(app)
        .post('/v1/ai/models')
        .send({
          name: 'New OpenRouter',
          providerId: defaultProviderId,
          model: 'claude-sonnet-4-20250514',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('New OpenRouter');
      expect(res.body.data.provider).toBe('openrouter');
      expect(res.body.data.providerId).toBe(defaultProviderId);
      expect(res.body.data.providerName).toBe('Test Provider');
      expect(res.body.data.priority).toBe(0);
    });

    it('should auto-increment priority', async () => {
      insertModel(db, defaultProviderId, { name: 'Existing', priority: 0 });

      const res = await request(app)
        .post('/v1/ai/models')
        .send({ name: 'Second', providerId: defaultProviderId });

      expect(res.body.data.priority).toBe(1);
    });

    it('should reject missing name', async () => {
      const res = await request(app)
        .post('/v1/ai/models')
        .send({ providerId: defaultProviderId });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name and providerId are required');
    });

    it('should reject missing providerId', async () => {
      const res = await request(app)
        .post('/v1/ai/models')
        .send({ name: 'Test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name and providerId are required');
    });

    it('should reject invalid providerId', async () => {
      const res = await request(app)
        .post('/v1/ai/models')
        .send({ name: 'Test', providerId: 999 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Provider not found');
    });

    it('should store custom cooldownMinutes', async () => {
      const res = await request(app)
        .post('/v1/ai/models')
        .send({ name: 'Custom CD', providerId: defaultProviderId, cooldownMinutes: 30 });

      expect(res.body.data.cooldownMinutes).toBe(30);
    });

    it('should accept a tierId and store it', async () => {
      const res = await request(app)
        .post('/v1/ai/models')
        .send({ name: 'Low Tier Model', providerId: defaultProviderId, tierId: lowTierId });

      expect(res.status).toBe(200);
      expect(res.body.data.tierId).toBe(lowTierId);
    });

    it('should default to High tier when no tierId provided', async () => {
      const res = await request(app)
        .post('/v1/ai/models')
        .send({ name: 'Default Tier Model', providerId: defaultProviderId });

      expect(res.status).toBe(200);
      expect(res.body.data.tierId).toBe(highTierId);
    });

    it('should default to High tier when tierId is explicitly null (the orphan-bug fix)', async () => {
      // The UI's modelForm initializes tierId to null until the tiers list loads.
      // If a user opens the add-model modal early, the form posts tierId: null —
      // which previously orphaned the model (tier_id = NULL, invisible to the
      // tier-aware query). Backend now coerces null to the High default.
      const res = await request(app)
        .post('/v1/ai/models')
        .send({ name: 'Null Tier Model', providerId: defaultProviderId, tierId: null });

      expect(res.status).toBe(200);
      expect(res.body.data.tierId).toBe(highTierId);
    });
  });

  describe('PUT /v1/ai/models/:id', () => {
    it('should update model fields', async () => {
      insertModel(db, defaultProviderId, { name: 'Original' });
      const models = db.select().from(aiModels).all();
      const id = models[0].id;

      const res = await request(app)
        .put(`/v1/ai/models/${id}`)
        .send({ name: 'Updated', model: 'claude-opus-4-20250514' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated');
    });

    it('should return 404 for non-existent model', async () => {
      const res = await request(app)
        .put('/v1/ai/models/999')
        .send({ name: 'Ghost' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Model not found');
    });

    it('should reject invalid providerId on update', async () => {
      insertModel(db, defaultProviderId);
      const models = db.select().from(aiModels).all();

      const res = await request(app)
        .put(`/v1/ai/models/${models[0].id}`)
        .send({ providerId: 999 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Provider not found');
    });

    it('should switch provider linkage', async () => {
      const geminiProviderId = insertProvider(db, { name: 'Gemini Provider', type: 'gemini', apiKey: 'gem-key' });
      insertModel(db, defaultProviderId);
      const models = db.select().from(aiModels).all();

      const res = await request(app)
        .put(`/v1/ai/models/${models[0].id}`)
        .send({ providerId: geminiProviderId });

      expect(res.body.success).toBe(true);
      expect(res.body.data.providerId).toBe(geminiProviderId);
      expect(res.body.data.provider).toBe('gemini');
    });

    it('should set model to null when empty string sent', async () => {
      insertModel(db, defaultProviderId, { model: 'claude-sonnet-4-20250514' });
      const models = db.select().from(aiModels).all();

      const res = await request(app)
        .put(`/v1/ai/models/${models[0].id}`)
        .send({ model: '' });

      expect(res.body.success).toBe(true);
      const updated = db.select().from(aiModels).all()[0];
      expect(updated.model).toBeNull();
    });

    it('should update tierId when provided', async () => {
      insertModel(db, defaultProviderId, { tierId: highTierId });
      const models = db.select().from(aiModels).all();

      const res = await request(app)
        .put(`/v1/ai/models/${models[0].id}`)
        .send({ tierId: lowTierId });

      expect(res.status).toBe(200);
      expect(res.body.data.tierId).toBe(lowTierId);
    });

    it('should leave tier unchanged when tierId not in body', async () => {
      insertModel(db, defaultProviderId, { tierId: highTierId });
      const models = db.select().from(aiModels).all();

      const res = await request(app)
        .put(`/v1/ai/models/${models[0].id}`)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body.data.tierId).toBe(highTierId);
    });

    it('should default to High tier when tierId is explicitly null (the orphan-bug fix)', async () => {
      // Symmetrical to the POST behaviour: a PUT body with tierId: null
      // must not orphan the model. Mirrors the UI form's loading-state hazard.
      insertModel(db, defaultProviderId, { tierId: lowTierId });
      const models = db.select().from(aiModels).all();

      const res = await request(app)
        .put(`/v1/ai/models/${models[0].id}`)
        .send({ tierId: null });

      expect(res.status).toBe(200);
      expect(res.body.data.tierId).toBe(highTierId);
    });
  });

  describe('DELETE /v1/ai/models/:id', () => {
    it('should delete a model', async () => {
      insertModel(db, defaultProviderId);
      const models = db.select().from(aiModels).all();
      const id = models[0].id;

      const res = await request(app).delete(`/v1/ai/models/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const remaining = db.select().from(aiModels).all();
      expect(remaining).toHaveLength(0);
    });

    it('should return 404 for non-existent model', async () => {
      const res = await request(app).delete('/v1/ai/models/999');
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Model not found');
    });
  });

  describe('PUT /v1/ai/models/:id/toggle', () => {
    it('should toggle enabled from true to false', async () => {
      insertModel(db, defaultProviderId, { enabled: true });
      const models = db.select().from(aiModels).all();

      const res = await request(app)
        .put(`/v1/ai/models/${models[0].id}/toggle`);

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
    });

    it('should toggle enabled from false to true', async () => {
      insertModel(db, defaultProviderId, { enabled: false });
      const models = db.select().from(aiModels).all();

      const res = await request(app)
        .put(`/v1/ai/models/${models[0].id}/toggle`);

      expect(res.body.data.enabled).toBe(true);
    });

    it('should return 404 for non-existent model', async () => {
      const res = await request(app).put('/v1/ai/models/999/toggle');
      expect(res.status).toBe(404);
    });
  });

  describe('reorder logic (direct DB)', () => {
    it('should reorder model priorities in the database', () => {
      insertModel(db, defaultProviderId, { name: 'A', priority: 0 });
      insertModel(db, defaultProviderId, { name: 'B', priority: 1 });
      insertModel(db, defaultProviderId, { name: 'C', priority: 2 });

      const models = db.select().from(aiModels).all();
      const [a, b, c] = models;

      const ids = [c.id, b.id, a.id];
      const { eq } = require('drizzle-orm');
      const now = new Date();
      for (let i = 0; i < ids.length; i++) {
        db.update(aiModels)
          .set({ priority: i, updatedAt: now })
          .where(eq(aiModels.id, ids[i]))
          .run();
      }

      const reordered = db.select().from(aiModels).all();
      const cModel = reordered.find((m: any) => m.name === 'C');
      const bModel = reordered.find((m: any) => m.name === 'B');
      const aModel = reordered.find((m: any) => m.name === 'A');

      expect(cModel!.priority).toBe(0);
      expect(bModel!.priority).toBe(1);
      expect(aModel!.priority).toBe(2);
    });
  });

  describe('POST /v1/ai/models/:id/test', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return 404 for non-existent model', async () => {
      const res = await request(app).post('/v1/ai/models/999/test');
      expect(res.status).toBe(404);
    });

    it('should test connection via linked provider', async () => {
      insertModel(db, defaultProviderId, { provider: 'openrouter' });
      const models = db.select().from(aiModels).all();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const res = await request(app).post(`/v1/ai/models/${models[0].id}/test`);
      expect(res.body.success).toBe(true);
    });

    it('should treat 429 as successful connection test', async () => {
      insertModel(db, defaultProviderId, { provider: 'openrouter' });
      const models = db.select().from(aiModels).all();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('rate limited', { status: 429 }),
      );

      const res = await request(app).post(`/v1/ai/models/${models[0].id}/test`);
      expect(res.body.success).toBe(true);
    });

    it('should return error for provider without credentials', async () => {
      const noKeyProvider = insertProvider(db, { name: 'No Key', apiKey: null });
      insertModel(db, noKeyProvider, { provider: 'openrouter' });
      const models = db.select().from(aiModels).all();
      // Find the model linked to noKeyProvider
      const model = models.find(m => m.providerId === noKeyProvider)!;

      const res = await request(app).post(`/v1/ai/models/${model.id}/test`);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('No OpenRouter API key configured');
    });

    it('should return error on auth failure', async () => {
      insertModel(db, defaultProviderId, { provider: 'openrouter' });
      const models = db.select().from(aiModels).all();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
      );

      const res = await request(app).post(`/v1/ai/models/${models[0].id}/test`);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid API key');
    });

    it('passes a claude-cli model test when version + tool round-trip succeed', async () => {
      const cliProvider = insertProvider(db, { name: 'Claude CLI', type: 'claude-cli', apiKey: 'oauth-tok' });
      insertModel(db, cliProvider, { provider: 'claude-cli', model: 'sonnet' });
      const model = db.select().from(aiModels).all().find(m => m.providerId === cliProvider)!;

      vi.spyOn(ClaudeCliProvider, 'getVersion').mockResolvedValue('2.1.158');
      const toolSpy = vi.spyOn(ClaudeCliProvider, 'testToolUse').mockResolvedValue({ ok: true });

      const res = await request(app).post(`/v1/ai/models/${model.id}/test`);

      expect(toolSpy).toHaveBeenCalledWith('oauth-tok', 'sonnet');
      expect(res.body.success).toBe(true);
    });

    it('fails a claude-cli model test when the CLI cannot drive tools (token degraded)', async () => {
      const cliProvider = insertProvider(db, { name: 'Claude CLI', type: 'claude-cli', apiKey: 'oauth-tok' });
      insertModel(db, cliProvider, { provider: 'claude-cli', model: 'sonnet' });
      const model = db.select().from(aiModels).all().find(m => m.providerId === cliProvider)!;

      vi.spyOn(ClaudeCliProvider, 'getVersion').mockResolvedValue('2.1.158');
      vi.spyOn(ClaudeCliProvider, 'testToolUse').mockResolvedValue({
        ok: false, reason: 'emitted tool calls as TEXT instead of running them',
      });

      const res = await request(app).post(`/v1/ai/models/${model.id}/test`);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('TEXT');
    });

    it('fails a claude-cli model test when the CLI binary is missing', async () => {
      const cliProvider = insertProvider(db, { name: 'Claude CLI', type: 'claude-cli', apiKey: null });
      insertModel(db, cliProvider, { provider: 'claude-cli', model: 'sonnet' });
      const model = db.select().from(aiModels).all().find(m => m.providerId === cliProvider)!;

      vi.spyOn(ClaudeCliProvider, 'getVersion').mockResolvedValue(null);

      const res = await request(app).post(`/v1/ai/models/${model.id}/test`);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('GET /v1/ai/rate-limits', () => {
    it('should return rate limits for all models', async () => {
      insertModel(db, defaultProviderId, { name: 'Model A', priority: 0 });
      insertModel(db, defaultProviderId, { name: 'Model B', priority: 1 });

      const res = await request(app).get('/v1/ai/rate-limits');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].modelName).toBe('Model A');
      expect(res.body.data[0].inCooldown).toBe(false);
    });

    it('should reflect cooldown state', async () => {
      insertModel(db, defaultProviderId, { name: 'Rate Limited Model', cooldownMinutes: 10 });
      const models = db.select().from(aiModels).all();
      cache.record429(models[0].id);

      const res = await request(app).get('/v1/ai/rate-limits');
      expect(res.body.data[0].inCooldown).toBe(true);
      expect(res.body.data[0].cooldownEndsAt).not.toBeNull();
    });
  });
});
