// Characterization: Ollama behind createProvider, observed only through the wire request it
// sends and the events it yields. First written against the previous single-file implementation;
// every assertion that changed with the dialect rewrite says what the old behaviour was.
// fixtures: hand-written from https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProvider } from '../registry';
import { ndjsonResponse, chunkedResponse, textResponse, okStream, stubFetch, callHeader, collect } from '../test-helpers';
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';

afterEach(() => vi.unstubAllGlobals());

const msgs: AiMessage[] = [{ role: 'user', content: 'hello' }];
const noTools: AiToolDefinition[] = [];

const ollama = (cfg: Record<string, any> = { baseUrl: 'http://localhost:11434' }, newId?: () => string) => createProvider('ollama', cfg, { newId });
const run = (messages: AiMessage[] = msgs, system = 'system', tools: AiToolDefinition[] = noTools, cfg?: Record<string, any>) =>
  collect(ollama(cfg).createStreamingRequest(messages, system, tools));

describe('ollama', () => {
  describe('request headers', () => {
    it('includes Content-Type', async () => {
      const stub = stubFetch(() => okStream('ollama'));
      await run(msgs, 's', noTools, {});
      expect(callHeader(stub.calls[0], 'Content-Type')).toBe('application/json');
    });

    it('posts to /api/chat on localhost with the default model and no auth header', async () => {
      const stub = stubFetch(() => okStream('ollama'));
      await run(msgs, 'sys prompt', noTools, { apiKey: 'ignored-placeholder' });
      const call = stub.calls[0];
      expect(call.url).toBe('http://localhost:11434/api/chat');
      expect(call.init.method).toBe('POST');
      expect(callHeader(call, 'authorization')).toBeUndefined();
      // Was an exact key-order check on the header object; header names are case-insensitive, so look them up by name.
      expect(callHeader(call, 'content-type')).toBe('application/json');
      expect(Object.keys(call.headers)).toHaveLength(1);
      // The agent path sets no sampling or limit options, so the body carries no `options` object.
      expect(call.body).toEqual({
        model: 'llama3.1',
        messages: [
          { role: 'system', content: 'sys prompt' },
          { role: 'user', content: 'hello' },
        ],
        stream: true,
      });
    });

    it('honours baseUrl and model from config', async () => {
      const stub = stubFetch(() => okStream('ollama'));
      await run(msgs, 's', noTools, { baseUrl: 'http://gpu-box.test:11434', model: 'qwen3' });
      expect(stub.calls[0].url).toBe('http://gpu-box.test:11434/api/chat');
      expect(stub.calls[0].body.model).toBe('qwen3');
    });
  });

  describe('tool definitions', () => {
    it('uses OpenAI function format', async () => {
      const stub = stubFetch(() => okStream('ollama'));
      await run(msgs, 's', [
        {
          name: 'my_tool',
          description: 'Does things',
          inputSchema: { type: 'object' },
          context: ['all'],
        },
      ], {});
      expect(stub.calls[0].body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'my_tool',
            description: 'Does things',
            parameters: { type: 'object' },
          },
        },
      ]);
    });
  });

  describe('message history (empty assistant content)', () => {
    it('should handle assistant message with empty text array', async () => {
      // NDJSON stream for Ollama
      const stub = stubFetch(() => ndjsonResponse([
        { message: { content: 'ok' } },
        { done: true, prompt_eval_count: 5, eval_count: 3 },
      ]));
      const messages: AiMessage[] = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '' }], // empty text block
        },
        { role: 'user', content: 'continue' },
      ];
      const events = await run(messages, 'system');

      // Verify the request body was formatted correctly
      const body = stub.calls[0].body;
      const assistantEntry = body.messages[2]; // [system, user, assistant, user]
      expect(assistantEntry.role).toBe('assistant');
      expect(assistantEntry.content).toBe(''); // empty text concatenated

      // Stream produced events
      expect(events.some((e) => e.type === 'text')).toBe(true);
    });

    it('sends tool calls with object arguments and tool results with tool_call_id and tool_name', async () => {
      const stub = stubFetch(() => okStream('ollama'));
      const messages: AiMessage[] = [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling ' },
            { type: 'text', text: 'now' },
            { type: 'tool_use', id: 'tc1', name: 'get_info', input: { q: 'x' } },
          ],
        },
        { role: 'tool_result', toolUseId: 'tc1', content: 'out' },
      ];
      await run(messages, 'sys');
      // Was: arguments as a JSON string ('{"q":"x"}') and the tool result without a name. Ollama's native
      // API documents arguments as an object and names the tool on a result, so both now follow the docs.
      expect(stub.calls[0].body.messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'calling now',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_info', arguments: { q: 'x' } } }],
        },
        { role: 'tool', content: 'out', tool_call_id: 'tc1', tool_name: 'get_info' },
      ]);
    });
  });

  describe('streaming', () => {
    it('yields text, tool calls, and usage from the done line', async () => {
      stubFetch(() => ndjsonResponse([
        { message: { content: 'Hel' } },
        { message: { content: 'lo' } },
        { message: { tool_calls: [{ function: { name: 'obj_args', arguments: { a: 1 } } }] } },
        { message: { tool_calls: [{ id: 'given', function: { name: 'str_args', arguments: '{"b":2}' } }] } },
        { message: { tool_calls: [{ id: 'bad', function: { name: 'bad_args', arguments: '{nope' } }] } },
        { done: true, prompt_eval_count: 12, eval_count: 6 },
      ]));
      const events = await collect(ollama(undefined, () => 'call-1').createStreamingRequest(msgs, 's', noTools));
      // Was: a missing id synthesised as ollama-<timestamp>-<random>. Now it comes from the provider's id generator.
      expect(events).toEqual([
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        { type: 'tool_use', id: 'call-1', name: 'obj_args', input: { a: 1 } },
        { type: 'tool_use', id: 'given', name: 'str_args', input: { b: 2 } },
        { type: 'tool_use', id: 'bad', name: 'bad_args', input: {} },
        { type: 'usage', inputTokens: 12, outputTokens: 6, model: 'llama3.1', providerType: 'ollama' },
      ]);
    });

    it('emits no usage when the done line has no counts', async () => {
      stubFetch(() => ndjsonResponse([{ message: { content: 'x' } }, { done: true }]));
      expect(await run()).toEqual([{ type: 'text', text: 'x' }]);
    });

    it('reassembles a JSON line split across chunks, tolerating CRLF and junk lines', async () => {
      stubFetch(() => chunkedResponse([
        '{"message":{"con',
        'tent":"split ok"}}\r\n',
        'garbage line\n\n',
        '{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
      ]));
      expect(await run()).toEqual([
        { type: 'text', text: 'split ok' },
        { type: 'usage', inputTokens: 1, outputTokens: 1, model: 'llama3.1', providerType: 'ollama' },
      ]);
    });

    it('reads a final line that has no trailing newline', async () => {
      stubFetch(() => chunkedResponse(['{"message":{"content":"a"}}\n', '{"done":true,"prompt_eval_count":2,"eval_count":2}']));
      // Was: the NDJSON reader only emitted complete lines, so an unterminated last line (here the usage line) was lost.
      // Now: a stream that ends without a done line is an error, so the reader parses an unterminated last line
      // instead of turning a complete answer into a failure.
      expect(await run()).toEqual([{ type: 'text', text: 'a' }, { type: 'usage', inputTokens: 2, outputTokens: 2, model: 'llama3.1', providerType: 'ollama' }]);
    });

    it('a stream cut off before the done line is an error', async () => {
      stubFetch(() => chunkedResponse(['{"message":{"content":"half a sent"}}\n']));
      // Was: treated as a complete reply. Now: the router sees a failure instead of a silently truncated answer.
      await expect(run()).rejects.toMatchObject({ name: 'AiProviderError', message: 'Ollama stream ended before done' });
    });

    it('throws a RateLimitError on 429', async () => {
      stubFetch(() => textResponse('busy', 429));
      // Was exactly "Ollama rate limited (429)"; a 429 now uses the common error wording with the body text.
      await expect(run()).rejects.toMatchObject({ name: 'RateLimitError', message: 'Ollama API error (429): busy' });
    });

    it('turns an error line inside the stream into an error', async () => {
      stubFetch(() => ndjsonResponse([{ message: { content: 'a' } }, { error: 'model not found' }]));
      await expect(run()).rejects.toThrow('Ollama stream error: model not found');
    });

    it('throws when the response has no body', async () => {
      stubFetch(() => new Response(null, { status: 200 }));
      await expect(run()).rejects.toThrow('Ollama response has no body');
    });

    it('stops quietly when aborted mid-stream', async () => {
      stubFetch(() => chunkedResponse([
        '{"message":{"content":"first"}}\n',
        '{"message":{"content":"never seen"}}\n',
        '{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
      ]));
      const ac = new AbortController();
      const seen: AiStreamEvent[] = [];
      for await (const e of ollama().createStreamingRequest(msgs, 's', noTools, { signal: ac.signal })) {
        seen.push(e);
        ac.abort();
      }
      expect(seen).toEqual([{ type: 'text', text: 'first' }]);
    });
  });
});
