// fixtures: hand-written from https://docs.anthropic.com/en/api/messages-streaming,
// https://platform.openai.com/docs/api-reference/chat-streaming and https://docs.mistral.ai/api/#tag/fim
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProvider, getDialect } from '../registry';
import { AI_PROVIDER_CATALOG, getProviderDescriptor } from '../../../../shared/lib/ai-provider-catalog';
import { DialectProvider } from '../provider';
import { parseSSEStream } from '../http';
import type { Dialect } from '../dialect';
import { UnknownProviderError, AiProviderError, ConnectionError, isFallbackEligible } from '../errors';
import { stubFetch, sseResponse, jsonResponse, textResponse, collect, callHeader } from '../test-helpers';

afterEach(() => vi.unstubAllGlobals());

/** A 200 body that sends a first fragment and then stalls; it errors the way fetch does when the request is aborted. */
function stalledBody(signal: AbortSignal | null | undefined, first = '{"choi'): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(first));
      signal?.addEventListener('abort', () => c.error(signal.reason), { once: true });
    },
  });
}
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

describe('DialectProvider.validate', () => {
  it('throws for a blank model on a provider with no default, without any request', () => {
    const stub = stubFetch(oneOk);
    for (const model of [undefined, '', '   ']) {
      const p = createProvider('mistral', { apiKey: 'k', model });
      expect(() => p.validate!()).toThrow(AiProviderError);
      expect(() => p.validate!()).toThrow('No model selected for Mistral. Choose a model in the model settings.');
    }
    expect(stub.calls).toHaveLength(0);
  });
  it('throws for a stored Base URL that is blocked or malformed, without any request', () => {
    const stub = stubFetch(oneOk);
    expect(() => createProvider('ollama', { baseUrl: 'http://169.254.10.5:11434', model: 'llama3.1' }).validate!())
      .toThrow(/^Ollama: invalid Base URL\. .*link-local/);
    expect(() => createProvider('ollama', { baseUrl: 'not a url', model: 'llama3.1' }).validate!())
      .toThrow(/^Ollama: invalid Base URL\./);
    expect(stub.calls).toHaveLength(0);
  });
  it('passes for a usable configuration and makes no request', () => {
    const stub = stubFetch(oneOk);
    expect(() => createProvider('mistral', { apiKey: 'k', model: 'mistral-small-latest' }).validate!()).not.toThrow();
    expect(() => createProvider('ollama', { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1' }).validate!()).not.toThrow();
    expect(() => createProvider('openrouter', { apiKey: 'k' }).validate!()).not.toThrow();   // catalog default model
    expect(stub.calls).toHaveLength(0);
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
  it('complete(): an abort while the FIM body is being read passes through as the AbortError, not "not JSON"', async () => {
    const ac = new AbortController();
    stubFetch((call) => new Response(stalledBody(call.init.signal), { status: 200 }));
    const p = createProvider('codestral', { apiKey: 'k' }).complete({ prefix: 'a', suffix: 'b', signal: ac.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(AiProviderError);
    expect(err.name).toBe('AbortError');
  });
  it('complete(): a connection dropped while the FIM body is read is a ConnectionError the router can fall back on', async () => {
    stubFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('{"choi')); },
      pull(c) { c.error(new TypeError('terminated')); },
    }), { status: 200 }));
    const err: any = await createProvider('codestral', { apiKey: 'k' }).complete({ prefix: 'a', suffix: 'b' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toBe('Codestral closed the connection while sending the response');
    expect(isFallbackEligible(err)).toBe(true);
  });
  it('complete(): Mistral uses FIM for a codestral model', async () => {
    const stub = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    expect(await createProvider('mistral', { apiKey: 'k', model: 'codestral-latest' }).complete({ prefix: 'a', suffix: 'b' })).toBe('x');
    expect(stub.calls[0].url).toBe('https://api.mistral.ai/v1/fim/completions');
    expect(stub.calls[0].body.model).toBe('codestral-latest');
  });
  it('a model of only whitespace counts as no model', async () => {
    const stub = stubFetch(() => sseResponse([{ data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }) }]));
    await expect(collect(createProvider('openai', { apiKey: 'k', model: '  ' }).createStreamingRequest(msgs, '', []))).rejects.toThrow(/No model selected for OpenAI/);
    expect(stub.calls).toHaveLength(0);
    await collect(createProvider('gemini', { apiKey: 'k', model: ' \n' }).createStreamingRequest(msgs, '', []));
    expect(stub.calls[0].url).toContain('/models/gemini-2.5-flash:streamGenerateContent');
  });
  it('a configured model is trimmed before it is sent', async () => {
    const stub = stubFetch(oneOk);
    await collect(createProvider('openrouter', { apiKey: 'k', model: ' vendor/model\n' }).createStreamingRequest(msgs, '', []));
    expect(stub.calls[0].body.model).toBe('vendor/model');
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

// ── A connection that drops after the 200 headers ─────────────────────

const sse = (o: unknown, event?: string) => (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(o)}\n\n`;
const nd = (o: unknown) => `${JSON.stringify(o)}\n`;

/** Per provider: the stream fragments that make up "usage only" and "text" before the drop. */
const DROP_CASES: Record<string, { usage: string; text: string; config: Record<string, string> }> = {
  anthropic: {
    usage: sse({ type: 'message_start', message: { usage: { input_tokens: 3 } } }, 'message_start'),
    text: sse({ type: 'message_start', message: { usage: { input_tokens: 3 } } }, 'message_start')
      + sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'half' } }, 'content_block_delta'),
    config: { apiKey: 'sk-test-placeholder' },
  },
  openrouter: {
    usage: sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 0 } }),
    text: sse({ choices: [{ delta: { content: 'half' }, finish_reason: null }] }),
    config: { apiKey: 'sk-test-placeholder' },
  },
  gemini: {
    usage: sse({ usageMetadata: { promptTokenCount: 3 } }),
    text: sse({ candidates: [{ content: { parts: [{ text: 'half' }] } }] }),
    config: { apiKey: 'sk-test-placeholder' },
  },
  ollama: {
    usage: nd({ message: { content: '' }, prompt_eval_count: 3 }),
    text: nd({ message: { content: 'half' } }),
    config: { baseUrl: 'http://localhost:11434' },
  },
};

/** A 200 body that sends `chunks` and then fails the way undici does when the socket is reset. */
function droppedBody(chunks: string[], message = 'terminated'): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(new TextEncoder().encode(chunks[i++]));
      else c.error(new TypeError(message));
    },
  });
}

describe('DialectProvider: a connection dropped mid-stream is a ConnectionError', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  for (const [id, c] of Object.entries(DROP_CASES)) {
    for (const [label, chunks] of [['before any content', []], ['after only usage', [c.usage]], ['after some text', [c.text]]] as const) {
      it(`${id}: ${label}`, async () => {
        stubFetch(() => new Response(droppedBody([...chunks]), { status: 200 }));
        const p = createProvider(id, c.config);
        const seen: any[] = [];
        const err: any = await (async () => { for await (const e of p.createStreamingRequest(msgs, '', [])) seen.push(e); })().catch((e) => e);
        expect(err).toBeInstanceOf(ConnectionError);
        expect(err.message).toBe(`${(p as any).descriptor.shortName} closed the connection while streaming`);
        expect(err.provider).toBe(id);
        expect(isFallbackEligible(err)).toBe(true);
        expect(err.cause).toBeInstanceOf(TypeError);
        const content = seen.filter((e) => e.type !== 'usage');
        expect(content).toEqual(label === 'after some text' ? [{ type: 'text', text: 'half' }] : []);
      });
    }
  }

  it('the key is redacted from the cause', async () => {
    stubFetch(() => new Response(droppedBody([], 'socket closed for sk-test-placeholder'), { status: 200 }));
    const err: any = await collect(createProvider('openrouter', { apiKey: 'sk-test-placeholder' }).createStreamingRequest(msgs, '', [])).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(String(err.cause.message)).not.toContain('sk-test-placeholder');
    expect(String(err.cause.stack)).not.toContain('sk-test-placeholder');
  });

  it('complete(): a drop while the chat stream is read is a ConnectionError too', async () => {
    stubFetch(() => new Response(droppedBody([DROP_CASES.openrouter.text]), { status: 200 }));
    const err: any = await createProvider('openrouter', { apiKey: 'k' }).complete({ prefix: 'a', suffix: 'b' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
  });

  it('a caller abort while the stream is read passes through unchanged', async () => {
    const ac = new AbortController();
    stubFetch((call) => new Response(stalledBody(call.init.signal, sse({ choices: [{ delta: { content: 'a' } }] })), { status: 200 }));
    const seen: any[] = [];
    const err: any = await (async () => {
      for await (const e of createProvider('openrouter', { apiKey: 'k' }).createStreamingRequest(msgs, '', [], { signal: ac.signal })) {
        seen.push(e);
        setTimeout(() => ac.abort(new DOMException('stop', 'AbortError')), 5);
      }
    })().then(() => undefined, (e) => e);
    // Either the dialect noticed the abort and stopped quietly, or the read rejected with the abort reason. Never a ConnectionError.
    if (err !== undefined) {
      expect(err).not.toBeInstanceOf(ConnectionError);
      expect(err.name).toBe('AbortError');
    }
    expect(seen).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('an abort while a body read is pending surfaces the abort reason itself', async () => {
    const ac = new AbortController();
    const reason = new DOMException('caller stopped', 'AbortError');
    stubFetch((call) => new Response(stalledBody(call.init.signal, ''), { status: 200 }));
    setTimeout(() => ac.abort(reason), 10);
    const err: any = await collect(createProvider('openrouter', { apiKey: 'k' }).createStreamingRequest(msgs, '', [], { signal: ac.signal })).catch((e) => e);
    expect(err).toBe(reason);
  });

  it('a bug in a parser is rethrown as itself, not as a dropped connection', async () => {
    const bug = new TypeError("Cannot read properties of null (reading 'choices')");
    const buggy: Dialect = {
      ...getDialect('openai-chat'),
      async *parseStream(res, ctx, signal) {
        for await (const _sse of parseSSEStream(res.body!, signal)) throw bug;
      },
    };
    stubFetch(() => sseResponse([{ data: '{}' }]));
    const p = new DialectProvider(getProviderDescriptor('openrouter')!, buggy, { apiKey: 'k' });
    const err: any = await collect(p.createStreamingRequest(msgs, '', [])).catch((e) => e);
    expect(err).toBe(bug);
    expect(err).not.toBeInstanceOf(ConnectionError);
    expect(isFallbackEligible(err)).toBe(false);
  });

  it('a provider error raised by the dialect passes through unchanged', async () => {
    stubFetch(() => new Response(droppedBody([sse({ error: { code: 429, message: 'slow' } })]), { status: 200 }));
    const err: any = await collect(createProvider('openrouter', { apiKey: 'k' }).createStreamingRequest(msgs, '', [])).catch((e) => e);
    expect(err.name).toBe('RateLimitError');
  });
});

describe('DialectProvider: an over-long stream line', () => {
  it('fails with the provider named, and is not fallback-eligible', async () => {
    const chunk = new TextEncoder().encode('a'.repeat(64 * 1024));
    let sent = 0;
    stubFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (sent++ < 140) c.enqueue(chunk); else c.close(); },
    }), { status: 200 }));
    const err: any = await collect(createProvider('openrouter', { apiKey: 'k' }).createStreamingRequest([{ role: 'user', content: 'hi' }], '', [])).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.message).toBe('OpenRouter sent a line longer than 8 MB');
    expect(err.provider).toBe('openrouter');
    expect(isFallbackEligible(err)).toBe(false);
  });
});

describe('DialectProvider against a real local server', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });
  async function listen(handler: http.RequestListener): Promise<string> {
    server = http.createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const msgs = [{ role: 'user' as const, content: 'hi' }];

  it('a socket reset after the 200 headers is a ConnectionError', async () => {
    const url = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': keep-alive\n\n');
        setTimeout(() => res.socket?.destroy(), 20);
      });
    });
    const err: any = await collect(createProvider('openai-compatible', { baseUrl: `${url}/v1`, model: 'm' }).createStreamingRequest(msgs, '', [])).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toBe('OpenAI-compatible closed the connection while streaming');
    expect(isFallbackEligible(err)).toBe(true);
  });

  it('a consumer that stops iterating closes the upstream connection', async () => {
    let closed = false;
    const url = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.on('close', () => { closed = true; });
        const t = setInterval(() => {
          if (res.destroyed) { clearInterval(t); return; }
          res.write(sse({ choices: [{ delta: { content: 'x' } }] }));
        }, 10);
      });
    });
    let n = 0;
    for await (const _e of createProvider('openai-compatible', { baseUrl: `${url}/v1`, model: 'm' }).createStreamingRequest(msgs, '', [])) {
      if (++n >= 3) break;
    }
    for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);
  });
});
