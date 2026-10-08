// fixtures: hand-written from https://docs.anthropic.com/en/api/messages-streaming,
// https://ai.google.dev/api/generate-content, https://github.com/ollama/ollama/blob/main/docs/api.md
// and https://platform.openai.com/docs/api-reference/chat-streaming
//
// Every http entry in the catalog runs through the same cases with a stubbed fetch. The expected URL and
// auth header come from a hard-coded golden table, not from the catalog, so the suite is not circular.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AI_PROVIDER_CATALOG } from '../../../../shared/lib/ai-provider-catalog';
import { createProvider } from '../registry';
import { __resetOpenAiChatMemo } from '../dialects/openai-chat';
import { stubFetch, sseResponse, ndjsonResponse, textResponse, okStream, collect, callHeader } from '../test-helpers';
import { AuthError, QuotaExhaustedError, RateLimitError, OverloadedError, ConnectionError, AiProviderError } from '../errors';

afterEach(() => vi.unstubAllGlobals());

// Hard-coded expectations. Adding a catalog entry without a row here fails the first test.
const GOLDEN: Record<string, { baseUrl?: string; model?: string; url: string; auth: [string, string] | null }> = {
  anthropic: { url: 'https://api.anthropic.com/v1/messages', auth: ['x-api-key', 'sk-test-placeholder'] },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', auth: ['x-goog-api-key', 'sk-test-placeholder'] },
  ollama: { url: 'http://localhost:11434/api/chat', auth: null },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', auth: ['authorization', 'Bearer sk-test-placeholder'] },
  codestral: { url: 'https://api.mistral.ai/v1/chat/completions', auth: ['authorization', 'Bearer sk-test-placeholder'] },
  mistral: { model: 'mistral-small-latest', url: 'https://api.mistral.ai/v1/chat/completions', auth: ['authorization', 'Bearer sk-test-placeholder'] },
  openai: { model: 'test-model', url: 'https://api.openai.com/v1/chat/completions', auth: ['authorization', 'Bearer sk-test-placeholder'] },
  'openai-compatible': { baseUrl: 'http://127.0.0.1:1234', model: 'test-model', url: 'http://127.0.0.1:1234/v1/chat/completions', auth: ['authorization', 'Bearer sk-test-placeholder'] },
};

const http = AI_PROVIDER_CATALOG.filter((p) => p.kind === 'http');

const KIND = { 'anthropic-messages': 'anthropic', 'gemini-generate': 'gemini', 'ollama-chat': 'ollama', 'openai-chat': 'openai-chat' } as const;
const okResponse = (dialect: keyof typeof KIND): Response => okStream(KIND[dialect]);

// A stream that carries one complete tool call get_apps({"q":"a"}), per wire format.
function toolCallStream(dialect: keyof typeof KIND): Response {
  switch (dialect) {
    case 'anthropic-messages': return sseResponse([
      { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3 } } }) },
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'get_apps' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q":"a"}' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop' }) },
      { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }) },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ]);
    case 'gemini-generate': return sseResponse([{ data: JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_apps', args: { q: 'a' } } }] }, finishReason: 'STOP' }] }) }]);
    case 'ollama-chat': return ndjsonResponse([{ message: { tool_calls: [{ function: { name: 'get_apps', arguments: { q: 'a' } } }] } }, { done: true }]);
    default: return sseResponse([
      { data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_apps', arguments: '{"q":"a"}' } }] }, finish_reason: 'tool_calls' }] }) },
      { data: '[DONE]' },
    ]);
  }
}

// A 200 stream that carries an error payload with the given message, per wire format.
function errorStream(dialect: keyof typeof KIND, message = 'boom'): Response {
  switch (dialect) {
    case 'anthropic-messages': return sseResponse([{ event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'api_error', message } }) }]);
    case 'gemini-generate': return sseResponse([{ data: JSON.stringify({ error: { code: 500, message } }) }]);
    case 'ollama-chat': return ndjsonResponse([{ error: message }]);
    default: return sseResponse([{ data: JSON.stringify({ error: { message } }) }]);
  }
}

const msgs = [{ role: 'user' as const, content: 'hi' }];
const make = (id: string) => {
  const g = GOLDEN[id];
  return createProvider(id, { apiKey: 'sk-test-placeholder', baseUrl: g.baseUrl, model: g.model });
};

// The stream_options retry is wire-level behaviour of the openai-chat family, so it is checked once here.
describe('conformance: stream_options retry (openai-compatible)', () => {
  it('retries once without stream_options after a rejection and remembers it per base URL', async () => {
    __resetOpenAiChatMemo();
    const stub = stubFetch((call, n) => (n === 0 && call.body.stream_options ? textResponse('Unrecognized request argument: stream_options', 400) : okStream('openai-chat')));
    const make2 = () => createProvider('openai-compatible', { baseUrl: 'http://127.0.0.1:4321', model: 'm' });
    await collect(make2().createStreamingRequest(msgs, 's', []));
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0].body.stream_options).toEqual({ include_usage: true });
    expect(stub.calls[1].body.stream_options).toBeUndefined();
    await collect(make2().createStreamingRequest(msgs, 's', []));     // later request skips the first attempt
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[2].body.stream_options).toBeUndefined();
    __resetOpenAiChatMemo();
  });
});

