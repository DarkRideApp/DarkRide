import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { stubFetch, jsonResponse } from '../services/ai/test-helpers';
import { RateLimitCache } from '../services/ai-model-router';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAiProviderEndpoints } from './ai-providers';
import { createTestDb } from '../test-utils/create-test-db';

const { aiProviders, aiModels } = schema;

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

function createApp(db: BetterSQLite3Database<typeof schema>, cache: RateLimitCache = new RateLimitCache()) {
  clearEndpoints();
  registerAiProviderEndpoints(db as any, cache);
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

  describe('validation and key handling', () => {
    afterEach(() => vi.unstubAllGlobals());

    const post = (body: any) => request(app).post('/v1/ai/providers').send(body);
    const put = (id: number, body: any) => request(app).put(`/v1/ai/providers/${id}`).send(body);
    const rowOf = (id: number) => db.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, id)).get()!;

    it('accepts every catalog type including the new ones', async () => {
      for (const type of ['anthropic', 'gemini', 'ollama', 'openrouter', 'codestral', 'mistral', 'openai', 'claude-cli']) {
        expect((await post({ name: type, type, apiKey: 'sk-test-placeholder' })).status).toBe(200);
      }
      expect((await post({ name: 'c', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234' })).status).toBe(200);
    });

    it('rejects an unknown type listing the valid ones', async () => {
      const res = await post({ name: 'x', type: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('openai-compatible');
    });

    it('PUT rejects an unknown type listing the valid ones', async () => {
      const created = await post({ name: 'p', type: 'anthropic', apiKey: 'sk-test-placeholder' });
      const res = await put(created.body.data.id, { type: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('openai-compatible');
    });

    it('requires a base url for openai-compatible and validates it', async () => {
      expect((await post({ name: 'c', type: 'openai-compatible' })).status).toBe(400);
      expect((await post({ name: 'c', type: 'ollama', baseUrl: 'localhost:11434' })).status).toBe(400);
      expect((await post({ name: 'c', type: 'ollama', baseUrl: 'http://169.254.169.254' })).status).toBe(400);
      const missing = await post({ name: 'c', type: 'openai-compatible', baseUrl: '   ' });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('Base URL is required for OpenAI-compatible');
    });

    it('rejects credentials, query strings, fragments and metadata hosts in the base url', async () => {
      const BLOCKED = 'Base URL points at a link-local or metadata address, which is not allowed';
      const cases: [string, string][] = [
        ['http://user:pass@127.0.0.1:1234', 'Base URL must not contain credentials. Put the key in the API Key field.'],
        ['http://127.0.0.1:1234/v1?token=x', 'Base URL must not contain a query string'],
        ['http://127.0.0.1:1234/v1#frag', 'Base URL must not contain a fragment'],
        ['http://metadata.google.internal./', BLOCKED],
        ['http://[::ffff:169.254.169.254]/', BLOCKED],
        ['http://[fd00:ec2::254]/', BLOCKED],
        ['http://[fe80::1]/', BLOCKED],
        // Decimal, hex and octal spellings of 169.254.169.254; URL parsing canonicalises them to dotted form.
        ['http://2852039166/', BLOCKED],
        ['http://0xa9fea9fe/', BLOCKED],
        ['http://0251.0376.0251.0376/', BLOCKED],
        ['ftp://127.0.0.1/', 'Base URL must start with http:// or https://'],
      ];
      for (const [baseUrl, error] of cases) {
        const res = await post({ name: 'c', type: 'openai-compatible', baseUrl });
        expect(res.status, baseUrl).toBe(400);
        expect(res.body, baseUrl).toEqual({ success: false, error });
      }
      expect(db.select().from(schema.aiProviders).all()).toHaveLength(0);
      // RFC 1918 and loopback stay allowed: a LAN Ollama is a main use case.
      expect((await post({ name: 'lan', type: 'ollama', baseUrl: 'http://192.168.1.20:11434' })).status).toBe(200);
    });

    it('rejects a base url that is not a string', async () => {
      const res = await post({ name: 'c', type: 'ollama', baseUrl: 1234 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('baseUrl');
    });

    it('stores the normalised base url and drops it for claude-cli', async () => {
      const a = await post({ name: 'a', type: 'openai-compatible', baseUrl: ' http://127.0.0.1:1234/ ' });
      expect(a.body.data.baseUrl).toBe('http://127.0.0.1:1234/v1');
      const c = await post({ name: 'c', type: 'claude-cli', baseUrl: 'http://x.test' });
      expect(c.body.data.baseUrl).toBeNull();
    });

    it('trims a pasted key and rejects control characters', async () => {
      const ok = await post({ name: 'k', type: 'anthropic', apiKey: '  sk-test-placeholder\n' });
      expect(ok.status).toBe(200);
      expect(rowOf(ok.body.data.id).apiKey).toBe('sk-test-placeholder');
      expect((await post({ name: 'k2', type: 'anthropic', apiKey: 'sk-test\u0000placeholder' })).status).toBe(400);
      expect((await post({ name: 'k3', type: 'anthropic', apiKey: 'sk-test\nplaceholder' })).status).toBe(400);
      expect((await post({ name: 'k4', type: 'anthropic', apiKey: '   ' })).status).toBe(400);
      expect((await post({ name: 'k5', type: 'anthropic', apiKey: 42 })).status).toBe(400);
      expect(db.select().from(schema.aiProviders).all()).toHaveLength(1);
    });

    it('rejects keys with invisible, non-ASCII or inner whitespace characters, naming the problem', async () => {
      const cases: Record<string, string> = {
        'zero-width space': 'sk-test​placeholder',
        'line separator': 'sk-test placeholder',
        'C1 next line': 'sk-test\u0085placeholder',
        'inner space': 'sk-test placeholder',
        'emoji': 'sk-test\u{1F511}placeholder',
        'latin-1 letter': 'sk-testéplaceholder',
      };
      for (const [label, apiKey] of Object.entries(cases)) {
        const res = await post({ name: label, type: 'anthropic', apiKey });
        expect(res.status, label).toBe(400);
        expect(res.body.error, label).toMatch(/API key contains/);
        expect(JSON.stringify(res.body), label).not.toContain('placeholder');
      }
      const created = await post({ name: 'p', type: 'anthropic', apiKey: 'sk-test-placeholder' });
      const put400 = await put(created.body.data.id, { apiKey: 'sk-test​placeholder' });
      expect(put400.status).toBe(400);
      expect(rowOf(created.body.data.id).apiKey).toBe('sk-test-placeholder');
      expect(db.select().from(schema.aiProviders).all()).toHaveLength(1);
    });

    it('rejects a provider name that is not a non-empty string', async () => {
      for (const name of ['', '   ', null, 42, { a: 1 }, ['x']]) {
        const res = await post({ name, type: 'anthropic' });
        expect(res.status, JSON.stringify(name)).toBe(400);
        expect(res.body.success).toBe(false);
      }
      expect(db.select().from(schema.aiProviders).all()).toHaveLength(0);
      const ok = await post({ name: '  Spaced  ', type: 'anthropic' });
      expect(ok.body.data.name).toBe('Spaced');
    });

    it('PUT rejects a supplied provider name that is not a non-empty string', async () => {
      const created = await post({ name: 'p', type: 'anthropic', apiKey: 'sk-test-placeholder' });
      const id = created.body.data.id;
      for (const name of [null, '', '   ', 42, { a: 1 }]) {
        const res = await put(id, { name });
        expect(res.status, JSON.stringify(name)).toBe(400);
        expect(res.body.error).toBe('name must be a non-empty string');
      }
      expect(rowOf(id).name).toBe('p');
      const ok = await put(id, { name: ' renamed ' });
      expect(ok.status).toBe(200);
      expect(rowOf(id).name).toBe('renamed');
    });

    it('never echoes the key in a response', async () => {
      const created = await post({ name: 'k', type: 'anthropic', apiKey: 'sk-test-placeholder' });
      expect(JSON.stringify(created.body)).not.toContain('sk-test-placeholder');
      const updated = await put(created.body.data.id, { apiKey: 'sk-test-other' });
      expect(JSON.stringify(updated.body)).not.toContain('sk-test-other');
      const rejected = await put(created.body.data.id, { apiKey: 'sk-test\u0007bell' });
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.body)).not.toContain('sk-test');
    });

    it('PUT clears the stored key when the base url or type changes and no key is supplied', async () => {
      const created = await post({ name: 'p', type: 'anthropic', apiKey: 'sk-test-placeholder' });
      const id = created.body.data.id;
      const keyOf = () => rowOf(id).apiKey;
      expect((await put(id, { name: 'renamed', type: 'anthropic', baseUrl: null })).status).toBe(200);
      expect(keyOf()).toBe('sk-test-placeholder');                         // rename with unchanged effective URL keeps the key
      expect((await put(id, { baseUrl: 'https://api.anthropic.com/' })).status).toBe(200);
      expect(keyOf()).toBe('sk-test-placeholder');                         // same effective URL
      expect((await put(id, { baseUrl: 'https://attacker.test' })).status).toBe(200);
      expect(keyOf()).toBeNull();                                          // changed URL clears the key
      expect((await put(id, { baseUrl: 'https://proxy.test', apiKey: 'sk-test-new' })).status).toBe(200);
      expect(keyOf()).toBe('sk-test-new');                                 // a supplied key is kept
      expect(rowOf(id).baseUrl).toBe('https://proxy.test');
    });

    it('PUT clears the stored key when the type changes and no key is supplied', async () => {
      const created = await post({ name: 'p', type: 'anthropic', apiKey: 'sk-test-placeholder' });
      const id = created.body.data.id;
      expect((await put(id, { type: 'openrouter' })).status).toBe(200);
      expect(rowOf(id).apiKey).toBeNull();
    });

    it('PUT with the same type and an unchanged url keeps the key', async () => {
      const created = await post({ name: 'p', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: 'sk-test-placeholder' });
      const id = created.body.data.id;
      expect((await put(id, { name: 'renamed', type: 'ollama', baseUrl: 'http://127.0.0.1:11434/' })).status).toBe(200);
      expect(rowOf(id).apiKey).toBe('sk-test-placeholder');
      expect(rowOf(id).name).toBe('renamed');
    });

    it('PUT rejects an invalid changed base url and leaves the row untouched', async () => {
      const created = await post({ name: 'p', type: 'anthropic', apiKey: 'sk-test-placeholder' });
      const id = created.body.data.id;
      const res = await put(id, { name: 'renamed', baseUrl: 'http://169.254.169.254/latest' });
      expect(res.status).toBe(400);
      expect(rowOf(id)).toMatchObject({ name: 'p', apiKey: 'sk-test-placeholder', baseUrl: null });
    });

    it('PUT requires a base url when switching to openai-compatible', async () => {
      const created = await post({ name: 'p', type: 'anthropic', apiKey: 'sk-test-placeholder' });
      const res = await put(created.body.data.id, { type: 'openai-compatible' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Base URL is required for OpenAI-compatible');
    });

    it('apiKey semantics on PUT: undefined keeps, "" and null clear, whitespace-only is rejected', async () => {
      const created = await post({ name: 'p', type: 'anthropic', apiKey: 'sk-test-placeholder' });
      const id = created.body.data.id;
      const keyOf = () => rowOf(id).apiKey;
      expect((await put(id, { name: 'renamed' })).status).toBe(200);
      expect(keyOf()).toBe('sk-test-placeholder');
      expect((await put(id, { apiKey: '   ' })).status).toBe(400);
      expect(keyOf()).toBe('sk-test-placeholder');
      await put(id, { apiKey: null });
      expect(keyOf()).toBeNull();
      await put(id, { apiKey: 'sk-test-placeholder' });
      await put(id, { apiKey: '' });
      expect(keyOf()).toBeNull();
    });

    it('PUT trims a pasted key', async () => {
      const created = await post({ name: 'p', type: 'anthropic' });
      await put(created.body.data.id, { apiKey: '\tsk-test-placeholder \r\n' });
      expect(rowOf(created.body.data.id).apiKey).toBe('sk-test-placeholder');
    });

    it('GET models returns {success:false,error,data:[]} when listing fails', async () => {
      const created = await post({ name: 'c', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234' });
      stubFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') }); });
      const res = await request(app).get(`/v1/ai/providers/${created.body.data.id}/models`);
      expect(res.body).toMatchObject({ success: false, data: [] });
      expect(res.body.error).toMatch(/OpenAI-compatible/);
    });

    it('PUT does not validate an unchanged legacy base url', async () => {
      const now = new Date();
      const r = db.insert(schema.aiProviders).values({ name: 'legacy', type: 'ollama', baseUrl: 'localhost:11434', createdAt: now, updatedAt: now }).run();
      const res = await put(Number(r.lastInsertRowid), { name: 'renamed', type: 'ollama', baseUrl: 'localhost:11434' });
      expect(res.status).toBe(200);
      expect(res.body.data.baseUrl).toBe('localhost:11434');
    });

    it('PUT re-validates a legacy base url against the new type when the type changes', async () => {
      const now = new Date();
      const r = db.insert(schema.aiProviders).values({ name: 'legacy', type: 'ollama', baseUrl: 'localhost:11434', createdAt: now, updatedAt: now }).run();
      const res = await put(Number(r.lastInsertRowid), { type: 'openai-compatible' });
      expect(res.status).toBe(400);
      expect(rowOf(Number(r.lastInsertRowid)).type).toBe('ollama');
    });

    it('PUT on a stored retired type can still rename it instead of throwing', async () => {
      const now = new Date();
      const r = db.insert(schema.aiProviders).values({ name: 'old', type: 'retired-type', apiKey: 'k', createdAt: now, updatedAt: now }).run();
      const res = await put(Number(r.lastInsertRowid), { name: 'renamed' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('renamed');
      expect(rowOf(Number(r.lastInsertRowid)).apiKey).toBe('k');
    });

    it('PUT on a claude-cli row drops a stale base url without clearing its token', async () => {
      // The CLI never sends the base URL anywhere, so dropping a stale value does not redirect the token.
      const now = new Date();
      const r = db.insert(schema.aiProviders).values({ name: 'cli', type: 'claude-cli', apiKey: 'oauth-placeholder', baseUrl: 'http://stale.test', createdAt: now, updatedAt: now }).run();
      const id = Number(r.lastInsertRowid);
      const res = await put(id, { name: 'renamed', type: 'claude-cli', baseUrl: 'http://stale.test' });
      expect(res.status).toBe(200);
      expect(rowOf(id)).toMatchObject({ name: 'renamed', apiKey: 'oauth-placeholder', baseUrl: null });
    });

    it('GET models and POST test delegate to provider-ops', async () => {
      const created = await post({ name: 'c', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234' });
      stubFetch(() => jsonResponse({ data: [{ id: 'a' }] }));
      const models = await request(app).get(`/v1/ai/providers/${created.body.data.id}/models`);
      expect(models.body.data).toEqual([{ id: 'a', name: 'a' }]);
      const test = await request(app).post(`/v1/ai/providers/${created.body.data.id}/test`);
      expect(test.body).toEqual({ success: true, model: '1 models' });
    });

    it('GET models serves the static list for claude-cli without a request', async () => {
      const created = await post({ name: 'cli', type: 'claude-cli' });
      const { mock } = stubFetch(() => jsonResponse({}));
      const res = await request(app).get(`/v1/ai/providers/${created.body.data.id}/models`);
      expect(res.body.success).toBe(true);
      expect(res.body.data.map((m: any) => m.id)).toContain('sonnet');
      expect(mock).not.toHaveBeenCalled();
    });
  });

  describe('saving a provider lifts its models\' cooldowns', () => {
    const COOLDOWN_MINUTES = 10;
    let cache: RateLimitCache;
    let appWithCache: express.Express;

    beforeEach(() => {
      cache = new RateLimitCache();
      appWithCache = createApp(db, cache);
    });

    const addModel = (providerId: number, name: string) => {
      const now = new Date();
      return Number(db.insert(aiModels).values({ name, provider: 'anthropic', providerId, priority: 0, createdAt: now, updatedAt: now }).run().lastInsertRowid);
    };
    const cooled = (id: number) => cache.isInCooldown(id, COOLDOWN_MINUTES);

    it('lifts the cooldown of exactly the edited provider\'s models after a key change', async () => {
      const p1 = Number(insertProvider(db, { type: 'anthropic', apiKey: 'sk-test-old' }).lastInsertRowid);
      const p2 = Number(insertProvider(db, { type: 'anthropic', apiKey: 'sk-test-other' }).lastInsertRowid);
      const a = addModel(p1, 'a');
      const b = addModel(p1, 'b');
      const c = addModel(p2, 'c');
      for (const id of [a, b, c]) cache.record429(id);
      expect([a, b, c].map(cooled)).toEqual([true, true, true]);

      const res = await request(appWithCache).put(`/v1/ai/providers/${p1}`).send({ apiKey: 'sk-test-placeholder' });
      expect(res.status).toBe(200);
      expect([cooled(a), cooled(b)]).toEqual([false, false]);
      expect(cooled(c)).toBe(true);                       // another provider's model keeps its cooldown
    });

    it('keeps every cooldown when the PUT fails validation or the provider is missing', async () => {
      const p1 = Number(insertProvider(db, { type: 'anthropic', apiKey: 'sk-test-old' }).lastInsertRowid);
      const a = addModel(p1, 'a');
      cache.record429(a);
      expect((await request(appWithCache).put(`/v1/ai/providers/${p1}`).send({ apiKey: 'sk-test\nplaceholder' })).status).toBe(400);
      expect((await request(appWithCache).put(`/v1/ai/providers/${p1}`).send({ baseUrl: 'http://169.254.169.254' })).status).toBe(400);
      expect((await request(appWithCache).put(`/v1/ai/providers/${p1}`).send({ type: 'nope' })).status).toBe(400);
      expect((await request(appWithCache).put(`/v1/ai/providers/${p1}`).send({ name: '' })).status).toBe(400);
      expect((await request(appWithCache).put('/v1/ai/providers/999').send({ apiKey: 'sk-test-placeholder' })).status).toBe(404);
      expect(cooled(a)).toBe(true);
    });
  });
});
