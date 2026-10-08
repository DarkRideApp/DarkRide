// fixtures: hand-written from https://docs.anthropic.com/en/api/messages-streaming,
// https://platform.openai.com/docs/api-reference/chat-streaming and https://docs.mistral.ai/api/#tag/fim
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProvider, getDialect } from '../registry';
import { AI_PROVIDER_CATALOG } from '../../../../shared/lib/ai-provider-catalog';
import { UnknownProviderError, AiProviderError } from '../errors';
import { stubFetch, sseResponse, jsonResponse, textResponse, collect, callHeader } from '../test-helpers';

afterEach(() => vi.unstubAllGlobals());
const oneOk = () => sseResponse([{ data: JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) }, { data: '[DONE]' }]);

describe('createProvider', () => {
  it('unknown and cli types throw UnknownProviderError with the legacy text', () => {
    expect(() => createProvider('nope', {})).toThrow('Unknown AI provider: nope');
    expect(() => createProvider('nope', {})).toThrow(UnknownProviderError);
    expect(() => createProvider('claude-cli', {})).toThrow(UnknownProviderError);
    expect(() => createProvider('', {})).toThrow('Unknown AI provider: ');
  });
  it('does not touch the network when constructing a provider', () => {
    const stub = stubFetch(oneOk);
    createProvider('openrouter', { apiKey: 'k' });
    expect(stub.calls).toHaveLength(0);
  });
  it('every http catalog entry resolves to a registered dialect and names itself after its id', () => {
    for (const p of AI_PROVIDER_CATALOG.filter((x) => x.kind === 'http')) {
      expect(getDialect(p.dialect!).id).toBe(p.dialect);
      const provider = createProvider(p.id, { baseUrl: p.baseUrl === 'required' ? 'http://127.0.0.1:1' : undefined, model: 'm' });
      expect(provider.name).toBe(p.id);
    }
  });
  it('uses an injected id generator for synthesised tool-call ids', async () => {
    stubFetch(() => sseResponse([{ data: JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] }, finishReason: 'STOP' }] }) }]));
    const events = await collect(createProvider('gemini', { apiKey: 'k' }, { newId: () => 'fixed-id' }).createStreamingRequest([{ role: 'user', content: 'hi' }], '', []));
    expect(events).toEqual([{ type: 'tool_use', id: 'fixed-id', name: 'f', input: {} }]);
  });
});

