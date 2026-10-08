// Characterization: the OpenAI-compatible providers (OpenRouter, Codestral) and error responses
// across all providers, observed only through createProvider in, wire request and events out.
// First written against the previous single-file implementation; every assertion that changed with
// the dialect rewrite says what the old behaviour was. The factory cases live in provider.test.ts.
// fixtures: hand-written from https://platform.openai.com/docs/api-reference/chat-streaming
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProvider } from '../registry';
import { sseResponse, chunkedResponse, textResponse, okStream, stubFetch, callHeader, collect } from '../test-helpers';
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';

afterEach(() => vi.unstubAllGlobals());

const msgs: AiMessage[] = [{ role: 'user', content: 'hello' }];
const noTools: AiToolDefinition[] = [];

const chunk = (payload: unknown) => ({ data: JSON.stringify(payload) });
const toolDelta = (calls: unknown[]) => chunk({ choices: [{ delta: { tool_calls: calls } }] });
const finish = (reason: string, extra: Record<string, unknown> = {}) => chunk({ choices: [{ delta: {}, finish_reason: reason }], ...extra });

const runWith = (name: string, cfg: Record<string, any>, messages: AiMessage[] = msgs, system = 'sys', tools: AiToolDefinition[] = noTools) =>
  collect(createProvider(name, cfg).createStreamingRequest(messages, system, tools));

const fullHistory: AiMessage[] = [
  { role: 'user', content: 'go' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'tool_use', id: 'tc1', name: 'get_info', input: { q: 'x' } },
    ],
  },
  { role: 'tool_result', toolUseId: 'tc1', content: 'out' },
];
const fullHistoryWire = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'go' },
  {
    role: 'assistant',
    content: 'ab',
    tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_info', arguments: '{"q":"x"}' } }],
  },
  { role: 'tool', content: 'out', tool_call_id: 'tc1' },
];

// ── openrouter ──────────────────────────────────────────────────────

describe('openrouter', () => {
  describe('request headers', () => {
    it('uses Bearer authorization', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', { apiKey: 'or-key-123' });
      expect(callHeader(stub.calls[0], 'Authorization')).toBe('Bearer or-key-123');
      expect(callHeader(stub.calls[0], 'Content-Type')).toBe('application/json');
    });
  });

  describe('tool definitions', () => {
    it('uses OpenAI function format', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', { apiKey: 'test' }, msgs, 'sys', [
        {
          name: 'tool_a',
          description: 'Tool A',
          inputSchema: { type: 'object', properties: {} },
          context: ['test'],
        },
      ]);
      expect(stub.calls[0].body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'tool_a',
            description: 'Tool A',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]);
    });
  });

  describe('request', () => {
    it('posts to the default OpenRouter URL with the default model', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', { apiKey: 'k' });
      const call = stub.calls[0];
      expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(call.init.method).toBe('POST');
      expect(call.body).toEqual({
        model: 'openrouter/auto', // was google/gemini-2.0-flash-001, which is retired
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
        stream: true,
        stream_options: { include_usage: true }, // new: asks for the usage chunk at the end of the stream
      });
    });

    it('honours baseUrl and model', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', { apiKey: 'k', baseUrl: 'https://proxy.test', model: 'vendor/model' });
      // Was ignored: the request always went to openrouter.ai. A configured Base URL is now used, and a
      // bare host gets the provider's default path.
      expect(stub.calls[0].url).toBe('https://proxy.test/api/v1/chat/completions');
      expect(stub.calls[0].body.model).toBe('vendor/model');
    });

    it('sends no Authorization header when no key is configured', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', {});
      // Was the literal header "Bearer undefined". Now the header is left out.
      expect(callHeader(stub.calls[0], 'Authorization')).toBeUndefined();
    });

    it('formats assistant tool calls and tool results', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', { apiKey: 'k' }, fullHistory);
      expect(stub.calls[0].body.messages).toEqual(fullHistoryWire);
    });
  });
});

// ── codestral ───────────────────────────────────────────────────────

