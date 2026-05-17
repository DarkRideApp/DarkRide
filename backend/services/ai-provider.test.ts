import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createProvider,
  AnthropicProvider,
  GeminiProvider,
  OllamaProvider,
  OpenRouterProvider,
  CodestralProvider,
} from './ai-provider';
import type { AiToolDefinition, AiStreamEvent, AiMessage } from '../../shared/types/ai-chat';

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a ReadableStream from a raw string (simulates response body). */
function streamFromString(data: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

/** Build a ReadableStream that delivers chunks one-by-one with micro-task yields. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Format SSE events into the wire format string.
 * Each event ends with a blank line (\n\n) as required by the SSE spec.
 */
function sseBlock(events: Array<{ event?: string; data: string }>): string {
  return events
    .map((e) => {
      const lines: string[] = [];
      if (e.event) lines.push(`event: ${e.event}`);
      lines.push(`data: ${e.data}`);
      // Two trailing newlines: one to end the data line, one blank line to delimit the event
      return lines.join('\n') + '\n\n';
    })
    .join('');
}

/** Collect all events from an async iterable. */
async function collectEvents(iter: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const e of iter) {
    events.push(e);
  }
  return events;
}

/** Minimal tools array for request tests. */
const minimalTools: AiToolDefinition[] = [];
const minimalMessages: AiMessage[] = [{ role: 'user', content: 'hello' }];

// ── Factory ──────────────────────────────────────────────────────────

describe('createProvider', () => {
  it('returns AnthropicProvider for "anthropic"', () => {
    const provider = createProvider('anthropic', { apiKey: 'test-key' });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe('anthropic');
  });

  it('returns GeminiProvider for "gemini"', () => {
    const provider = createProvider('gemini', { apiKey: 'test-key' });
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.name).toBe('gemini');
  });

  it('returns OllamaProvider for "ollama"', () => {
    const provider = createProvider('ollama', { baseUrl: 'http://localhost:11434' });
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe('ollama');
  });

  it('returns OpenRouterProvider for "openrouter"', () => {
    const provider = createProvider('openrouter', { apiKey: 'test-key' });
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.name).toBe('openrouter');
  });

  it('returns CodestralProvider for "codestral"', () => {
    const provider = createProvider('codestral', { apiKey: 'test-key' });
    expect(provider).toBeInstanceOf(CodestralProvider);
    expect(provider.name).toBe('codestral');
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
    const configs: Array<{ name: string; config: Record<string, any>; cls: any }> = [
      { name: 'anthropic', config: { apiKey: 'k' }, cls: AnthropicProvider },
      { name: 'gemini', config: { apiKey: 'k' }, cls: GeminiProvider },
      { name: 'ollama', config: { baseUrl: 'http://localhost:11434' }, cls: OllamaProvider },
      { name: 'openrouter', config: { apiKey: 'k' }, cls: OpenRouterProvider },
      { name: 'codestral', config: { apiKey: 'k' }, cls: CodestralProvider },
    ];
    for (const { name, config, cls } of configs) {
      const provider = createProvider(name, config);
      expect(provider).toBeInstanceOf(cls);
      expect(provider.name).toBe(name);
    }
  });
});

// ── AnthropicProvider ────────────────────────────────────────────────

