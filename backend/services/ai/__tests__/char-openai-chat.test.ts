// Step 0 characterization: the OpenAI-compatible providers (OpenRouter, Codestral), the
// createProvider factory, and error responses across all providers, observed only through
// createProvider in, wire request and events out. Written against the old ai-provider.ts.
// fixtures: hand-written from https://platform.openai.com/docs/api-reference/chat-streaming
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProvider } from '../../ai-provider';
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

// ── Factory ──────────────────────────────────────────────────────────

describe('createProvider', () => {
  it('creates a provider named anthropic', () => { // reworded from 'returns AnthropicProvider for "anthropic"'
    expect(createProvider('anthropic', { apiKey: 'test-key' }).name).toBe('anthropic');
  });

  it('creates a provider named gemini', () => { // reworded from 'returns GeminiProvider for "gemini"'
    expect(createProvider('gemini', { apiKey: 'test-key' }).name).toBe('gemini');
  });

  it('creates a provider named ollama', () => { // reworded from 'returns OllamaProvider for "ollama"'
    expect(createProvider('ollama', { baseUrl: 'http://localhost:11434' }).name).toBe('ollama');
  });

  it('creates a provider named openrouter', () => { // reworded from 'returns OpenRouterProvider for "openrouter"'
    expect(createProvider('openrouter', { apiKey: 'test-key' }).name).toBe('openrouter');
  });

  it('creates a provider named codestral', () => { // reworded from 'returns CodestralProvider for "codestral"'
    expect(createProvider('codestral', { apiKey: 'test-key' }).name).toBe('codestral');
  });

  it('throws for unknown provider', () => {
    expect(() => createProvider('unknown', {})).toThrow('Unknown AI provider: unknown');
  });

  it('throws for empty string provider', () => {
    expect(() => createProvider('', {})).toThrow('Unknown AI provider: ');
  });

  it('should throw for unknown provider name "invalid"', () => {
    expect(() => createProvider('invalid', { apiKey: 'key' })).toThrow('Unknown AI provider: invalid');
  });

  it('should create each provider type via loop', () => {
    // Was an instanceof check per class; now the public name and the streaming entry point.
    const configs: Array<{ name: string; config: Record<string, any> }> = [
      { name: 'anthropic', config: { apiKey: 'k' } },
      { name: 'gemini', config: { apiKey: 'k' } },
      { name: 'ollama', config: { baseUrl: 'http://localhost:11434' } },
      { name: 'openrouter', config: { apiKey: 'k' } },
      { name: 'codestral', config: { apiKey: 'k' } },
    ];
    for (const { name, config } of configs) {
      const provider = createProvider(name, config);
      expect(provider.name).toBe(name);
      expect(typeof provider.createStreamingRequest).toBe('function');
    }
  });

  it('does not touch the network when constructing a provider', () => { // new in Step 0
    const stub = stubFetch(() => okStream('openai-chat'));
    createProvider('openrouter', { apiKey: 'k' });
    expect(stub.calls).toHaveLength(0);
  });
});

// ── OpenRouterProvider ──────────────────────────────────────────────

describe('OpenRouterProvider', () => {
  describe('buildHeaders', () => {
    it('uses Bearer authorization', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', { apiKey: 'or-key-123' });
      expect(callHeader(stub.calls[0], 'Authorization')).toBe('Bearer or-key-123');
      expect(callHeader(stub.calls[0], 'Content-Type')).toBe('application/json');
    });
  });

  describe('formatTools', () => {
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

  describe('request', () => { // new in Step 0
    it('posts to the hardcoded OpenRouter URL with the default model', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', { apiKey: 'k' });
      const call = stub.calls[0];
      expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(call.init.method).toBe('POST');
      expect(call.body).toEqual({
        model: 'google/gemini-2.0-flash-001', // BC-01 changes the default to openrouter/auto
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
        stream: true,
      });
    });

    it('ignores baseUrl and honours model', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', { apiKey: 'k', baseUrl: 'https://proxy.test', model: 'vendor/model' });
      // BC-09 makes OpenRouter honour baseUrl.
      expect(stub.calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(stub.calls[0].body.model).toBe('vendor/model');
    });

    it('sends the literal "Bearer undefined" when no key is configured', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', {});
      expect(callHeader(stub.calls[0], 'Authorization')).toBe('Bearer undefined');
    });

    it('formats assistant tool calls and tool results', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('openrouter', { apiKey: 'k' }, fullHistory);
      expect(stub.calls[0].body.messages).toEqual(fullHistoryWire);
    });
  });
});