describe('codestral', () => {
  describe('request headers', () => {
    it('uses Bearer authorization', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('codestral', { apiKey: 'cs-key-456' });
      expect(callHeader(stub.calls[0], 'Authorization')).toBe('Bearer cs-key-456');
      expect(callHeader(stub.calls[0], 'Content-Type')).toBe('application/json');
    });
  });

  describe('tool definitions', () => {
    it('uses OpenAI function format', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('codestral', { apiKey: 'test' }, msgs, 'sys', [
        {
          name: 'tool_b',
          description: 'Tool B',
          inputSchema: { type: 'object' },
          context: ['test'],
        },
      ]);
      expect(stub.calls[0].body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'tool_b',
            description: 'Tool B',
            parameters: { type: 'object' },
          },
        },
      ]);
    });
  });

  describe('request', () => {
    it('posts to api.mistral.ai with codestral-latest by default', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('codestral', { apiKey: 'k' });
      // Chat already used api.mistral.ai, and still does. The blank-model default was mistral-large-latest;
      // it is now codestral-latest, matching the connection test, model list, and completion.
      expect(stub.calls[0].url).toBe('https://api.mistral.ai/v1/chat/completions');
      expect(stub.calls[0].body).toEqual({
        model: 'codestral-latest',
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
        stream: true,
        // New: usage is requested where the server accepts it. A server that rejects stream_options is
        // retried once without it and remembered.
        stream_options: { include_usage: true },
      });
    });

    it('honours baseUrl and model', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('codestral', { apiKey: 'k', baseUrl: 'https://codestral.mistral.ai', model: 'codestral-latest' });
      expect(stub.calls[0].url).toBe('https://codestral.mistral.ai/v1/chat/completions');
      expect(stub.calls[0].body.model).toBe('codestral-latest');
    });

    it('formats assistant tool calls and tool results', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('codestral', { apiKey: 'k' }, fullHistory);
      expect(stub.calls[0].body.messages).toEqual(fullHistoryWire);
    });
  });
});

// ── Tool call buffering (openai-chat: OpenRouter and Codestral) ─────