describe('AnthropicProvider', () => {
  describe('buildHeaders', () => {
    it('uses x-api-key authorization', () => {
      const provider = new AnthropicProvider({ apiKey: 'sk-ant-123' });
      const headers = provider.buildHeaders();
      expect(headers['x-api-key']).toBe('sk-ant-123');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('formatTools', () => {
    it('uses Anthropic input_schema format', () => {
      const provider = new AnthropicProvider({ apiKey: 'test' });
      const formatted = provider.formatTools([
        {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
          context: ['test'],
        },
      ]);

      expect(formatted[0]).toEqual({
        name: 'test_tool',
        description: 'A test tool',
        input_schema: { type: 'object', properties: { x: { type: 'number' } } },
      });
    });

    it('adds type:object wrapper defensively when missing', () => {
      const provider = new AnthropicProvider({ apiKey: 'test' });
      const formatted = provider.formatTools([
        {
          name: 'bare_tool',
          description: 'No type field',
          inputSchema: { properties: { y: { type: 'string' } } },
          context: ['test'],
        },
      ]);

      expect(formatted[0].input_schema.type).toBe('object');
      expect(formatted[0].input_schema.properties).toEqual({ y: { type: 'string' } });
    });
  });

  describe('streaming', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('should parse text and usage events from Anthropic SSE stream', async () => {
      const sseData = sseBlock([
        {
          event: 'message_start',
          data: JSON.stringify({
            type: 'message_start',
            message: { usage: { input_tokens: 10 } },
          }),
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hello' },
          }),
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: ' world' },
          }),
        },
        {
          event: 'message_delta',
          data: JSON.stringify({
            type: 'message_delta',
            usage: { output_tokens: 5 },
          }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(streamFromString(sseData), { status: 200 }),
      );

      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      const events = await collectEvents(
        provider.createStreamingRequest(minimalMessages, 'system', minimalTools),
      );

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0]).toMatchObject({ type: 'text', text: 'Hello' });
      expect(textEvents[1]).toMatchObject({ type: 'text', text: ' world' });

      const usageEvents = events.filter((e) => e.type === 'usage');
      expect(usageEvents).toHaveLength(2);
      expect(usageEvents[0]).toMatchObject({ inputTokens: 10, outputTokens: 0 });
      expect(usageEvents[1]).toMatchObject({ inputTokens: 0, outputTokens: 5 });
    });

    it('should parse tool_use events from Anthropic SSE stream', async () => {
      const sseData = sseBlock([
        {
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'toolu_123', name: 'get_weather' },
          }),
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"cit' },
          }),
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: 'y":"NYC"}' },
          }),
        },
        {
          event: 'content_block_stop',
          data: JSON.stringify({ type: 'content_block_stop' }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(streamFromString(sseData), { status: 200 }),
      );

      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      const events = await collectEvents(
        provider.createStreamingRequest(minimalMessages, 'system', minimalTools),
      );

      const toolEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]).toMatchObject({
        type: 'tool_use',
        id: 'toolu_123',
        name: 'get_weather',
        input: { city: 'NYC' },
      });
    });

    it('should throw on 429', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('rate limited', { status: 429 }),
      );

      const provider = new AnthropicProvider({ apiKey: 'test' });
      await expect(
        collectEvents(
          provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
        ),
      ).rejects.toThrow(/429/);
    });

    it('should throw when response body is null', async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'body', { value: null });

      fetchSpy.mockResolvedValueOnce(response);

      const provider = new AnthropicProvider({ apiKey: 'test' });
      await expect(
        collectEvents(
          provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
        ),
      ).rejects.toThrow(/no body/);
    });

    it('should format tool_result messages correctly', async () => {
      const sseData = sseBlock([
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'ok' },
          }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(streamFromString(sseData), { status: 200 }),
      );

      const messages: AiMessage[] = [
        { role: 'user', content: 'use a tool' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc1', name: 'get_info', input: { q: 'test' } },
          ],
        },
        { role: 'tool_result', toolUseId: 'tc1', content: 'tool output here' },
      ];

      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      await collectEvents(
        provider.createStreamingRequest(messages, 'system', minimalTools),
      );

      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(call[1]!.body as string);

      // tool_result becomes user role with tool_result content block
      const toolResultMsg = body.messages[2];
      expect(toolResultMsg.role).toBe('user');
      expect(toolResultMsg.content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'tc1',
        content: 'tool output here',
      });

      // Assistant message has tool_use content block
      const assistantMsg = body.messages[1];
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.content[0]).toEqual({
        type: 'tool_use',
        id: 'tc1',
        name: 'get_info',
        input: { q: 'test' },
      });

      // System prompt is sent as top-level field
      expect(body.system).toBe('system');
    });

    it('should merge consecutive tool_results into a single user message', async () => {
      const sseData = sseBlock([
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'done' },
          }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(streamFromString(sseData), { status: 200 }),
      );

      const messages: AiMessage[] = [
        { role: 'user', content: 'use tools' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc1', name: 'tool_a', input: {} },
            { type: 'tool_use', id: 'tc2', name: 'tool_b', input: {} },
          ],
        },
        { role: 'tool_result', toolUseId: 'tc1', content: 'result 1' },
        { role: 'tool_result', toolUseId: 'tc2', content: 'result 2' },
      ];

      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      await collectEvents(
        provider.createStreamingRequest(messages, 'system', minimalTools),
      );

      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(call[1]!.body as string);

      // Should be 3 messages: user, assistant, user (merged tool_results)
      expect(body.messages).toHaveLength(3);

      const toolResultMsg = body.messages[2];
      expect(toolResultMsg.role).toBe('user');
      expect(toolResultMsg.content).toHaveLength(2);
      expect(toolResultMsg.content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'tc1',
        content: 'result 1',
      });
      expect(toolResultMsg.content[1]).toEqual({
        type: 'tool_result',
        tool_use_id: 'tc2',
        content: 'result 2',
      });
    });

    it('should filter empty text blocks from assistant messages', async () => {
      const sseData = sseBlock([
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'ok' },
          }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(streamFromString(sseData), { status: 200 }),
      );

      const messages: AiMessage[] = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 'tc1', name: 'my_tool', input: { a: 1 } },
          ],
        },
        { role: 'tool_result', toolUseId: 'tc1', content: 'output' },
      ];

      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      await collectEvents(
        provider.createStreamingRequest(messages, 'system', minimalTools),
      );

      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(call[1]!.body as string);

      // Assistant content should only have the tool_use block (empty text filtered)
      const assistantMsg = body.messages[1];
      expect(assistantMsg.content).toHaveLength(1);
      expect(assistantMsg.content[0].type).toBe('tool_use');
    });
  });
});

