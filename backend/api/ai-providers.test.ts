import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAiProviderEndpoints } from './ai-providers';
import { createTestDb } from '../test-utils/create-test-db';

const { aiProviders, aiModels } = schema;

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerAiProviderEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

function insertProvider(
  db: BetterSQLite3Database<typeof schema>,
  overrides: Partial<typeof aiProviders.$inferInsert> = {},
) {
  const now = new Date();
  return db.insert(aiProviders).values({
    name: 'Test Provider',
    type: 'openrouter',
    apiKey: 'sk-test-123',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
}

describe('AI Providers API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  describe('GET /v1/ai/providers', () => {
    it('should return empty list when no providers', async () => {
      const res = await request(app).get('/v1/ai/providers');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return providers with masked credentials', async () => {
      insertProvider(db, { name: 'My OpenRouter', apiKey: 'sk-ant-secret123' });

      const res = await request(app).get('/v1/ai/providers');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('My OpenRouter');
      expect(res.body.data[0].hasApiKey).toBe(true);
      expect(res.body.data[0].type).toBe('openrouter');
      // API key should NOT be in the response
      expect(res.body.data[0].apiKey).toBeUndefined();
    });

    it('should report hasApiKey false when no key', async () => {
      insertProvider(db, { name: 'No Key Provider', apiKey: null });

      const res = await request(app).get('/v1/ai/providers');
      expect(res.body.data[0].hasApiKey).toBe(false);
    });
  });

  describe('POST /v1/ai/providers', () => {
    it('should create a new provider', async () => {
      const res = await request(app)
        .post('/v1/ai/providers')
        .send({ name: 'New OpenRouter', type: 'openrouter', apiKey: 'sk-ant-new' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('New OpenRouter');
      expect(res.body.data.type).toBe('openrouter');
      expect(res.body.data.hasApiKey).toBe(true);
    });

    it('should reject missing name', async () => {
      const res = await request(app)
        .post('/v1/ai/providers')
        .send({ type: 'openrouter' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name and type are required');
    });

    it('should reject invalid type', async () => {
      const res = await request(app)
        .post('/v1/ai/providers')
        .send({ name: 'Test', type: 'invalid_type' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid type');
    });

    it('should accept all valid types', async () => {
      for (const type of ['gemini', 'ollama', 'openrouter', 'codestral']) {
        const res = await request(app)
          .post('/v1/ai/providers')
          .send({ name: `${type} provider`, type });

        expect(res.body.success).toBe(true);
      }
    });
  });

  describe('PUT /v1/ai/providers/:id', () => {
    it('should update provider fields', async () => {
      insertProvider(db, { name: 'Original' });
      const providers = db.select().from(aiProviders).all();
      const id = providers[0].id;

      const res = await request(app)
        .put(`/v1/ai/providers/${id}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated');
    });

    it('should return 404 for non-existent provider', async () => {
      const res = await request(app)
        .put('/v1/ai/providers/999')
        .send({ name: 'Ghost' });

      expect(res.status).toBe(404);
    });

    it('should reject invalid type on update', async () => {
      insertProvider(db);
      const providers = db.select().from(aiProviders).all();

      const res = await request(app)
        .put(`/v1/ai/providers/${providers[0].id}`)
        .send({ type: 'bad_type' });

      expect(res.status).toBe(400);
    });

    it('should sync provider type to linked models', async () => {
      insertProvider(db, { type: 'openrouter' });
      const providers = db.select().from(aiProviders).all();
      const providerId = providers[0].id;

      // Create a linked model
      const now = new Date();
      db.insert(aiModels).values({
        name: 'My Model',
        provider: 'openrouter',
        providerId,
        priority: 0,
        createdAt: now,
        updatedAt: now,
      }).run();

      // Change provider type
      await request(app)
        .put(`/v1/ai/providers/${providerId}`)
        .send({ type: 'gemini' });

      const models = db.select().from(aiModels).all();
      expect(models[0].provider).toBe('gemini');
    });

    it('should allow updating apiKey', async () => {
      insertProvider(db, { apiKey: 'old-key' });
      const providers = db.select().from(aiProviders).all();

      const res = await request(app)
        .put(`/v1/ai/providers/${providers[0].id}`)
        .send({ apiKey: 'new-key' });

      expect(res.body.success).toBe(true);
      const updated = db.select().from(aiProviders).all()[0];
      expect(updated.apiKey).toBe('new-key');
    });
  });

  describe('DELETE /v1/ai/providers/:id', () => {
    it('should delete a provider with no linked models', async () => {
      insertProvider(db);
      const providers = db.select().from(aiProviders).all();

      const res = await request(app).delete(`/v1/ai/providers/${providers[0].id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const remaining = db.select().from(aiProviders).all();
      expect(remaining).toHaveLength(0);
    });

    it('should reject deletion if models reference it', async () => {
      insertProvider(db);
      const providers = db.select().from(aiProviders).all();
      const providerId = providers[0].id;

      const now = new Date();
      db.insert(aiModels).values({
        name: 'Linked Model',
        provider: 'openrouter',
        providerId,
        priority: 0,
        createdAt: now,
        updatedAt: now,
      }).run();

      const res = await request(app).delete(`/v1/ai/providers/${providerId}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('model(s) still reference it');
    });

    it('should return 404 for non-existent provider', async () => {
      const res = await request(app).delete('/v1/ai/providers/999');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /v1/ai/providers/:id/test', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return 404 for non-existent provider', async () => {
      const res = await request(app).post('/v1/ai/providers/999/test');
      expect(res.status).toBe(404);
    });

    it('should test openrouter provider connection successfully', async () => {
      insertProvider(db, { type: 'openrouter', apiKey: 'sk-ant-test' });
      const providers = db.select().from(aiProviders).all();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const res = await request(app).post(`/v1/ai/providers/${providers[0].id}/test`);
      expect(res.body.success).toBe(true);
    });

    it('should treat 429 as successful connection test', async () => {
      insertProvider(db, { type: 'openrouter', apiKey: 'sk-ant-test' });
      const providers = db.select().from(aiProviders).all();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('rate limited', { status: 429 }),
      );

      const res = await request(app).post(`/v1/ai/providers/${providers[0].id}/test`);
      expect(res.body.success).toBe(true);
    });

    it('should return error for provider without credentials', async () => {
      insertProvider(db, { type: 'openrouter', apiKey: null });
      const providers = db.select().from(aiProviders).all();

      const res = await request(app).post(`/v1/ai/providers/${providers[0].id}/test`);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('No OpenRouter API key configured');
    });

    it('should return error on auth failure', async () => {
      insertProvider(db, { type: 'openrouter', apiKey: 'bad-key' });
      const providers = db.select().from(aiProviders).all();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
      );

      const res = await request(app).post(`/v1/ai/providers/${providers[0].id}/test`);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid API key');
    });
  });
});
