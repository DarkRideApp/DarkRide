import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAiCompleteEndpoints } from './ai-complete';
import { createTestDb } from '../test-utils/create-test-db';

const { settings } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerAiCompleteEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

function setSetting(db: BetterSQLite3Database<typeof schema>, key: string, value: string) {
  db.insert(settings).values({ key, value }).run();
}

function mockFetchOk(responseBody: any) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => responseBody,
  }));
}

function mockFetchError(status: number, body: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  }));
}

describe('AI Complete API Endpoint', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should return 400 when no provider is configured', async () => {
    const res = await request(app)
      .post('/v1/ai/complete')
      .send({ prefix: 'const x = ', suffix: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('No AI provider configured');
  });

  it('should return 400 when body is empty', async () => {
    setSetting(db, 'ai_provider', 'anthropic');
    setSetting(db, 'anthropic_api_key', 'sk-test-key');

    const res = await request(app)
      .post('/v1/ai/complete')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('prefix or suffix is required');
  });

  it('should return 400 for unknown provider', async () => {
    setSetting(db, 'ai_provider', 'unknown-provider');

    const res = await request(app)
      .post('/v1/ai/complete')
      .send({ prefix: 'const ', suffix: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Unknown AI provider: unknown-provider');
  });

  // Anthropic
  describe('Anthropic provider', () => {
    it('should return 400 when API key is not configured', async () => {
      setSetting(db, 'ai_provider', 'anthropic');

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const x = ', suffix: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Anthropic API key not configured');
    });

    it('should return completion on successful call', async () => {
      setSetting(db, 'ai_provider', 'anthropic');
      setSetting(db, 'anthropic_api_key', 'sk-test-key');

      mockFetchOk({
        content: [{ type: 'text', text: 'device.click({ text: "OK" })' }],
      });

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'await ', suffix: ';' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.completion).toBe('device.click({ text: "OK" })');

      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe('https://api.anthropic.com/v1/messages');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('claude-haiku-4-5-20251001');
      expect(body.max_tokens).toBe(256);
      expect(body.temperature).toBe(0);
      expect(body.messages[0].content).toBe('await <CURSOR>;');
      expect(fetchCall[1].headers['x-api-key']).toBe('sk-test-key');
    });

    it('should return 502 when API returns error', async () => {
      setSetting(db, 'ai_provider', 'anthropic');
      setSetting(db, 'anthropic_api_key', 'sk-test-key');

      mockFetchError(429, '{"error":{"message":"Rate limited"}}');

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const ', suffix: '' });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('Anthropic API error (429)');
    });

    it('should return 500 when fetch throws network error', async () => {
      setSetting(db, 'ai_provider', 'anthropic');
      setSetting(db, 'anthropic_api_key', 'sk-test-key');

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const x = ', suffix: '' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('ECONNREFUSED');
    });

    it('should return empty completion when API returns no content', async () => {
      setSetting(db, 'ai_provider', 'anthropic');
      setSetting(db, 'anthropic_api_key', 'sk-test-key');

      mockFetchOk({ content: [] });

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'await device.', suffix: '' });

      expect(res.status).toBe(200);
      expect(res.body.data.completion).toBe('');
    });
  });

  // Gemini
  describe('Gemini provider', () => {
    it('should return 400 when API key is not configured', async () => {
      setSetting(db, 'ai_provider', 'gemini');

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const ', suffix: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Gemini API key not configured');
    });

    it('should call Gemini API with correct format', async () => {
      setSetting(db, 'ai_provider', 'gemini');
      setSetting(db, 'gemini_api_key', 'gem-test-key');

      mockFetchOk({
        candidates: [{ content: { parts: [{ text: 'completedCode()' }] } }],
      });

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'await ', suffix: ';' });

      expect(res.status).toBe(200);
      expect(res.body.data.completion).toBe('completedCode()');

      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toContain('generativelanguage.googleapis.com');
      expect(fetchCall[0]).toContain('key=gem-test-key');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.system_instruction.parts[0].text).toContain('code completion engine');
      expect(body.contents[0].parts[0].text).toBe('await <CURSOR>;');
    });

    it('should return 502 on Gemini API error', async () => {
      setSetting(db, 'ai_provider', 'gemini');
      setSetting(db, 'gemini_api_key', 'gem-test-key');

      mockFetchError(403, 'Forbidden');

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const ', suffix: '' });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('Gemini API error (403)');
    });
  });

  // Ollama
  describe('Ollama provider', () => {
    it('should call Ollama with default URL and model', async () => {
      setSetting(db, 'ai_provider', 'ollama');

      mockFetchOk({ message: { content: 'ollamaCompletion()' } });

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const x = ', suffix: '' });

      expect(res.status).toBe(200);
      expect(res.body.data.completion).toBe('ollamaCompletion()');

      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe('http://localhost:11434/api/chat');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('qwen2.5-coder:1.5b');
      expect(body.stream).toBe(false);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].content).toBe('const x = <CURSOR>');
    });

    it('should use custom URL and model when configured', async () => {
      setSetting(db, 'ai_provider', 'ollama');
      setSetting(db, 'ollama_base_url', 'http://myhost:9999');
      setSetting(db, 'ollama_model', 'deepseek-coder:6.7b');

      mockFetchOk({ message: { content: 'custom()' } });

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'fn ', suffix: '' });

      expect(res.status).toBe(200);

      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe('http://myhost:9999/api/chat');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('deepseek-coder:6.7b');
    });

    it('should return 502 on Ollama API error', async () => {
      setSetting(db, 'ai_provider', 'ollama');

      mockFetchError(500, 'model not found');

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const ', suffix: '' });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('Ollama API error (500)');
    });
  });

  // OpenRouter
  describe('OpenRouter provider', () => {
    it('should return 400 when API key is not configured', async () => {
      setSetting(db, 'ai_provider', 'openrouter');

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const ', suffix: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('OpenRouter API key not configured');
    });

    it('should call OpenRouter with correct OpenAI-compatible format', async () => {
      setSetting(db, 'ai_provider', 'openrouter');
      setSetting(db, 'openrouter_api_key', 'or-test-key');

      mockFetchOk({
        choices: [{ message: { content: 'routerCompletion()' } }],
      });

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'let y = ', suffix: ';' });

      expect(res.status).toBe(200);
      expect(res.body.data.completion).toBe('routerCompletion()');

      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(fetchCall[1].headers['Authorization']).toBe('Bearer or-test-key');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('google/gemini-2.0-flash-001');
      expect(body.messages).toHaveLength(2);
      expect(body.messages[1].content).toBe('let y = <CURSOR>;');
    });

    it('should use custom model when configured', async () => {
      setSetting(db, 'ai_provider', 'openrouter');
      setSetting(db, 'openrouter_api_key', 'or-test-key');
      setSetting(db, 'openrouter_model', 'anthropic/claude-3-haiku');

      mockFetchOk({
        choices: [{ message: { content: 'custom()' } }],
      });

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'x', suffix: '' });

      expect(res.status).toBe(200);

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.model).toBe('anthropic/claude-3-haiku');
    });
  });

  // Codestral
  describe('Codestral provider', () => {
    it('should return 400 when API key is not configured', async () => {
      setSetting(db, 'ai_provider', 'codestral');

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const ', suffix: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Codestral API key not configured');
    });

    it('should call Codestral FIM endpoint with prefix and suffix directly', async () => {
      setSetting(db, 'ai_provider', 'codestral');
      setSetting(db, 'codestral_api_key', 'cs-test-key');

      mockFetchOk({
        choices: [{ message: { content: 'fimCompletion()' } }],
      });

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'function hello() { ', suffix: ' }' });

      expect(res.status).toBe(200);
      expect(res.body.data.completion).toBe('fimCompletion()');

      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe('https://codestral.mistral.ai/v1/fim/completions');
      expect(fetchCall[1].headers['Authorization']).toBe('Bearer cs-test-key');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('codestral-latest');
      expect(body.prompt).toBe('function hello() { ');
      expect(body.suffix).toBe(' }');
      expect(body.max_tokens).toBe(256);
      // Codestral FIM should NOT have messages or <CURSOR> format
      expect(body.messages).toBeUndefined();
    });

    it('should return 502 on Codestral API error', async () => {
      setSetting(db, 'ai_provider', 'codestral');
      setSetting(db, 'codestral_api_key', 'cs-test-key');

      mockFetchError(401, 'Unauthorized');

      const res = await request(app)
        .post('/v1/ai/complete')
        .send({ prefix: 'const ', suffix: '' });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('Codestral API error (401)');
    });
  });
});