it('every http catalog entry has a golden row', () => {
  expect(http.map((p) => p.id).sort()).toEqual(Object.keys(GOLDEN).sort());
});

describe.each(http.map((p) => [p.id, p.dialect as keyof typeof KIND] as const))('conformance: %s', (id, dialect) => {
  it('sends the expected URL and auth header, and redirect: error', async () => {
    const stub = stubFetch(() => okResponse(dialect));
    await collect(make(id).createStreamingRequest(msgs, 'sys', []));
    const g = GOLDEN[id];
    expect(stub.calls[0].url).toBe(g.url);
    if (g.auth) expect(callHeader(stub.calls[0], g.auth[0])).toBe(g.auth[1]);
    else expect(callHeader(stub.calls[0], 'authorization')).toBeUndefined();
    expect(stub.calls[0].init.redirect).toBe('error');
    expect(stub.calls[0].url).not.toContain('sk-test-placeholder');
  });

  it('yields text then usage in the normalised shape', async () => {
    stubFetch(() => okResponse(dialect));
    const events = await collect(make(id).createStreamingRequest(msgs, 'sys', []));
    // Anthropic emits usage first (message_start), so look the text event up instead of assuming events[0].
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'ok' }]);
    const usage = events.filter((e) => e.type === 'usage') as any[];
    // Usage events are additive deltas: every dialect must sum to exactly 3 in and 2 out.
    expect(usage.reduce((n, e) => n + e.inputTokens, 0)).toBe(3);
    expect(usage.reduce((n, e) => n + e.outputTokens, 0)).toBe(2);
  });

  it.each([
    [401, '{"error":{"message":"nope"}}', AuthError],
    [402, 'pay up', QuotaExhaustedError],
    [400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}', QuotaExhaustedError],
    [429, '{"error":{"type":"insufficient_quota","message":"x"}}', QuotaExhaustedError],
    [429, 'slow', RateLimitError],
    [529, 'busy', OverloadedError],
  ])('maps HTTP %i to the taxonomy', async (status, body, Klass) => {
    stubFetch(() => textResponse(body, status));
    await expect(collect(make(id).createStreamingRequest(msgs, 'sys', []))).rejects.toBeInstanceOf(Klass as any);
  });

  it('honours a custom base URL (every http entry, not just openai-compatible)', async () => {
    const stub = stubFetch(() => okResponse(dialect));
    const d = http.find((p) => p.id === id)!;
    const provider = createProvider(id, { apiKey: 'sk-test-placeholder', baseUrl: 'https://proxy.example.test', model: GOLDEN[id].model ?? 'test-model' });
    await collect(provider.createStreamingRequest(msgs, 'sys', []));
    expect(stub.calls[0].url.startsWith(`https://proxy.example.test${(d as any).defaultPath ?? ''}/`)).toBe(true);
  });

  it('parses a complete tool call into one tool_use event', async () => {
    stubFetch(() => toolCallStream(dialect));
    const events = await collect(make(id).createStreamingRequest(msgs, 'sys', [{ name: 'get_apps', description: 'd', inputSchema: { type: 'object', properties: {} }, context: [] } as any]));
    const calls = events.filter((e) => e.type === 'tool_use') as any[];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'get_apps', input: { q: 'a' } });
    expect(typeof calls[0].id).toBe('string');
    expect(calls[0].id.length).toBeGreaterThan(0);
  });

  it('turns an error payload inside a 200 stream into a typed error', async () => {
    stubFetch(() => errorStream(dialect));
    const err: any = await collect(make(id).createStreamingRequest(msgs, 'sys', [])).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.message).toMatch(/stream error: boom/);
  });

  it('in-stream error messages are redacted and capped: the key never leaks and upstream text is bounded', async () => {
    stubFetch(() => errorStream(dialect, `bad key sk-test-placeholder ${'x'.repeat(2000)}`));
    const err: any = await collect(make(id).createStreamingRequest(msgs, 'sys', [])).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.message).not.toContain('sk-test-placeholder');
    expect(err.message.length).toBeLessThan(700);
  });

  it('never leaks the key into an error message', async () => {
    stubFetch(() => textResponse('rejected sk-test-placeholder', 500));
    const err: any = await collect(make(id).createStreamingRequest(msgs, 'sys', [])).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.message).not.toContain('sk-test-placeholder');
  });

  it('maps a network failure to ConnectionError', async () => {
    stubFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') }); });
    await expect(collect(make(id).createStreamingRequest(msgs, 'sys', []))).rejects.toBeInstanceOf(ConnectionError);
  });

  it('stops without sending when the signal is already aborted', async () => {
    const stub = stubFetch(() => okResponse(dialect));
    const ac = new AbortController(); ac.abort();
    await expect(collect(make(id).createStreamingRequest(msgs, 'sys', [], { signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(stub.calls).toHaveLength(0);
  });
});
