// fixtures: hand-written from https://docs.anthropic.com/en/api/models-list,
// https://ai.google.dev/api/models#method:-models.list and https://github.com/ollama/ollama/blob/main/docs/api.md
import { describe, it, expect, afterEach, vi } from 'vitest';
import { listModels, testProvider, testModel } from '../provider-ops';
import { stubFetch, jsonResponse, textResponse, sseResponse, callHeader } from '../test-helpers';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../claude-cli-provider', () => ({ ClaudeCliProvider: { getVersion: vi.fn(), testToolUse: vi.fn() } }));
import { spawn } from 'child_process';
import { ClaudeCliProvider } from '../../claude-cli-provider';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