// ── GeminiProvider ───────────────────────────────────────────────────

describe('GeminiProvider', () => {
  describe('buildHeaders', () => {
    it('includes Content-Type', () => {
      const provider = new GeminiProvider({ apiKey: 'test' });
      const headers = provider.buildHeaders();
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('formatTools', () => {
    it('uses parameters field (Gemini format)', () => {
      const provider = new GeminiProvider({ apiKey: 'test' });
      const formatted = provider.formatTools([
        {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
          context: ['test'],
        },
      ]);

      expect(formatted[0]).toEqual({
        name: 'test_tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: { x: { type: 'number' } } },
      });
    });
  });

  describe('formatMessages (tool results)', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('should format tool results as functionResponse parts', async () => {
      const sseData = sseBlock([
        {
          data: JSON.stringify({
            candidates: [
              { content: { parts: [{ text: 'response' }] } },
            ],
          }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(streamFromString(sseData), { status: 200 }),
      );

      const messages: AiMessage[] = [
        { role: 'user', content: 'use a tool' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc1', name: 'get_info', input: { q: 'test' } },
          ],
        },
        { role: 'tool_result', toolUseId: 'tc1', content: 'tool output here' },
      ];

      const provider = new GeminiProvider({ apiKey: 'test-key' });
      await collectEvents(
        provider.createStreamingRequest(messages, 'system', minimalTools),
      );

      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(call[1]!.body as string);

      // tool_result message becomes a "user" role with functionResponse part
      const toolResultMsg = body.contents[2];
      expect(toolResultMsg.role).toBe('user');
      expect(toolResultMsg.parts[0].functionResponse).toEqual({
        name: 'tool_result',
        response: { result: 'tool output here' },
      });

      // Assistant message becomes "model" role with functionCall part
      const assistantMsg = body.contents[1];
      expect(assistantMsg.role).toBe('model');
      expect(assistantMsg.parts[0].functionCall).toEqual({
        name: 'get_info',
        args: { q: 'test' },
      });
    });
  });
});

// ── OllamaProvider ──────────────────────────────────────────────────

describe('OllamaProvider', () => {
  describe('buildHeaders', () => {
    it('includes Content-Type', () => {
      const provider = new OllamaProvider({});
      const headers = provider.buildHeaders();
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('formatTools', () => {
    it('uses OpenAI function format', () => {
      const provider = new OllamaProvider({});
      const formatted = provider.formatTools([
        {
          name: 'my_tool',
          description: 'Does things',
          inputSchema: { type: 'object' },
          context: ['all'],
        },
      ]);

      expect(formatted[0]).toEqual({
        type: 'function',
        function: {
          name: 'my_tool',
          description: 'Does things',
          parameters: { type: 'object' },
        },
      });
    });
  });

  describe('formatMessages (empty assistant content)', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('should handle assistant message with empty text array', async () => {
      // NDJSON stream for Ollama
      const ndjson = JSON.stringify({ message: { content: 'ok' } }) + '\n' +
        JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 3 }) + '\n';

      fetchSpy.mockResolvedValueOnce(
        new Response(streamFromString(ndjson), { status: 200 }),
      );

      const messages: AiMessage[] = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '' }], // empty text block
        },
        { role: 'user', content: 'continue' },
      ];

      const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
      const events = await collectEvents(
        provider.createStreamingRequest(messages, 'system', minimalTools),
      );

      // Verify the request body was formatted correctly
      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(call[1]!.body as string);
      const assistantEntry = body.messages[2]; // [system, user, assistant, user]
      expect(assistantEntry.role).toBe('assistant');
      expect(assistantEntry.content).toBe(''); // empty text concatenated

      // Stream produced events
      expect(events.some((e) => e.type === 'text')).toBe(true);
    });
  });
});

// ── OpenRouterProvider ──────────────────────────────────────────────

describe('OpenRouterProvider', () => {
  describe('buildHeaders', () => {
    it('uses Bearer authorization', () => {
      const provider = new OpenRouterProvider({ apiKey: 'or-key-123' });
      const headers = provider.buildHeaders();
      expect(headers['Authorization']).toBe('Bearer or-key-123');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('formatTools', () => {
    it('uses OpenAI function format', () => {
      const provider = new OpenRouterProvider({ apiKey: 'test' });
      const formatted = provider.formatTools([
        {
          name: 'tool_a',
          description: 'Tool A',
          inputSchema: { type: 'object', properties: {} },
          context: ['test'],
        },
      ]);

      expect(formatted[0]).toEqual({
        type: 'function',
        function: {
          name: 'tool_a',
          description: 'Tool A',
          parameters: { type: 'object', properties: {} },
        },
      });
    });
  });
});

// ── CodestralProvider ───────────────────────────────────────────────

describe('CodestralProvider', () => {
  describe('buildHeaders', () => {
    it('uses Bearer authorization', () => {
      const provider = new CodestralProvider({ apiKey: 'cs-key-456' });
      const headers = provider.buildHeaders();
      expect(headers['Authorization']).toBe('Bearer cs-key-456');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('formatTools', () => {
    it('uses OpenAI function format', () => {
      const provider = new CodestralProvider({ apiKey: 'test' });
      const formatted = provider.formatTools([
        {
          name: 'tool_b',
          description: 'Tool B',
          inputSchema: { type: 'object' },
          context: ['test'],
        },
      ]);

      expect(formatted[0]).toEqual({
        type: 'function',
        function: {
          name: 'tool_b',
          description: 'Tool B',
          parameters: { type: 'object' },
        },
      });
    });
  });
});

// ── Tool call buffering (OpenAI-compatible: OpenRouter & Codestral) ─

describe('OpenAI-compatible tool call buffering', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should buffer incremental tool call arguments correctly', async () => {
    // Three chunks building up the arguments JSON incrementally
    const sseData = sseBlock([
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'my_tool', arguments: '{"ke' } },
                ],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'y":"va' } },
                ],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'lue"}' } },
                ],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        }),
      },
    ]);

    fetchSpy.mockResolvedValueOnce(
      new Response(streamFromString(sseData), { status: 200 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'test' });
    const events = await collectEvents(
      provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
    );

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
    const sseData = sseBlock([
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_a', type: 'function', function: { name: 'tool_one', arguments: '{"x":' } },
                  { index: 1, id: 'call_b', type: 'function', function: { name: 'tool_two', arguments: '{"y":' } },
                ],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '1}' } },
                  { index: 1, function: { arguments: '2}' } },
                ],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        }),
      },
    ]);

    fetchSpy.mockResolvedValueOnce(
      new Response(streamFromString(sseData), { status: 200 }),
    );

    const provider = new CodestralProvider({ apiKey: 'test' });
    const events = await collectEvents(
      provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
    );

    const toolEvents = events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(2);

    // Find each by id
    const callA = toolEvents.find((e) => e.type === 'tool_use' && e.id === 'call_a');
    const callB = toolEvents.find((e) => e.type === 'tool_use' && e.id === 'call_b');
    expect(callA).toMatchObject({ name: 'tool_one', input: { x: 1 } });
    expect(callB).toMatchObject({ name: 'tool_two', input: { y: 2 } });
  });

  it('should yield empty input for malformed tool arguments', async () => {
    const sseData = sseBlock([
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_bad', type: 'function', function: { name: 'broken_tool', arguments: '{bad json' } },
                ],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        }),
      },
    ]);

    fetchSpy.mockResolvedValueOnce(
      new Response(streamFromString(sseData), { status: 200 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'test' });
    const events = await collectEvents(
      provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
    );

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
    const sseData = sseBlock([
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_done', type: 'function', function: { name: 'done_tool', arguments: '{"a":1}' } },
                ],
              },
            },
          ],
        }),
      },
    ]) + 'data: [DONE]\n\n';

    fetchSpy.mockResolvedValueOnce(
      new Response(streamFromString(sseData), { status: 200 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'test' });
    const events = await collectEvents(
      provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
    );

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
    const sseData = sseBlock([
      {
        data: JSON.stringify({
          choices: [{ delta: { content: 'hi' } }],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 25 },
        }),
      },
    ]);

    fetchSpy.mockResolvedValueOnce(
      new Response(streamFromString(sseData), { status: 200 }),
    );

    const provider = new CodestralProvider({ apiKey: 'test' });
    const events = await collectEvents(
      provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
    );

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: 'usage',
      inputTokens: 100,
      outputTokens: 25,
    });
  });

  it('should emit top-level usage events when no choices present', async () => {
    const sseData = sseBlock([
      {
        data: JSON.stringify({
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        }),
      },
    ]);

    fetchSpy.mockResolvedValueOnce(
      new Response(streamFromString(sseData), { status: 200 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'test' });
    const events = await collectEvents(
      provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
    );

    expect(events).toEqual([
      { type: 'usage', inputTokens: 42, outputTokens: 7 },
    ]);
  });
});

