// fixtures: hand-written from https://docs.anthropic.com/en/api/models-list,
// https://ai.google.dev/api/models#method:-models.list and https://github.com/ollama/ollama/blob/main/docs/api.md
import { describe, it, expect, afterEach, vi } from 'vitest';
import { listModels, testProvider, testModel } from '../provider-ops';
import { stubFetch, jsonResponse, textResponse, sseResponse, callHeader } from '../test-helpers';
import { EventEmitter } from 'events';
import { ConnectionError, isFallbackEligible } from '../errors';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../claude-cli-provider', () => ({ ClaudeCliProvider: { getVersion: vi.fn(), testToolUse: vi.fn() } }));
import { spawn } from 'child_process';
import { ClaudeCliProvider } from '../../claude-cli-provider';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

/** A body that sends a first fragment and then stalls; it errors the way fetch does when the request is aborted. */
function stalledBody(signal: AbortSignal | null | undefined, first: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(first));
      signal?.addEventListener('abort', () => c.error(signal.reason), { once: true });
    },
  });
}
const never = () => new Promise<Response>(() => { /* the server never answers */ });

describe('timeouts (15 s per request)', () => {
  it('a listing whose 200 body stalls reads as a timeout, not "not JSON"', async () => {
    vi.useFakeTimers();
    stubFetch((call) => new Response(stalledBody(call.init.signal, '{"data":['), { status: 200 }));
    const p = listModels(row('openrouter')).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await p;
    expect(err).toMatchObject({ name: 'ConnectionError', message: 'OpenRouter did not respond within 15s' });
  });
  it('a timeout keeps the underlying error as a redacted cause', async () => {
    vi.useFakeTimers();
    // The body stalls and then fails when the timeout aborts it; that error never passes through the fetch wrapper.
    stubFetch((call) => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"data":['));
        (call.init.signal as AbortSignal).addEventListener('abort', () => c.error(new Error('socket reset for sk-test-placeholder')), { once: true });
      },
    }), { status: 200 }));
    const p = listModels(row('openrouter')).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await p;
    expect(err.message).toBe('OpenRouter did not respond within 15s');
    expect(err.cause.message).toBe('socket reset for ***');
  });
  it('a listing whose connection drops mid-body is a ConnectionError, not a raw TypeError', async () => {
    stubFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('{"data":[')); },
      pull(c) { c.error(new TypeError('terminated')); },
    }), { status: 200 }));
    const err = await listModels(row('openrouter')).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toBe('OpenRouter closed the connection while sending the response');
    expect(isFallbackEligible(err)).toBe(true);
  });
  it('a listing whose server never answers reads as a timeout', async () => {
    vi.useFakeTimers();
    stubFetch(never);
    const p = listModels(row('openai-compatible', { baseUrl: 'http://127.0.0.1:1234' })).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await p).message).toBe('OpenAI-compatible did not respond within 15s');
  });
  it('a failed listing with a stalled error body is classified after the bounded read, before the timeout', async () => {
    vi.useFakeTimers();
    stubFetch((call) => new Response(stalledBody(call.init.signal, 'half a body'), { status: 500 }));
    const p = listModels(row('ollama', { apiKey: null })).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toMatchObject({ name: 'AiProviderError', message: 'Ollama API error (500): half a body' });
  });
  it('the connection test reports a timeout in words', async () => {
    vi.useFakeTimers();
    stubFetch(never);
    const p = testProvider(row('openrouter'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p).toEqual({ success: false, error: 'OpenRouter did not respond within 15s' });
  });
  it('the model test reports a timeout in words', async () => {
    vi.useFakeTimers();
    stubFetch(never);
    const p = testModel(row('anthropic'), { model: 'claude-haiku-5-5' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p).toEqual({ success: false, error: 'Anthropic did not respond within 15s' });
  });
  it('the CLI version check gives up after 15 s and kills the process', async () => {
    vi.useFakeTimers();
    const child: any = new EventEmitter();
    child.kill = vi.fn();
    (spawn as any).mockImplementationOnce(() => child);
    const p = testProvider(row('claude-cli', { apiKey: null }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p).toEqual({ success: false, error: 'Claude CLI not found or not working' });
    expect(child.kill).toHaveBeenCalled();
  });
});

describe('whitespace-only values', () => {
  it('a model of only whitespace falls back to the default, or fails clearly without one', async () => {
    const stub = stubFetch(() => sseResponse([{ data: '[DONE]' }]));
    expect(await testModel(row('openrouter'), { model: '  ' })).toEqual({ success: true, model: 'openrouter/auto' });
    expect(stub.calls[0].body.model).toBe('openrouter/auto');
    expect(await testModel(row('openai'), { model: ' \n' })).toMatchObject({ success: false, error: expect.stringMatching(/No model selected/) });
    expect(stub.calls).toHaveLength(1);
  });
  it('a configured model is trimmed before it is sent and reported', async () => {
    const stub = stubFetch(() => sseResponse([{ data: '[DONE]' }]));
    expect(await testModel(row('openrouter'), { model: ' vendor/m ' })).toEqual({ success: true, model: 'vendor/m' });
    expect(stub.calls[0].body.model).toBe('vendor/m');
  });
  it('a key of only whitespace is missing for the connection and model tests', async () => {
    const stub = stubFetch(() => jsonResponse({}));
    expect(await testProvider(row('openrouter', { apiKey: '  ' }))).toEqual({ success: false, error: 'No OpenRouter API key configured' });
    expect(await testModel(row('openrouter', { apiKey: '\n' }), { model: 'm' })).toEqual({ success: false, error: 'No OpenRouter API key configured' });
    expect(stub.calls).toHaveLength(0);
  });
  it('a CLI token of only whitespace is not passed to the CLI', async () => {
    (spawn as any).mockImplementationOnce(() => fakeChild({ code: 0 }));
    await testProvider(row('claude-cli', { apiKey: '  ' }));
    expect((spawn as any).mock.calls[0][2]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    (ClaudeCliProvider.getVersion as any).mockResolvedValueOnce('1.0.0');
    (ClaudeCliProvider.testToolUse as any).mockResolvedValueOnce({ ok: true });
    await testModel(row('claude-cli', { apiKey: ' ' }), { model: ' ' });
    expect((ClaudeCliProvider.getVersion as any).mock.calls[0][0]).toBeUndefined();
    expect((ClaudeCliProvider.testToolUse as any).mock.calls[0]).toEqual([undefined, 'sonnet']);
  });
});

function fakeChild(outcome: { code: number } | { error: true }) {
  const child: any = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => ('error' in outcome ? child.emit('error', new Error('ENOENT')) : child.emit('close', outcome.code)), 0);
  return child;
}
const row = (type: string, over: Partial<{ apiKey: string | null; baseUrl: string | null }> = {}) => ({ type, apiKey: 'sk-test-placeholder', baseUrl: null, ...over });

describe('listModels', () => {
  it('follows anthropic pagination and caps at 10 pages', async () => {
    let n = 0;
    const stub = stubFetch(() => jsonResponse({ data: [{ id: `m${n++}` }], has_more: true, last_id: `m${n}` }));
    const models = await listModels(row('anthropic'));
    expect(stub.calls).toHaveLength(10);
    expect(models).toHaveLength(10);
    expect(stub.calls[1].url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=m1');
    expect(stub.calls[0].init.method).toBe('GET');
    expect(stub.calls[0].init.body).toBeUndefined();
    expect(stub.calls[0].init.redirect).toBe('error');
  });
  it('stops when there are no more pages, and falls back to id for name', async () => {
    const stub = stubFetch(() => jsonResponse({ data: [{ id: 'a' }, { id: 'b', name: 'Bee' }] }));
    expect(await listModels(row('openrouter'))).toEqual([{ id: 'a', name: 'a' }, { id: 'b', name: 'Bee' }]);
    expect(stub.calls).toHaveLength(1);
    expect(callHeader(stub.calls[0], 'authorization')).toBe('Bearer sk-test-placeholder');
  });
  it('filters Gemini models and strips the prefix; falls back to id for name', async () => {
    const stub = stubFetch(() => jsonResponse({ models: [{ name: 'models/g1', supportedGenerationMethods: ['generateContent'] }, { name: 'models/e', supportedGenerationMethods: ['embedContent'] }] }));
    expect(await listModels(row('gemini'))).toEqual([{ id: 'g1', name: 'g1' }]);
    expect(stub.calls[0].url).not.toContain('sk-test-placeholder');
    expect(callHeader(stub.calls[0], 'x-goog-api-key')).toBe('sk-test-placeholder');
  });
  it('returns the static list for claude-cli without any request', async () => {
    const stub = stubFetch(() => jsonResponse({}));
    const m = await listModels(row('claude-cli', { apiKey: null }));
    expect(m.map((x) => x.id)).toContain('sonnet');
    expect(stub.calls).toHaveLength(0);
  });
  it('an unknown type lists nothing', async () => {
    expect(await listModels(row('nope'))).toEqual([]);
  });
  it('requires a key when auth is required (a key of only whitespace counts as missing)', async () => {
    const stub = stubFetch(() => jsonResponse({}));
    await expect(listModels(row('anthropic', { apiKey: null }))).rejects.toThrow('No Anthropic API key configured');
    await expect(listModels(row('anthropic', { apiKey: '  ' }))).rejects.toThrow('No Anthropic API key configured');
    expect(stub.calls).toHaveLength(0);
  });
  it('classifies a failed listing (a bad key reads as a typed 401 with the provider hint)', async () => {
    stubFetch(() => textResponse('{"error":{"message":"bad key"}}', 401));
    await expect(listModels(row('codestral'))).rejects.toMatchObject({ name: 'AuthError', message: expect.stringContaining('Hint:') });
  });
  it('a failed listing never leaks the key', async () => {
    stubFetch(() => textResponse('denied for sk-test-placeholder', 500));
    const err: any = await listModels(row('openrouter')).catch((e) => e);
    expect(err.message).toContain('OpenRouter API error (500)');
    expect(err.message).not.toContain('sk-test-placeholder');
  });
  it('a 200 that is not JSON (a login page) is an AiProviderError, not a SyntaxError', async () => {
    stubFetch(() => textResponse('<html>sign in</html>', 200));
    await expect(listModels(row('openai-compatible', { baseUrl: 'http://127.0.0.1:1234' }))).rejects.toThrow(/not JSON/);
  });
  it('an invalid stored Base URL fails clearly before any request', async () => {
    const stub = stubFetch(() => jsonResponse({}));
    await expect(listModels(row('openai-compatible', { baseUrl: 'localhost:1234' }))).rejects.toThrow(/invalid Base URL/);
    await expect(listModels(row('openai-compatible'))).rejects.toThrow(/Base URL is required/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('testProvider', () => {
  it('missing key short-circuits without a request', async () => {
    const stub = stubFetch(() => jsonResponse({}));
    expect(await testProvider(row('openrouter', { apiKey: null }))).toEqual({ success: false, error: 'No OpenRouter API key configured' });
    expect(stub.calls).toHaveLength(0);
  });
  it('an unknown type is a failure', async () => {
    expect(await testProvider(row('nope'))).toEqual({ success: false, error: 'Unknown provider type: nope' });
  });
  it('providers with a default model do a one-turn generation and report the model', async () => {
    const stub = stubFetch(() => sseResponse([{ data: '[DONE]' }]));
    const r = await testProvider(row('openrouter'));
    expect(r).toEqual({ success: true, model: 'openrouter/auto' });
    expect(stub.calls[0].url).toContain('/chat/completions');
    expect(stub.calls[0].body.max_tokens).toBe(16);
    expect(stub.calls[0].body.stream).toBe(true);
  });
  it('429 counts as success; quota and auth are failures with the classified message', async () => {
    stubFetch(() => textResponse('slow', 429));
    expect(await testProvider(row('openrouter'))).toMatchObject({ success: true });
    stubFetch(() => textResponse('{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}', 400));
    expect(await testProvider(row('anthropic'))).toMatchObject({ success: false, error: expect.stringContaining('credit balance') });
    stubFetch(() => textResponse('{"error":{"message":"bad key"}}', 401));
    expect(await testProvider(row('openrouter'))).toMatchObject({ success: false, error: expect.stringMatching(/401/) });
  });
  it('providers without a default model (or without auth) use listing, and report a model count', async () => {
    stubFetch(() => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }));
    expect(await testProvider(row('openai-compatible', { baseUrl: 'http://127.0.0.1:1234' }))).toEqual({ success: true, model: '2 models' });
    const stub = stubFetch(() => jsonResponse({ models: [{ name: 'llama3.1' }] }));
    expect(await testProvider(row('ollama', { apiKey: null }))).toEqual({ success: true, model: '1 models' });
    expect(stub.calls[0].url).toBe('http://localhost:11434/api/tags');
  });
  it('claude-cli keeps the version spawn check and passes the oauth token in the environment', async () => {
    (spawn as any).mockImplementationOnce(() => fakeChild({ code: 0 }));
    expect(await testProvider(row('claude-cli', { apiKey: 'tok' }))).toEqual({ success: true, model: 'claude-cli' });
    expect((spawn as any).mock.calls[0][0]).toBe('claude');
    expect((spawn as any).mock.calls[0][2].env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    (spawn as any).mockImplementationOnce(() => fakeChild({ code: 1 }));
    expect(await testProvider(row('claude-cli', { apiKey: null }))).toEqual({ success: false, error: 'Claude CLI not found or not working' });
    (spawn as any).mockImplementationOnce(() => fakeChild({ error: true }));
    expect(await testProvider(row('claude-cli', { apiKey: null }))).toEqual({ success: false, error: 'Claude CLI not found or not working' });
  });
  it('a connection failure is a failure with a readable message', async () => {
    stubFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:1234') }); });
    const r = await testProvider(row('openai-compatible', { baseUrl: 'http://127.0.0.1:1234' }));
    expect(r).toEqual({ success: false, error: expect.stringContaining('ECONNREFUSED') });
  });
});

describe('testModel', () => {
  it('uses the model row and judges only the HTTP outcome (the body is never parsed, so a truncated stream is fine)', async () => {
    const stub = stubFetch(() => sseResponse([{ event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 16 } }) }]));
    const r = await testModel(row('anthropic'), { model: 'claude-haiku-5-5' });
    expect(r).toEqual({ success: true, model: 'claude-haiku-5-5' });
    expect(stub.calls[0].body.model).toBe('claude-haiku-5-5');
    expect(stub.calls[0].body.max_tokens).toBe(16);
    expect(stub.calls[0].body.cache_control).toBeUndefined();
  });
  it('a 429 means the key works; a 401 and a quota failure are failures', async () => {
    stubFetch(() => textResponse('slow', 429));
    expect(await testModel(row('openrouter'), { model: 'm' })).toEqual({ success: true, model: 'm' });
    stubFetch(() => textResponse('{"error":{"message":"bad key"}}', 401));
    expect(await testModel(row('openrouter'), { model: 'm' })).toMatchObject({ success: false, error: expect.stringMatching(/401/) });
    stubFetch(() => textResponse('{"error":{"type":"insufficient_quota","message":"out of credit"}}', 429));
    expect(await testModel(row('openai'), { model: 'm' })).toMatchObject({ success: false, error: expect.stringContaining('out of credit') });
  });
  it('a missing key short-circuits without a request', async () => {
    const stub = stubFetch(() => jsonResponse({}));
    expect(await testModel(row('gemini', { apiKey: null }), { model: 'g' })).toEqual({ success: false, error: 'No Gemini API key configured' });
    expect(stub.calls).toHaveLength(0);
  });
  it('claude-cli: version and tool self-test decide the result', async () => {
    (ClaudeCliProvider.getVersion as any).mockResolvedValueOnce(null);
    expect(await testModel(row('claude-cli', { apiKey: null }), { model: null })).toEqual({ success: false, error: 'Claude CLI not found or not working' });
    (ClaudeCliProvider.getVersion as any).mockResolvedValueOnce('1.0.0');
    (ClaudeCliProvider.testToolUse as any).mockResolvedValueOnce({ ok: false, reason: 'token cannot run tools' });
    expect(await testModel(row('claude-cli', { apiKey: 'tok' }), { model: 'opus' })).toEqual({ success: false, error: 'token cannot run tools' });
    (ClaudeCliProvider.getVersion as any).mockResolvedValueOnce('1.0.0');
    (ClaudeCliProvider.testToolUse as any).mockResolvedValueOnce({ ok: true });
    expect(await testModel(row('claude-cli', { apiKey: 'tok' }), { model: null })).toEqual({ success: true, model: 'claude-cli' });
    expect((ClaudeCliProvider.testToolUse as any).mock.calls.at(-1)[1]).toBe('sonnet');    // catalog default for a blank model
  });
  it('falls back to the default model, and requires one when there is none', async () => {
    stubFetch(() => sseResponse([{ data: '[DONE]' }]));
    expect(await testModel(row('openrouter'), { model: null })).toEqual({ success: true, model: 'openrouter/auto' });
    expect(await testModel(row('openai'), { model: null })).toMatchObject({ success: false, error: expect.stringMatching(/No model selected/) });
  });
});
