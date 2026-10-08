// Characterization: Anthropic behind createProvider, observed only through the wire request it
// sends and the events it yields. First written against the previous single-file implementation;
// every assertion that changed with the dialect rewrite says what the old behaviour was.
// fixtures: hand-written from https://docs.anthropic.com/en/api/messages-streaming
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProvider } from '../registry';
import { sseResponse, chunkedResponse, textResponse, okStream, stubFetch, callHeader, collect } from '../test-helpers';
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';

afterEach(() => vi.unstubAllGlobals());

const msgs: AiMessage[] = [{ role: 'user', content: 'hello' }];
const noTools: AiToolDefinition[] = [];

const ev = (type: string, payload: Record<string, unknown>) => ({ event: type, data: JSON.stringify({ type, ...payload }) });
const textDelta = (text: string) => ev('content_block_delta', { delta: { type: 'text_delta', text } });
const stop = () => ev('message_stop', {});

const anthropic = (cfg: Record<string, any> = { apiKey: 'test-key' }) => createProvider('anthropic', cfg);
const run = (messages: AiMessage[] = msgs, system = 'system', tools: AiToolDefinition[] = noTools, cfg?: Record<string, any>) =>
  collect(anthropic(cfg).createStreamingRequest(messages, system, tools));

describe('AnthropicProvider', () => {
  describe('request', () => {
    it('uses x-api-key authorization', async () => {
      const stub = stubFetch(() => okStream('anthropic'));
      await run(msgs, 'system', noTools, { apiKey: 'sk-test-placeholder' });
      const call = stub.calls[0];
      expect(callHeader(call, 'x-api-key')).toBe('sk-test-placeholder');
      expect(callHeader(call, 'anthropic-version')).toBe('2023-06-01');
      expect(callHeader(call, 'Content-Type')).toBe('application/json');
      expect(callHeader(call, 'authorization')).toBeUndefined();
      expect(call.init.method).toBe('POST');
    });

    it('sends the Messages API body to the default host and model', async () => {
      const stub = stubFetch(() => okStream('anthropic'));
      await run(msgs, 'sys prompt');
      const call = stub.calls[0];
      expect(call.url).toBe('https://api.anthropic.com/v1/messages');
      expect(call.body).toEqual({
        model: 'claude-sonnet-5-5', // was claude-sonnet-4-20250514; the blank-model default moved to the current Sonnet
        max_tokens: 16000, // was 8192; thinking-on models count thinking toward this limit
        system: 'sys prompt',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        cache_control: { type: 'ephemeral' }, // new: the agent path turns on prompt caching
      });
    });

    it('honours model and baseUrl from config', async () => {
      const stub = stubFetch(() => okStream('anthropic'));
      await run(msgs, 's', noTools, { apiKey: 'k', model: 'm1', baseUrl: 'https://proxy.test' });
      expect(stub.calls[0].url).toBe('https://proxy.test/v1/messages');
      expect(stub.calls[0].body.model).toBe('m1');
    });

    it('sends an empty x-api-key when no key is configured', async () => {
      // Unchanged on purpose: the key is required for Anthropic, so the connection test refuses a keyless
      // provider before any request, and a chat request without one gets a 401 that is now an AuthError.
      const stub = stubFetch(() => okStream('anthropic'));
      await run(msgs, 's', noTools, {});
      expect(callHeader(stub.calls[0], 'x-api-key')).toBe('');
    });

    it('omits tools when none are given', async () => {
      const stub = stubFetch(() => okStream('anthropic'));
      await run();
      expect(stub.calls[0].body).not.toHaveProperty('tools');
    });
  });

  describe('formatTools', () => {
    it('uses Anthropic input_schema format', async () => {
      const stub = stubFetch(() => okStream('anthropic'));
      await run(msgs, 's', [
        {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
          context: ['test'],
        },
      ]);
      expect(stub.calls[0].body.tools).toEqual([
        {
          name: 'test_tool',
          description: 'A test tool',
          input_schema: { type: 'object', properties: { x: { type: 'number' } } },
        },
      ]);
    });

    it('adds type:object wrapper defensively when missing', async () => {
      const stub = stubFetch(() => okStream('anthropic'));
      await run(msgs, 's', [
        {
          name: 'bare_tool',
          description: 'No type field',
          inputSchema: { properties: { y: { type: 'string' } } },
          context: ['test'],
        },
      ]);
      const [tool] = stub.calls[0].body.tools;
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toEqual({ y: { type: 'string' } });
    });
  });

  describe('streaming', () => {
    it('should parse text and usage events from Anthropic SSE stream', async () => {
      stubFetch(() => sseResponse([
        ev('message_start', { message: { usage: { input_tokens: 10 } } }),
        textDelta('Hello'),
        textDelta(' world'),
        ev('message_delta', { usage: { output_tokens: 5 } }),
        stop(),
      ]));
      const events = await run();

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0]).toMatchObject({ type: 'text', text: 'Hello' });
      expect(textEvents[1]).toMatchObject({ type: 'text', text: ' world' });

      const usageEvents = events.filter((e) => e.type === 'usage');
      expect(usageEvents).toHaveLength(2);
      expect(usageEvents[0]).toMatchObject({ inputTokens: 10, outputTokens: 0 });
      // message_delta output_tokens is cumulative; the dialect emits the difference since the last report.
      expect(usageEvents[1]).toMatchObject({ inputTokens: 0, outputTokens: 5 });

      // Full ordered sequence, so a reordering or an extra event is caught too.
      expect(events).toEqual([
        { type: 'usage', inputTokens: 10, outputTokens: 0 },
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
        { type: 'usage', inputTokens: 0, outputTokens: 5 },
      ]);
    });

    it('rejects a destructively truncated Anthropic stream', async () => {
      // Simulates a VPN or proxy closing the stream before Anthropic's
      // terminal message_stop event.
      stubFetch(() => sseResponse([
        ev('message_start', { message: { usage: { input_tokens: 10 } } }),
        textDelta('Only half an answer'),
      ]));
      await expect(run()).rejects.toThrow('Anthropic stream ended before message_stop');
    });

    it('rejects an empty Anthropic stream', async () => {
      stubFetch(() => textResponse('', 200));
      await expect(run()).rejects.toThrow('Anthropic stream ended before message_stop');
    });

    it('reports an Anthropic max-token cutoff', async () => {
      stubFetch(() => sseResponse([
        ev('message_delta', { delta: { stop_reason: 'max_tokens' } }),
        stop(),
      ]));
      await expect(run()).rejects.toThrow('Anthropic response reached its output token limit');
    });

    it('reports an Anthropic context-window cutoff', async () => {
      stubFetch(() => sseResponse([
        ev('message_delta', { delta: { stop_reason: 'model_context_window_exceeded' } }),
        stop(),
      ]));
      await expect(run()).rejects.toThrow('Anthropic response reached its context window limit');
    });

    it('treats a refusal stop as a normal end of stream, with a visible message', async () => {
      stubFetch(() => sseResponse([
        ev('message_delta', { delta: { stop_reason: 'refusal' } }),
        stop(),
      ]));
      // Was a silent empty reply; a refusal now shows a message and still ends without an error.
      expect(await run()).toEqual([{ type: 'text', text: 'Claude declined this request.' }]);
    });

    it('surfaces an Anthropic SSE error event', async () => {
      stubFetch(() => sseResponse([
        ev('error', { error: { type: 'overloaded_error', message: 'Capacity is temporarily unavailable' } }),
      ]));
      // Same message as before; the error is now an OverloadedError, so the router can fall back.
      const err: any = await run().catch((e) => e);
      expect(err.message).toBe('Anthropic stream error: Capacity is temporarily unavailable');
      expect(err.name).toBe('OverloadedError');
    });

    it('surfaces an in-stream error after content has streamed', async () => {
      stubFetch(() => sseResponse([
        ev('message_start', { message: { usage: { input_tokens: 1 } } }),
        textDelta('partial'),
        ev('error', { error: { type: 'api_error' } }),
      ]));
      const seen: AiStreamEvent[] = [];
      await expect((async () => {
        for await (const e of anthropic().createStreamingRequest(msgs, 's', noTools)) seen.push(e);
      })()).rejects.toThrow('Anthropic stream error: api_error');
      expect(seen).toEqual([
        { type: 'usage', inputTokens: 1, outputTokens: 0 },
        { type: 'text', text: 'partial' },
      ]);
    });

    it('should parse tool_use events from Anthropic SSE stream', async () => {
      stubFetch(() => sseResponse([
        ev('content_block_start', { content_block: { type: 'tool_use', id: 'toolu_123', name: 'get_weather' } }),
        ev('content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{"cit' } }),
        ev('content_block_delta', { delta: { type: 'input_json_delta', partial_json: 'y":"NYC"}' } }),
        ev('content_block_stop', {}),
        stop(),
      ]));
      const events = await run();

      const toolEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]).toMatchObject({
        type: 'tool_use',
        id: 'toolu_123',
        name: 'get_weather',
        input: { city: 'NYC' },
      });
    });

    it('yields empty input for a tool_use block with unparseable JSON', async () => {
      stubFetch(() => sseResponse([
        ev('content_block_start', { content_block: { type: 'tool_use', id: 'toolu_bad', name: 'broken' } }),
        ev('content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{"a":' } }),
        ev('content_block_stop', {}),
        stop(),
      ]));
      expect(await run()).toEqual([{ type: 'tool_use', id: 'toolu_bad', name: 'broken', input: {} }]);
    });

    it('reassembles an event whose JSON is split across network chunks', async () => {
      const full = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"split ok"}}\n\n';
      const cut = full.indexOf('"text":"') + 4;
      stubFetch(() => chunkedResponse([
        full.slice(0, 10),
        full.slice(10, cut),
        full.slice(cut),
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]));
      expect(await run()).toEqual([{ type: 'text', text: 'split ok' }]);
    });

    it('parses CRLF line endings, including a CRLF split across chunks', async () => {
      stubFetch(() => chunkedResponse([
        'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"crlf"}}\r',
        '\n\r\n',
        ': keep-alive comment\r\n\r\n',
        'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
      ]));
      expect(await run()).toEqual([{ type: 'text', text: 'crlf' }]);
    });

    it('should throw on 429', async () => {
      stubFetch(() => textResponse('rate limited', 429, { 'anthropic-ratelimit-requests-remaining': '0' }));
      const p = run(msgs, 'sys');
      await expect(p).rejects.toThrow(/429/);
      await expect(p).rejects.toMatchObject({ name: 'RateLimitError' });
      const err: any = await p.catch((e) => e);
      // Was exactly "Anthropic rate limited (429)"; a 429 now uses the common error wording with the body text.
      expect(err.message).toBe('Anthropic API error (429): rate limited');
      expect(err.headers.get('anthropic-ratelimit-requests-remaining')).toBe('0');
    });

    it('throws on non-2xx with status and the provider message', async () => {
      stubFetch(() => textResponse('{"error":{"message":"bad key"}}', 401));
      // Was a plain Error carrying the raw JSON body. Now the provider's own message is extracted from the
      // JSON, and a 401 is an AuthError, so the router can fall back to the next model.
      const err: any = await run().catch((e) => e);
      expect(err.message).toBe('Anthropic API error (401): bad key');
      expect(err.name).toBe('AuthError');
      expect(err.status).toBe(401);
    });

    it('should throw when response body is null', async () => {
      stubFetch(() => new Response(null, { status: 200 }));
      await expect(run(msgs, 'sys')).rejects.toThrow(/no body/);
      await expect(run(msgs, 'sys')).rejects.toThrow('Anthropic response has no body');
    });

    it('rejects with the abort error when the signal is already aborted', async () => {
      stubFetch(() => okStream('anthropic'));
      const ac = new AbortController();
      ac.abort();
      await expect(collect(anthropic().createStreamingRequest(msgs, 's', noTools, { signal: ac.signal })))
        .rejects.toMatchObject({ name: 'AbortError' });
    });

    it('ends quietly without the truncation error when aborted mid-stream', async () => {
      stubFetch(() => chunkedResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"first"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"never seen"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]));
      const ac = new AbortController();
      const seen: AiStreamEvent[] = [];
      for await (const e of anthropic().createStreamingRequest(msgs, 's', noTools, { signal: ac.signal })) {
        seen.push(e);
        if (e.type === 'text') ac.abort();
      }
      // Current behaviour: the parser checks the signal between reads and stops; no error is thrown
      // and the missing message_stop is excused because the caller aborted.
      expect(seen).toEqual([
        { type: 'usage', inputTokens: 4, outputTokens: 0 },
        { type: 'text', text: 'first' },
      ]);
    });

    it('should format tool_result messages correctly', async () => {
      const stub = stubFetch(() => sseResponse([textDelta('ok'), stop()]));
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
      await run(messages, 'system');
      const body = stub.calls[0].body;

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
      const stub = stubFetch(() => sseResponse([textDelta('done'), stop()]));
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
      await run(messages, 'system');
      const body = stub.calls[0].body;

      // Should be 3 messages: user, assistant, user (merged tool_results)
      expect(body.messages).toHaveLength(3);

      const toolResultMsg = body.messages[2];
      expect(toolResultMsg.role).toBe('user');
      expect(toolResultMsg.content).toHaveLength(2);
      expect(toolResultMsg.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tc1', content: 'result 1' });
      expect(toolResultMsg.content[1]).toEqual({ type: 'tool_result', tool_use_id: 'tc2', content: 'result 2' });
    });

    it('should filter empty text blocks from assistant messages', async () => {
      const stub = stubFetch(() => sseResponse([textDelta('ok'), stop()]));
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
      await run(messages, 'system');
      const body = stub.calls[0].body;

      // Assistant content should only have the tool_use block (empty text filtered)
      const assistantMsg = body.messages[1];
      expect(assistantMsg.content).toHaveLength(1);
      expect(assistantMsg.content[0].type).toBe('tool_use');
    });
  });
});