// ── Error response tests (provider-agnostic patterns) ───────────────

describe('Error responses across providers', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('OpenRouter should throw on 401', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'bad' });
    await expect(
      collectEvents(
        provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
      ),
    ).rejects.toThrow(/401/);
  });

  it('Codestral should throw on 429', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('rate limited', { status: 429 }),
    );

    const provider = new CodestralProvider({ apiKey: 'test' });
    await expect(
      collectEvents(
        provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
      ),
    ).rejects.toThrow(/429/);
  });

  it('Gemini should throw on 403 with error body', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"error":"forbidden"}', { status: 403 }),
    );

    const provider = new GeminiProvider({ apiKey: 'bad' });
    await expect(
      collectEvents(
        provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
      ),
    ).rejects.toThrow(/403/);
  });

  it('Ollama should throw on 500 with error body', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('model not found', { status: 500 }),
    );

    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
    await expect(
      collectEvents(
        provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
      ),
    ).rejects.toThrow(/500/);
  });

  it('OpenRouter should throw when response body is null', async () => {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, 'body', { value: null });

    fetchSpy.mockResolvedValueOnce(response);

    const provider = new OpenRouterProvider({ apiKey: 'test' });
    await expect(
      collectEvents(
        provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
      ),
    ).rejects.toThrow(/no body/);
  });

  it('Codestral should throw when response body is null', async () => {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, 'body', { value: null });

    fetchSpy.mockResolvedValueOnce(response);

    const provider = new CodestralProvider({ apiKey: 'test' });
    await expect(
      collectEvents(
        provider.createStreamingRequest(minimalMessages, 'sys', minimalTools),
      ),
    ).rejects.toThrow(/no body/);
  });
});