describe('openai-chat tool call buffering', () => {
  it('should buffer incremental tool call arguments correctly', async () => {
    // Three chunks building up the arguments JSON incrementally
    stubFetch(() => sseResponse([
      toolDelta([{ index: 0, id: 'call_1', type: 'function', function: { name: 'my_tool', arguments: '{"ke' } }]),
      toolDelta([{ index: 0, function: { arguments: 'y":"va' } }]),
      toolDelta([{ index: 0, function: { arguments: 'lue"}' } }]),
      finish('tool_calls'),
    ]));
    const events = await runWith('openrouter', { apiKey: 'test' });

    const toolEvents = events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'my_tool',
      input: { key: 'value' },
    });
  });

  it('should handle multiple concurrent tool calls by index', async () => {
    // Two tool calls interleaved by index
    stubFetch(() => sseResponse([
      toolDelta([
        { index: 0, id: 'call_a', type: 'function', function: { name: 'tool_one', arguments: '{"x":' } },
        { index: 1, id: 'call_b', type: 'function', function: { name: 'tool_two', arguments: '{"y":' } },
      ]),
      toolDelta([
        { index: 0, function: { arguments: '1}' } },
        { index: 1, function: { arguments: '2}' } },
      ]),
      finish('tool_calls'),
    ]));
    const events = await runWith('codestral', { apiKey: 'test' });

    const toolEvents = events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(2);

    // Find each by id
    const callA = toolEvents.find((e) => e.type === 'tool_use' && e.id === 'call_a');
    const callB = toolEvents.find((e) => e.type === 'tool_use' && e.id === 'call_b');
    expect(callA).toMatchObject({ name: 'tool_one', input: { x: 1 } });
    expect(callB).toMatchObject({ name: 'tool_two', input: { y: 2 } });
  });

  it('should yield empty input for malformed tool arguments', async () => {
    stubFetch(() => sseResponse([
      toolDelta([{ index: 0, id: 'call_bad', type: 'function', function: { name: 'broken_tool', arguments: '{bad json' } }]),
      finish('tool_calls'),
    ]));
    const events = await runWith('openrouter', { apiKey: 'test' });

    const toolEvents = events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({
      type: 'tool_use',
      id: 'call_bad',
      name: 'broken_tool',
      input: {}, // defaults to empty object on parse failure
    });
  });

  it('should flush tool calls on [DONE] event', async () => {
    // Tool call started but no finish_reason before [DONE]
    stubFetch(() => sseResponse([
      toolDelta([{ index: 0, id: 'call_done', type: 'function', function: { name: 'done_tool', arguments: '{"a":1}' } }]),
      { data: '[DONE]' },
    ]));
    const events = await runWith('openrouter', { apiKey: 'test' });

    const toolEvents = events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({
      type: 'tool_use',
      id: 'call_done',
      name: 'done_tool',
      input: { a: 1 },
    });
  });

  it('should handle usage events in OpenAI-compatible streams', async () => {
    stubFetch(() => sseResponse([
      chunk({ choices: [{ delta: { content: 'hi' } }] }),
      finish('stop', { usage: { prompt_tokens: 100, completion_tokens: 25 } }),
    ]));
    const events = await runWith('codestral', { apiKey: 'test' });

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: 'usage',
      inputTokens: 100,
      outputTokens: 25,
    });
  });

  it('treats a stream that carries only usage, with no content and no terminator, as an empty response', async () => {
    stubFetch(() => sseResponse([chunk({ usage: { prompt_tokens: 42, completion_tokens: 7 } })]));
    // Was a single usage event and a silent empty reply. A stream with no content and neither [DONE] nor a
    // finish_reason is now an error, so the router can tell it apart from a real (if short) answer.
    await expect(runWith('openrouter', { apiKey: 'test' })).rejects.toThrow('OpenRouter returned an empty response');
  });

  it('emits usage once, from the last usage-bearing chunk', async () => {
    stubFetch(() => sseResponse([
      chunk({ choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      { data: '[DONE]' },
    ]));
    // Was one usage event per usage-bearing chunk, which consumers summed (over-counting). Usage events are
    // additive, so the stream now reports once, at the end.
    expect(await runWith('openrouter', { apiKey: 'k' })).toEqual([
      { type: 'text', text: 'a' },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
  });

  it('flushes buffered tool calls on finish_reason stop', async () => {
    stubFetch(() => sseResponse([
      toolDelta([{ index: 0, id: 'c1', function: { name: 't', arguments: '{"k":1}' } }]),
      finish('stop'),
      { data: '[DONE]' },
    ]));
    expect(await runWith('codestral', { apiKey: 'k' })).toEqual([{ type: 'tool_use', id: 'c1', name: 't', input: { k: 1 } }]);
  });

  it('flushes buffered tool calls when the stream ends without [DONE] or a finish_reason', async () => {
    stubFetch(() => sseResponse([
      chunk({ choices: [{ delta: { content: 'thinking' } }] }),
      toolDelta([{ index: 0, id: 'kept', function: { name: 't', arguments: '{}' } }]),
    ]));
    // Was: the buffered call was dropped. End of stream is now lenient: a complete call is flushed (and a
    // warning logged); only a call truncated by the output limit is an error.
    expect(await runWith('openrouter', { apiKey: 'k' })).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 'kept', name: 't', input: {} },
    ]);
  });

  it('keeps appending to one call when a delta has no index and repeats its id', async () => {
    stubFetch(() => sseResponse([
      toolDelta([{ id: 'same', function: { name: 'echo', arguments: '{"v":' } }]),
      toolDelta([{ id: 'same', function: { arguments: '"x"}' } }]),
      finish('tool_calls'),
    ]));
    // Was: a repeated id restarted the buffer, so the second fragment replaced the first and the call lost
    // its name and input. A repeated id now continues the same call.
    expect(await runWith('openrouter', { apiKey: 'k' })).toEqual([{ type: 'tool_use', id: 'same', name: 'echo', input: { v: 'x' } }]);
  });

  it('starts a call from a fragment for an index it has not seen, with a generated id', async () => {
    stubFetch(() => sseResponse([
      toolDelta([{ index: 3, function: { name: 'orphan', arguments: '{}' } }]),
      finish('tool_calls'),
    ]));
    // Was: ignored, because only a fragment carrying an id could start a call. Calls are now created on first
    // sight of their index, and a missing id comes from the provider's id generator.
    const events = await collect(createProvider('openrouter', { apiKey: 'k' }, { newId: () => 'call-1' }).createStreamingRequest(msgs, 'sys', noTools));
    expect(events).toEqual([{ type: 'tool_use', id: 'call-1', name: 'orphan', input: {} }]);
  });

  it('reassembles a chunk split across network reads, with CRLF endings', async () => {
    const line = 'data: {"choices":[{"delta":{"content":"split ok"}}]}\r\n\r\n';
    stubFetch(() => chunkedResponse([line.slice(0, 15), line.slice(15, line.length - 3), line.slice(line.length - 3), 'data: [DONE]\r\n\r\n']));
    expect(await runWith('openrouter', { apiKey: 'k' })).toEqual([{ type: 'text', text: 'split ok' }]);
  });

  it('stops quietly when aborted mid-stream and drops a half-built tool call', async () => {
    stubFetch(() => chunkedResponse([
      'data: {"choices":[{"delta":{"content":"first","tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    ]));
    const ac = new AbortController();
    const seen: AiStreamEvent[] = [];
    for await (const e of createProvider('openrouter', { apiKey: 'k' }).createStreamingRequest(msgs, 's', noTools, { signal: ac.signal })) {
      seen.push(e);
      ac.abort();
    }
    expect(seen).toEqual([{ type: 'text', text: 'first' }]);
  });

  it('rejects with the abort error when the signal is already aborted', async () => {
    stubFetch(() => okStream('openai-chat'));
    const ac = new AbortController();
    ac.abort();
    await expect(collect(createProvider('codestral', { apiKey: 'k' }).createStreamingRequest(msgs, 's', noTools, { signal: ac.signal })))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ── Error response tests (provider-agnostic patterns) ───────────────

describe('Error responses across providers', () => {
  it('OpenRouter should throw on 401', async () => {
    stubFetch(() => textResponse('Unauthorized', 401));
    const p = runWith('openrouter', { apiKey: 'bad' });
    await expect(p).rejects.toThrow(/401/);
    // Same message as before; it was a plain Error and is now an AuthError, so the router can fall back.
    await expect(p).rejects.toThrow('OpenRouter API error (401): Unauthorized');
    await expect(p).rejects.toMatchObject({ name: 'AuthError', status: 401 });
  });

  it('Codestral should throw on 429', async () => {
    stubFetch(() => textResponse('rate limited', 429, { 'x-ratelimit-remaining-requests': '0' }));
    const p = runWith('codestral', { apiKey: 'test' });
    await expect(p).rejects.toThrow(/429/);
    // Was exactly "Codestral rate limited (429)"; a 429 now uses the common error wording with the body text.
    await expect(p).rejects.toMatchObject({ name: 'RateLimitError', message: 'Codestral API error (429): rate limited' });
  });

  it('OpenRouter throws a RateLimitError carrying the response headers on 429', async () => {
    stubFetch(() => textResponse('slow', 429, { 'x-ratelimit-remaining-requests': '0' }));
    const err: any = await runWith('openrouter', { apiKey: 'k' }).catch((e) => e);
    expect(err.name).toBe('RateLimitError');
    // Was exactly "OpenRouter rate limited (429)".
    expect(err.message).toBe('OpenRouter API error (429): slow');
    expect(err.headers.get('x-ratelimit-remaining-requests')).toBe('0');
  });

  it('Gemini should throw on 403 with the provider message', async () => {
    stubFetch(() => textResponse('{"error":"forbidden"}', 403));
    const p = runWith('gemini', { apiKey: 'bad' });
    await expect(p).rejects.toThrow(/403/);
    // Was a plain Error carrying the raw JSON body. Now the provider's message is extracted from the JSON.
    // Was: a plain AiProviderError. Now: a 403 without a credential marker is a PermissionDeniedError, which lets the
    // router try the next model but starts no cooldown, because it does not prove the key is bad.
    await expect(p).rejects.toThrow('Gemini API error (403): forbidden');
    await expect(p).rejects.toMatchObject({ name: 'PermissionDeniedError', status: 403 });
  });

  it('Ollama should throw on 500 with error body', async () => {
    stubFetch(() => textResponse('model not found', 500));
    const p = runWith('ollama', { baseUrl: 'http://localhost:11434' });
    await expect(p).rejects.toThrow(/500/);
    await expect(p).rejects.toThrow('Ollama API error (500): model not found');
  });

  it('OpenRouter should throw when response body is null', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    const p = runWith('openrouter', { apiKey: 'test' });
    await expect(p).rejects.toThrow(/no body/);
    await expect(p).rejects.toThrow('OpenRouter response has no body');
  });

  it('Codestral should throw when response body is null', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    const p = runWith('codestral', { apiKey: 'test' });
    await expect(p).rejects.toThrow(/no body/);
    await expect(p).rejects.toThrow('Codestral response has no body');
  });

  it('wraps a network failure from fetch in a ConnectionError that keeps the original as its cause', async () => {
    const boom = new TypeError('fetch failed');
    stubFetch(() => { throw boom; });
    // Was: the TypeError passed through unchanged. It is now a ConnectionError, so the router can fall back.
    const err: any = await runWith('openrouter', { apiKey: 'k' }).catch((e) => e);
    expect(err.name).toBe('ConnectionError');
    expect(err.message).toBe('OpenRouter request failed: fetch failed');
    expect(err.cause).toBe(boom);
  });
});