// ── CodestralProvider ───────────────────────────────────────────────

describe('CodestralProvider', () => {
  describe('buildHeaders', () => {
    it('uses Bearer authorization', async () => {
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('codestral', { apiKey: 'cs-key-456' });
      expect(callHeader(stub.calls[0], 'Authorization')).toBe('Bearer cs-key-456');
      expect(callHeader(stub.calls[0], 'Content-Type')).toBe('application/json');
    });
  });

  describe('formatTools', () => {
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

  describe('request', () => { // new in Step 0
    it('posts to api.mistral.ai with mistral-large-latest by default', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('codestral', { apiKey: 'k' });
      // BC-08 changes the Codestral host and default model.
      expect(stub.calls[0].url).toBe('https://api.mistral.ai/v1/chat/completions');
      expect(stub.calls[0].body).toEqual({
        model: 'mistral-large-latest',
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
        stream: true,
      });
    });

    it('honours baseUrl and model', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('codestral', { apiKey: 'k', baseUrl: 'https://codestral.mistral.ai', model: 'codestral-latest' });
      expect(stub.calls[0].url).toBe('https://codestral.mistral.ai/v1/chat/completions');
      expect(stub.calls[0].body.model).toBe('codestral-latest');
    });

    it('formats assistant tool calls and tool results', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('openai-chat'));
      await runWith('codestral', { apiKey: 'k' }, fullHistory);
      expect(stub.calls[0].body.messages).toEqual(fullHistoryWire);
    });
  });
});

// ── Tool call buffering (OpenAI-compatible: OpenRouter & Codestral) ─

