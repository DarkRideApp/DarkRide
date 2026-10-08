// Step 0 characterization: Ollama behind createProvider, observed only through the
// wire request it sends and the events it yields. Written against the old ai-provider.ts.
// fixtures: hand-written from https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProvider } from '../../ai-provider';
import { ndjsonResponse, chunkedResponse, textResponse, okStream, stubFetch, callHeader, collect } from '../test-helpers';
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';

afterEach(() => vi.unstubAllGlobals());

const msgs: AiMessage[] = [{ role: 'user', content: 'hello' }];
const noTools: AiToolDefinition[] = [];

const ollama = (cfg: Record<string, any> = { baseUrl: 'http://localhost:11434' }) => createProvider('ollama', cfg);
const run = (messages: AiMessage[] = msgs, system = 'system', tools: AiToolDefinition[] = noTools, cfg?: Record<string, any>) =>
  collect(ollama(cfg).createStreamingRequest(messages, system, tools));

describe('OllamaProvider', () => {
  describe('buildHeaders', () => {
    it('includes Content-Type', async () => {
      const stub = stubFetch(() => okStream('ollama'));
      await run(msgs, 's', noTools, {});
      expect(callHeader(stub.calls[0], 'Content-Type')).toBe('application/json');
    });

    it('posts to /api/chat on localhost with the default model and no auth header', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('ollama'));
      await run(msgs, 'sys prompt', noTools, { apiKey: 'ignored-placeholder' });
      const call = stub.calls[0];
      expect(call.url).toBe('http://localhost:11434/api/chat');
      expect(call.init.method).toBe('POST');
      expect(callHeader(call, 'authorization')).toBeUndefined();
      expect(Object.keys(call.headers)).toEqual(['Content-Type']);
      // BC-15 adds temperature: 0 on the completion path; the agent path body is this.
      expect(call.body).toEqual({
        model: 'llama3.1',
        messages: [
          { role: 'system', content: 'sys prompt' },
          { role: 'user', content: 'hello' },
        ],
        stream: true,
      });
    });

    it('honours baseUrl and model from config', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('ollama'));
      await run(msgs, 's', noTools, { baseUrl: 'http://gpu-box.test:11434', model: 'qwen3' });
      expect(stub.calls[0].url).toBe('http://gpu-box.test:11434/api/chat');
      expect(stub.calls[0].body.model).toBe('qwen3');
    });
  });

  describe('formatTools', () => {
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

  describe('formatMessages (empty assistant content)', () => {
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

    it('sends tool calls with stringified arguments and tool results by tool_call_id', async () => { // new in Step 0
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
      expect(stub.calls[0].body.messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'calling now',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_info', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', content: 'out', tool_call_id: 'tc1' },
      ]);
    });
  });

  describe('streaming', () => { // new in Step 0
    it('yields text, tool calls, and usage from the done line', async () => { // new in Step 0
      stubFetch(() => ndjsonResponse([
        { message: { content: 'Hel' } },
        { message: { content: 'lo' } },
        { message: { tool_calls: [{ function: { name: 'obj_args', arguments: { a: 1 } } }] } },
        { message: { tool_calls: [{ id: 'given', function: { name: 'str_args', arguments: '{"b":2}' } }] } },
        { message: { tool_calls: [{ id: 'bad', function: { name: 'bad_args', arguments: '{nope' } }] } },
        { done: true, prompt_eval_count: 12, eval_count: 6 },
      ]));
      const events = await run();
      const synthId = (events[2] as Extract<AiStreamEvent, { type: 'tool_use' }>).id;
      expect(synthId).toMatch(/^ollama-\d+-[a-z0-9]+$/);
      expect(events).toEqual([
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        { type: 'tool_use', id: synthId, name: 'obj_args', input: { a: 1 } },
        { type: 'tool_use', id: 'given', name: 'str_args', input: { b: 2 } },
        { type: 'tool_use', id: 'bad', name: 'bad_args', input: {} },
        { type: 'usage', inputTokens: 12, outputTokens: 6 },
      ]);
    });

    it('emits no usage when the done line has no counts', async () => { // new in Step 0
      stubFetch(() => ndjsonResponse([{ message: { content: 'x' } }, { done: true }]));
      expect(await run()).toEqual([{ type: 'text', text: 'x' }]);
    });

    it('reassembles a JSON line split across chunks, tolerating CRLF and junk lines', async () => { // new in Step 0
      stubFetch(() => chunkedResponse([
        '{"message":{"con',
        'tent":"split ok"}}\r\n',
        'garbage line\n\n',
        '{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
      ]));
      expect(await run()).toEqual([
        { type: 'text', text: 'split ok' },
        { type: 'usage', inputTokens: 1, outputTokens: 1 },
      ]);
    });

    it('drops a final line that has no trailing newline', async () => { // new in Step 0
      stubFetch(() => chunkedResponse(['{"message":{"content":"a"}}\n', '{"done":true,"prompt_eval_count":2,"eval_count":2}']));
      // Current behaviour: the NDJSON parser only emits complete lines, so the unterminated done line is lost.
      // No BC id covers this. If the new parser flushes the tail, change this assertion on purpose and say so.
      expect(await run()).toEqual([{ type: 'text', text: 'a' }]);
    });

    it('throws a RateLimitError on 429', async () => { // new in Step 0
      stubFetch(() => textResponse('busy', 429));
      await expect(run()).rejects.toMatchObject({ name: 'RateLimitError', message: 'Ollama rate limited (429)' });
    });

    it('throws when the response has no body', async () => { // new in Step 0
      stubFetch(() => new Response(null, { status: 200 }));
      await expect(run()).rejects.toThrow('Ollama response has no body');
    });

    it('stops quietly when aborted mid-stream', async () => { // new in Step 0
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
