// fixtures: hand-written from https://docs.anthropic.com/en/api/messages-streaming,
// https://ai.google.dev/api/generate-content, https://github.com/ollama/ollama/blob/main/docs/api.md,
// https://openrouter.ai/docs/api-reference/overview and https://docs.mistral.ai/api/#tag/fim
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import http from 'http';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { completeHandler, registerAiCompleteEndpoints } from './ai-complete';
import { createTestDb } from '../test-utils/create-test-db';
import { stubFetch, jsonResponse, textResponse, okStream, callHeader } from '../services/ai/test-helpers';
import { AiModelRouter, RateLimitCache } from '../services/ai-model-router';
import { AuthError, ConnectionError, QuotaExhaustedError } from '../services/ai/errors';
import { getRecentLogs } from '../logs';

const { settings } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>, router: AiModelRouter) {
  clearEndpoints();
  registerAiCompleteEndpoints(db as any, router);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

function setSetting(db: BetterSQLite3Database<typeof schema>, key: string, value: string) {
  db.insert(settings).values({ key, value }).run();
}

/** An Express-like res with an event emitter, recording every write, so close-then-write can be asserted. */
function fakeRes() {
  const writes: any[] = [];
  const res: any = new EventEmitter();
  res.writableEnded = false;
  res.headersSent = false;
  res.status = (c: number) => { writes.push(['status', c]); return res; };
  res.json = (b: any) => { writes.push(['json', b]); res.writableEnded = true; res.headersSent = true; return res; };
  return { res, writes };
}

const errorLogsFromCompletion = () => getRecentLogs().filter((l) => l.system === 'ai-complete' && l.severity === 'error');

describe('AI Complete API Endpoint', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function emptyRouter() {
    return new AiModelRouter(db as any, new RateLimitCache(), { providerFactory: (() => { throw new Error('no provider expected'); }) as any });
  }

  /** A real router over the test db with one model per name in the named tier, each backed by `impl`. */
  function routerWith(tiers: { low?: string[]; high?: string[] }, impl: { complete: (req: any) => Promise<string> }) {
    const now = new Date();
    const providerId = Number(db.insert(schema.aiProviders).values({ name: 'P', type: 'openrouter', apiKey: 'k', createdAt: now, updatedAt: now }).run().lastInsertRowid);
    // ai_tiers.name is UNIQUE: reuse a tier that an earlier routerWith() call in the same test already created.
    const tier = (name: string, sortOrder: number) =>
      db.select().from(schema.aiTiers).where(eq(schema.aiTiers.name, name)).get()?.id
      ?? Number(db.insert(schema.aiTiers).values({ name, sortOrder, isHardcoded: true, createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
    const highId = tier('High', 0), lowId = tier('Low', 1);
    let priority = 0;
    for (const [names, tierId] of [[tiers.high ?? [], highId], [tiers.low ?? [], lowId]] as const) {
      for (const name of names) db.insert(schema.aiModels).values({ name, provider: 'openrouter', providerId, model: name, priority: priority++, tierId, createdAt: now, updatedAt: now }).run();
    }
    return new AiModelRouter(db as any, new RateLimitCache(), { providerFactory: () => ({ name: 'x', createStreamingRequest: async function* () {}, complete: impl.complete }) as any });
  }

  /** A completion that never settles on its own: it records the start and rejects only when its signal aborts. */
  function hangingComplete() {
    let started!: () => void; const startedP = new Promise<void>((r) => { started = r; });
    let aborted!: (v: boolean) => void; const abortedP = new Promise<boolean>((r) => { aborted = r; });
    const complete = (req: any) => new Promise<string>((_ok, reject) => {
      started();
      req.signal.addEventListener('abort', () => { aborted(true); reject(new DOMException('aborted', 'AbortError')); });
    });
    return { complete, startedP, abortedP };
  }

  describe('router path', () => {
    it('uses Low tier models, passes the system prompt and cursor split, and returns the completion', async () => {
      const calls: any[] = [];
      const router = routerWith({ low: ['Low-A'] }, { complete: async (req) => { calls.push(req); return 'inserted()'; } });
      const res = await request(createApp(db, router)).post('/v1/ai/complete').send({ prefix: 'foo(', suffix: ')' });
      expect(res.status).toBe(200);
      expect(res.body.data.completion).toBe('inserted()');
      expect(calls[0]).toMatchObject({ prefix: 'foo(', suffix: ')', maxOutputTokens: 256, temperature: 0, stopSequences: ['\n\n\n'] });
      expect(calls[0].systemPrompt).toContain('<CURSOR>');
      expect(calls[0].systemPrompt).toContain('code completion engine');
    });

    it('a missing prefix or suffix is sent as an empty string', async () => {
      const calls: any[] = [];
      const router = routerWith({ low: ['L'] }, { complete: async (req) => { calls.push(req); return 'x'; } });
      await request(createApp(db, router)).post('/v1/ai/complete').send({ suffix: ')' });
      expect(calls[0]).toMatchObject({ prefix: '', suffix: ')' });
    });

    it('never uses High-tier models for completion', async () => {
      const router = routerWith({ high: ['H'] }, { complete: async () => 'x' });
      const res = await request(createApp(db, router)).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No AI provider configured');
    });

    it('Low tier models win over legacy settings when both exist', async () => {
      setSetting(db, 'ai_provider', 'anthropic'); setSetting(db, 'anthropic_api_key', 'sk-test-placeholder');
      const stub = stubFetch(() => okStream('anthropic'));
      const router = routerWith({ low: ['L'] }, { complete: async () => 'from router' });
      const res = await request(createApp(db, router)).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(res.body.data.completion).toBe('from router');
      expect(stub.calls).toHaveLength(0);
    });

    it('maps a provider error to 502 with the message verbatim (a lone failing model surfaces as AllModelsFailedError carrying the reason)', async () => {
      const router = routerWith({ low: ['L'] }, { complete: async () => { throw new ConnectionError('OpenRouter request failed: refused'); } });
      const res = await request(createApp(db, router)).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/^All AI models are rate-limited or unavailable:/);
      expect(res.body.error).toContain('OpenRouter request failed: refused');
    });

    it.each([
      ['an auth failure', () => new AuthError('OpenRouter API error (401): invalid key')],
      ['a quota failure', () => new QuotaExhaustedError('OpenRouter API error (402): insufficient credits')],
    ])('%s is a 502 that still names the reason', async (_label, make) => {
      const err = make();
      const router = routerWith({ low: ['A'] }, { complete: async () => { throw err; } });
      const res = await request(createApp(db, router)).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(res.status).toBe(502);
      expect(res.body.error).toContain(`A: ${err.message}`);
    });

    it('an auth failure cools down the other models on the same key rather than retrying them', async () => {
      let calls = 0;
      const router = routerWith({ low: ['A', 'B'] }, { complete: async () => { calls++; throw new AuthError('OpenRouter API error (401): invalid key'); } });
      const res = await request(createApp(db, router)).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(res.status).toBe(502);
      expect(calls).toBe(1);
      expect(res.body.error).toContain('B: in cooldown');
    });

    it('falls back to the next Low model on a connection failure', async () => {
      let n = 0;
      const router = routerWith({ low: ['A', 'B'] }, { complete: async () => {
        if (n++ === 0) throw new ConnectionError('refused');
        return 'second';
      } });
      const res = await request(createApp(db, router)).post('/v1/ai/complete').send({ prefix: 'a' });
      expect([res.status, res.body.data?.completion]).toEqual([200, 'second']);
    });

    it('maps a non-provider error to a 500 with a generic message that leaks nothing', async () => {
      const router = routerWith({ low: ['L'] }, { complete: async () => { throw new Error('boom sk-test-placeholder'); } });
      const res = await request(createApp(db, router)).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'Inline completion failed' });
    });

    it('aborts the upstream call when the client disconnects', async () => {
      const h = hangingComplete();
      const router = routerWith({ low: ['L'] }, { complete: h.complete });
      const server = createApp(db, router).listen(0, '127.0.0.1');
      await new Promise<void>((r) => server.once('listening', () => r()));
      const { port } = server.address() as AddressInfo;
      const client = http.request({ host: '127.0.0.1', port, path: '/v1/ai/complete', method: 'POST', headers: { 'content-type': 'application/json' } });
      client.on('error', () => undefined);
      client.end(JSON.stringify({ prefix: 'a' }));
      await h.startedP;
      client.destroy();
      expect(await Promise.race([h.abortedP, new Promise<boolean>((r) => setTimeout(() => r(false), 3000))])).toBe(true);
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('writes nothing and logs no error once the client has gone', async () => {
      const h = hangingComplete();
      const router = routerWith({ low: ['L'] }, { complete: h.complete });
      const { res, writes } = fakeRes();
      const before = errorLogsFromCompletion().length;
      const done = completeHandler(db as any, router)({ body: { prefix: 'a' } }, res);
      await h.startedP;
      res.emit('close');
      await done;
      expect(await h.abortedP).toBe(true);
      expect(writes).toEqual([]);
      expect(errorLogsFromCompletion().length).toBe(before);
    });

    it('a completion that resolves after the client has gone is not written', async () => {
      let finish!: (s: string) => void;
      let started!: () => void; const startedP = new Promise<void>((r) => { started = r; });
      // A router double that ignores the signal, as a legacy provider that drains a stream and returns its
      // partial text would: the handler itself must not write after the close.
      const router = { completeText: () => new Promise<string>((ok) => { started(); finish = ok; }) } as unknown as AiModelRouter;
      const { res, writes } = fakeRes();
      const done = completeHandler(db as any, router)({ body: { prefix: 'a' } }, res);
      await startedP;
      res.emit('close');
      finish('late');
      await done;
      expect(writes).toEqual([]);
    });

    it('a close after the response finished does not abort anything', async () => {
      const signals: AbortSignal[] = [];
      const router = routerWith({ low: ['L'] }, { complete: async (req) => { signals.push(req.signal); return 'ok'; } });
      const { res, writes } = fakeRes();
      await completeHandler(db as any, router)({ body: { prefix: 'a' } }, res);
      res.emit('close');
      expect(writes).toEqual([['json', { success: true, data: { completion: 'ok' } }]]);
      expect(signals[0].aborted).toBe(false);
    });

    it('works over transports whose res has no .on (the WebSocket REST adapter builds a minimal res)', async () => {
      const router = routerWith({ low: ['L'] }, { complete: async () => 'ok' });
      const out: any[] = [];
      const res = { status(c: number) { out.push(['status', c]); return this; }, json(b: any) { out.push(['json', b]); return this; } };
      await completeHandler(db as any, router)({ body: { prefix: 'a' } }, res);
      expect(out).toEqual([['json', { success: true, data: { completion: 'ok' } }]]);
    });

    it('rejects an empty body', async () => {
      const res = await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('prefix or suffix is required');
    });
  });

  describe('legacy settings path (deprecated)', () => {
    const CASES = [
      { type: 'anthropic', keys: { anthropic_api_key: 'sk-test-placeholder' }, resp: () => okStream('anthropic'),
        url: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-4-5-20251001', name: 'Anthropic' },
      { type: 'gemini', keys: { gemini_api_key: 'sk-test-placeholder' }, resp: () => okStream('gemini'),
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', model: undefined, name: 'Gemini' },
      { type: 'ollama', keys: {}, resp: () => okStream('ollama'),
        url: 'http://localhost:11434/api/chat', model: 'qwen2.5-coder:1.5b', name: 'Ollama' },
      { type: 'openrouter', keys: { openrouter_api_key: 'sk-test-placeholder' }, resp: () => okStream('openai-chat'),
        url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/auto', name: 'OpenRouter' },
      { type: 'codestral', keys: { codestral_api_key: 'sk-test-placeholder' }, resp: () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        url: 'https://codestral.mistral.ai/v1/fim/completions', model: 'codestral-latest', name: 'Codestral' },
    ];

    describe.each(CASES)('$type', (c) => {
      const configure = () => { setSetting(db, 'ai_provider', c.type); for (const [k, v] of Object.entries(c.keys)) setSetting(db, k, v); };

      it('completes through the registry with the legacy model and host', async () => {
        configure();
        const stub = stubFetch(c.resp);
        const res = await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a', suffix: 'b' });
        expect(res.body).toEqual({ success: true, data: { completion: 'ok' } });
        expect(stub.calls[0].url).toBe(c.url);
        if (c.model) expect(stub.calls[0].body.model).toBe(c.model);
      });

      it('returns 502 with the provider message on an HTTP error', async () => {
        configure();
        stubFetch(() => textResponse('{"error":{"message":"overloaded"}}', 529));
        const res = await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(new RegExp(`${c.name} API error \\(529\\)`));
      });

      if (Object.keys(c.keys).length > 0) {
        it('returns 400 when the key setting is missing', async () => {
          setSetting(db, 'ai_provider', c.type);
          const res = await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
          expect(res.status).toBe(400);
          expect(res.body.error).toBe(`${c.name} API key not configured`);
        });
      }
    });

    it('anthropic: no temperature, stop sequence and 256-token cap, no cache_control, cursor split in the user message', async () => {
      setSetting(db, 'ai_provider', 'anthropic'); setSetting(db, 'anthropic_api_key', 'sk-test-placeholder');
      const stub = stubFetch(() => okStream('anthropic'));
      await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'await ', suffix: ';' });
      expect(stub.calls[0].body).toMatchObject({ max_tokens: 256, stop_sequences: ['\n\n\n'] });
      expect(stub.calls[0].body.temperature).toBeUndefined();
      expect(stub.calls[0].body.cache_control).toBeUndefined();
      expect(JSON.stringify(stub.calls[0].body.messages)).toContain('await <CURSOR>;');
      expect(callHeader(stub.calls[0], 'x-api-key')).toBe('sk-test-placeholder');
    });

    it('gemini: the key travels in a header, never in the URL, and the system prompt is sent', async () => {
      setSetting(db, 'ai_provider', 'gemini'); setSetting(db, 'gemini_api_key', 'sk-test-placeholder');
      const stub = stubFetch(() => okStream('gemini'));
      await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(stub.calls[0].url).not.toContain('key=');
      expect(callHeader(stub.calls[0], 'x-goog-api-key')).toBe('sk-test-placeholder');
      expect(JSON.stringify(stub.calls[0].body.systemInstruction)).toContain('code completion engine');
    });

    it('codestral: FIM sends prefix and suffix directly, with no chat messages', async () => {
      setSetting(db, 'ai_provider', 'codestral'); setSetting(db, 'codestral_api_key', 'sk-test-placeholder');
      const stub = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'fim()' } }] }));
      await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'function hello() { ', suffix: ' }' });
      expect(callHeader(stub.calls[0], 'Authorization')).toBe('Bearer sk-test-placeholder');
      expect(stub.calls[0].body).toMatchObject({ prompt: 'function hello() { ', suffix: ' }', max_tokens: 256 });
      expect(stub.calls[0].body.messages).toBeUndefined();
    });

    it('ollama honours ollama_base_url and ollama_model; openrouter honours openrouter_model', async () => {
      setSetting(db, 'ai_provider', 'ollama'); setSetting(db, 'ollama_base_url', 'http://10.0.0.5:11434'); setSetting(db, 'ollama_model', 'mine');
      let stub = stubFetch(() => okStream('ollama'));
      await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(stub.calls[0].url).toBe('http://10.0.0.5:11434/api/chat');
      expect(stub.calls[0].body.model).toBe('mine');
      db.delete(schema.settings).run();
      setSetting(db, 'ai_provider', 'openrouter'); setSetting(db, 'openrouter_api_key', 'sk-test-placeholder'); setSetting(db, 'openrouter_model', 'vendor/model');
      stub = stubFetch(() => okStream('openai-chat'));
      await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(stub.calls[0].body.model).toBe('vendor/model');
    });

    it('an empty completion is a 200 with an empty string', async () => {
      setSetting(db, 'ai_provider', 'codestral'); setSetting(db, 'codestral_api_key', 'sk-test-placeholder');
      stubFetch(() => jsonResponse({ choices: [] }));
      const res = await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
      expect([res.status, res.body.data?.completion]).toEqual([200, '']);
    });

    it('unknown ai_provider -> 400; nothing configured -> 400', async () => {
      setSetting(db, 'ai_provider', 'nope');
      const a = await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
      expect([a.status, a.body.error]).toEqual([400, 'Unknown AI provider: nope']);
      db.delete(schema.settings).run();
      const b = await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
      expect([b.status, b.body.error]).toEqual([400, 'No AI provider configured']);
    });

    it('a provider type that legacy settings never supported is unknown there', async () => {
      setSetting(db, 'ai_provider', 'claude-cli');
      const res = await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
      expect([res.status, res.body.error]).toEqual([400, 'Unknown AI provider: claude-cli']);
    });

    it('a network failure is a 502 with a readable message (was a 500)', async () => {
      setSetting(db, 'ai_provider', 'anthropic'); setSetting(db, 'anthropic_api_key', 'sk-test-placeholder');
      stubFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') }); });
      const res = await request(createApp(db, emptyRouter())).post('/v1/ai/complete').send({ prefix: 'a' });
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Anthropic/);
    });

    it('a client that disconnects mid-request gets nothing written and no error logged', async () => {
      setSetting(db, 'ai_provider', 'anthropic'); setSetting(db, 'anthropic_api_key', 'sk-test-placeholder');
      let started!: () => void; const startedP = new Promise<void>((r) => { started = r; });
      // Never answers: the stub rejects with the abort reason once the signal fires, like real fetch.
      const stub = stubFetch(() => { started(); return new Promise<Response>(() => undefined); });
      const { res, writes } = fakeRes();
      const before = errorLogsFromCompletion().length;
      const done = completeHandler(db as any, emptyRouter())({ body: { prefix: 'a' } }, res);
      await startedP;
      res.emit('close');
      await done;
      expect((stub.calls[0].init.signal as AbortSignal).aborted).toBe(true);
      expect(writes).toEqual([]);
      expect(errorLogsFromCompletion().length).toBe(before);
    });
  });
});