describe('DialectProvider', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];

  it('a blank model on a provider with no default fails clearly before any request', async () => {
    const stub = stubFetch(oneOk);
    await expect(collect(createProvider('openai', { apiKey: 'k' }).createStreamingRequest(msgs, '', [])))
      .rejects.toThrow(/No model selected for OpenAI/);
    await expect(createProvider('openai', { apiKey: 'k' }).complete({ prefix: 'a', suffix: 'b' }))
      .rejects.toThrow(/No model selected for OpenAI/);
    expect(stub.calls).toHaveLength(0);
  });
  it('openai-compatible without a base URL fails clearly; an invalid stored URL names the problem', async () => {
    const stub = stubFetch(oneOk);
    await expect(collect(createProvider('openai-compatible', { model: 'm' }).createStreamingRequest(msgs, '', []))).rejects.toThrow(/Base URL is required/);
    await expect(collect(createProvider('ollama', { baseUrl: 'localhost:11434' }).createStreamingRequest(msgs, '', []))).rejects.toThrow(/Base URL/);
    expect(stub.calls).toHaveLength(0);
  });
  it('configuration errors are typed and tagged with the provider', async () => {
    stubFetch(oneOk);
    const err: any = await collect(createProvider('openai', { apiKey: 'k' }).createStreamingRequest(msgs, '', [])).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.provider).toBe('openai');
  });
  it('applies the default model, normalises base URLs, and sets lastResponseHeaders', async () => {
    const stub = stubFetch(() => { const r = oneOk(); return new Response(r.body, { headers: { 'content-type': 'text/event-stream', 'x-ratelimit-remaining-requests': '9' } }); });
    const p = createProvider('openrouter', { apiKey: 'k', baseUrl: 'https://openrouter.ai/' });
    await collect(p.createStreamingRequest(msgs, '', []));
    expect(stub.calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');   // bare host gets the default path
    expect(stub.calls[0].body.model).toBe('openrouter/auto');
    expect(p.lastResponseHeaders?.get('x-ratelimit-remaining-requests')).toBe('9');
  });
  it('passes stream options through to the request', async () => {
    const stub = stubFetch(oneOk);
    await collect(createProvider('openrouter', { apiKey: 'k' }).createStreamingRequest(msgs, '', [], { maxOutputTokens: 99, stopSequences: ['\n'], temperature: 0 }));
    expect(stub.calls[0].body).toMatchObject({ max_tokens: 99, stop: ['\n'], temperature: 0 });
  });
  it('throws "no body" when the response has none', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(collect(createProvider('openrouter', { apiKey: 'k' }).createStreamingRequest(msgs, '', []))).rejects.toThrow('OpenRouter response has no body');
  });
  it('complete(): chat branch drains the stream, trims at the first triple newline, and sends cache:false/effort for anthropic 5.x', async () => {
    const stub = stubFetch(() => sseResponse([
      { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'foo()\n\n\nbar()' } }) },
      { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ]));
    const out = await createProvider('anthropic', { apiKey: 'k', model: 'claude-haiku-5-5' }).complete({ prefix: 'a', suffix: 'b', systemPrompt: 'S', maxOutputTokens: 256 });
    expect(out).toBe('foo()');
    expect(stub.calls[0].body.cache_control).toBeUndefined();
    expect(stub.calls[0].body.output_config).toEqual({ effort: 'low' });
    expect(stub.calls[0].body.max_tokens).toBe(256);
    expect(stub.calls[0].body.system).toBe('S');
    expect(stub.calls[0].body.messages[0].content).toBe('a<CURSOR>b');
  });
  it('complete(): an output-limit stop returns the text so far', async () => {
    stubFetch(() => sseResponse([
      { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }) },
      { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 256 } }) },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ]));
    expect(await createProvider('anthropic', { apiKey: 'k', model: 'claude-haiku-5-5' }).complete({ prefix: 'a', suffix: '', maxOutputTokens: 256 })).toBe('partial');
  });
  it('complete(): other stream errors still throw', async () => {
    stubFetch(() => sseResponse([{ event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }) }]));
    await expect(createProvider('anthropic', { apiKey: 'k', model: 'claude-haiku-5-5' }).complete({ prefix: 'a', suffix: '' })).rejects.toThrow(/stream error: boom/);
  });
  it('complete(): FIM for codestral models, chat otherwise', async () => {
    const stub = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'x: int' } }] }));
    const p = createProvider('codestral', { apiKey: 'k' });
    expect(await p.complete({ prefix: 'def f(', suffix: '): pass', temperature: 0 })).toBe('x: int');
    expect(stub.calls[0].url).toBe('https://api.mistral.ai/v1/fim/completions');
    expect(stub.calls[0].body).toMatchObject({ model: 'codestral-latest', prompt: 'def f(', suffix: '): pass', temperature: 0 });
    expect(stub.calls[0].init.redirect).toBe('error');
    expect(callHeader(stub.calls[0], 'authorization')).toBe('Bearer k');
    expect(p.lastResponseHeaders).toBeInstanceOf(Headers);
    const chat = stubFetch(oneOk);
    await createProvider('codestral', { apiKey: 'k', model: 'mistral-large-latest' }).complete({ prefix: 'a', suffix: 'b' });
    expect(chat.calls[0].url).toBe('https://api.mistral.ai/v1/chat/completions');
  });
  it('complete(): FIM output is trimmed at the first triple newline too', async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: 'a\n\n\nb' } }] }));
    expect(await createProvider('codestral', { apiKey: 'k' }).complete({ prefix: 'x', suffix: 'y' })).toBe('a');
  });
  it('complete(): a FIM 200 that is not JSON is an AiProviderError', async () => {
    stubFetch(() => textResponse('<html>gateway</html>', 200));
    const err: any = await createProvider('codestral', { apiKey: 'k' }).complete({ prefix: 'a', suffix: 'b' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.message).toMatch(/not JSON/);
  });
  it('complete(): FIM does not send when the signal is already aborted', async () => {
    const stub = stubFetch(() => jsonResponse({}));
    const ac = new AbortController(); ac.abort();
    await expect(createProvider('codestral', { apiKey: 'k' }).complete({ prefix: 'a', suffix: 'b', signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(stub.calls).toHaveLength(0);
  });
  it('trims whitespace around the key (a pasted key with a trailing newline must not break the header)', async () => {
    const stub = stubFetch(oneOk);
    await collect(createProvider('openrouter', { apiKey: ' sk-test-placeholder\n' }).createStreamingRequest(msgs, '', []));
    expect(callHeader(stub.calls[0], 'authorization')).toBe('Bearer sk-test-placeholder');
  });
  it('a key that is only whitespace sends no auth header at all', async () => {
    const stub = stubFetch(oneOk);
    await collect(createProvider('openai-compatible', { apiKey: '  ', baseUrl: 'http://127.0.0.1:1', model: 'm' }).createStreamingRequest(msgs, '', []));
    expect(callHeader(stub.calls[0], 'authorization')).toBeUndefined();
  });
  it('complete(): FIM failure classifies like any other request, and the key never leaks', async () => {
    stubFetch(() => textResponse('{"error":{"message":"bad key sk-test-placeholder"}}', 401));
    const err: any = await createProvider('codestral', { apiKey: 'sk-test-placeholder' }).complete({ prefix: 'a', suffix: 'b' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'AuthError', status: 401, provider: 'codestral' });
    expect(err.message).toContain('Codestral API error (401): bad key');
    expect(err.message).not.toContain('sk-test-placeholder');
  });
});