describe('OpenAI-compatible tool call buffering', () => {
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

  it('should emit top-level usage events when no choices present', async () => {
    stubFetch(() => sseResponse([chunk({ usage: { prompt_tokens: 42, completion_tokens: 7 } })]));
    const events = await runWith('openrouter', { apiKey: 'test' });

    // BC-12 changes usage handling for a usage-only stream.
    expect(events).toEqual([
      { type: 'usage', inputTokens: 42, outputTokens: 7 },
    ]);
  });

  it('yields every usage-bearing chunk, not just the last', async () => { // new in Step 0
    stubFetch(() => sseResponse([
      chunk({ choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      { data: '[DONE]' },
    ]));
    // BC-12 emits usage once.
    expect(await runWith('openrouter', { apiKey: 'k' })).toEqual([
      { type: 'text', text: 'a' },
      { type: 'usage', inputTokens: 5, outputTokens: 1 },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
  });

  it('flushes buffered tool calls on finish_reason stop', async () => { // new in Step 0
    stubFetch(() => sseResponse([
      toolDelta([{ index: 0, id: 'c1', function: { name: 't', arguments: '{"k":1}' } }]),
      finish('stop'),
      { data: '[DONE]' },
    ]));
    expect(await runWith('codestral', { apiKey: 'k' })).toEqual([{ type: 'tool_use', id: 'c1', name: 't', input: { k: 1 } }]);
  });

  it('drops buffered tool calls when the stream ends without [DONE] or a finish_reason', async () => { // new in Step 0
    stubFetch(() => sseResponse([
      chunk({ choices: [{ delta: { content: 'thinking' } }] }),
      toolDelta([{ index: 0, id: 'lost', function: { name: 't', arguments: '{}' } }]),
    ]));
    // BC-12 makes EOF lenient (flushes complete calls; a truncated call throws OutputLimitError).
    expect(await runWith('openrouter', { apiKey: 'k' })).toEqual([{ type: 'text', text: 'thinking' }]);
  });

  it('treats a missing index as 0 and restarts the buffer whenever an id repeats', async () => { // new in Step 0
    stubFetch(() => sseResponse([
      toolDelta([{ id: 'same', function: { name: 'echo', arguments: '{"v":' } }]),
      toolDelta([{ id: 'same', function: { arguments: '"x"}' } }]),
      finish('tool_calls'),
    ]));
    // BC-12 keys buffers by index and keeps appending when the id repeats. Today the second
    // fragment replaces the first (and its name), so the call loses its name and input.
    expect(await runWith('openrouter', { apiKey: 'k' })).toEqual([{ type: 'tool_use', id: 'same', name: '', input: {} }]);
  });

  it('ignores continuation fragments for an index that was never started', async () => { // new in Step 0
    stubFetch(() => sseResponse([
      toolDelta([{ index: 3, function: { name: 'orphan', arguments: '{}' } }]),
      finish('tool_calls'),
    ]));
    expect(await runWith('openrouter', { apiKey: 'k' })).toEqual([]);
  });

  it('reassembles a chunk split across network reads, with CRLF endings', async () => { // new in Step 0
    const line = 'data: {"choices":[{"delta":{"content":"split ok"}}]}\r\n\r\n';
    stubFetch(() => chunkedResponse([line.slice(0, 15), line.slice(15, line.length - 3), line.slice(line.length - 3), 'data: [DONE]\r\n\r\n']));
    expect(await runWith('openrouter', { apiKey: 'k' })).toEqual([{ type: 'text', text: 'split ok' }]);
  });

  it('stops quietly when aborted mid-stream and drops a half-built tool call', async () => { // new in Step 0
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

  it('rejects with the abort error when the signal is already aborted', async () => { // new in Step 0
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
    // BC-06 / BC-17 replace this plain Error with a typed AuthError.
    await expect(p).rejects.toThrow('OpenRouter API error (401): Unauthorized');
  });

  it('Codestral should throw on 429', async () => {
    stubFetch(() => textResponse('rate limited', 429, { 'x-ratelimit-remaining-requests': '0' }));
    const p = runWith('codestral', { apiKey: 'test' });
    await expect(p).rejects.toThrow(/429/);
    await expect(p).rejects.toMatchObject({ name: 'RateLimitError', message: 'Codestral rate limited (429)' });
  });

  it('OpenRouter throws a RateLimitError carrying the response headers on 429', async () => { // new in Step 0
    stubFetch(() => textResponse('slow', 429, { 'x-ratelimit-remaining-requests': '0' }));
    const err: any = await runWith('openrouter', { apiKey: 'k' }).catch((e) => e);
    expect(err.name).toBe('RateLimitError');
    expect(err.message).toBe('OpenRouter rate limited (429)');
    expect(err.headers.get('x-ratelimit-remaining-requests')).toBe('0');
  });

  it('Gemini should throw on 403 with error body', async () => {
    stubFetch(() => textResponse('{"error":"forbidden"}', 403));
    const p = runWith('gemini', { apiKey: 'bad' });
    await expect(p).rejects.toThrow(/403/);
    await expect(p).rejects.toThrow('Gemini API error (403): {"error":"forbidden"}');
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

  it('passes a network failure from fetch through unchanged', async () => { // new in Step 0
    const boom = new TypeError('fetch failed');
    stubFetch(() => { throw boom; });
    // BC-06 classifies connection failures so the router can fall back.
    await expect(runWith('openrouter', { apiKey: 'k' })).rejects.toBe(boom);
  });
});
