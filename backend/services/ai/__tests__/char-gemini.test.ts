// Step 0 characterization: Gemini behind createProvider, observed only through the
// wire request it sends and the events it yields. Written against the old ai-provider.ts.
// fixtures: hand-written from https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProvider } from '../../ai-provider';
import { sseResponse, chunkedResponse, textResponse, okStream, stubFetch, callHeader, collect } from '../test-helpers';
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';

afterEach(() => vi.unstubAllGlobals());

const msgs: AiMessage[] = [{ role: 'user', content: 'hello' }];
const noTools: AiToolDefinition[] = [];

const chunk = (payload: unknown) => ({ data: JSON.stringify(payload) });
const gemini = (cfg: Record<string, any> = { apiKey: 'test-key' }) => createProvider('gemini', cfg);
const run = (messages: AiMessage[] = msgs, system = 'system', tools: AiToolDefinition[] = noTools, cfg?: Record<string, any>) =>
  collect(gemini(cfg).createStreamingRequest(messages, system, tools));

describe('GeminiProvider', () => {
  describe('buildHeaders', () => {
    it('includes Content-Type', async () => {
      const stub = stubFetch(() => okStream('gemini'));
      await run(msgs, 's', noTools, { apiKey: 'test' });
      expect(callHeader(stub.calls[0], 'Content-Type')).toBe('application/json');
    });

    it('puts the key in the URL and sends no auth header', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('gemini'));
      await run(msgs, 's', noTools, { apiKey: 'sk-test-placeholder' });
      const call = stub.calls[0];
      // BC-10 moves the key to x-goog-api-key; BC-11 changes the default model to gemini-2.5-flash.
      expect(call.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=sk-test-placeholder',
      );
      expect(callHeader(call, 'authorization')).toBeUndefined();
      expect(callHeader(call, 'x-goog-api-key')).toBeUndefined();
      expect(Object.keys(call.headers)).toEqual(['Content-Type']);
      expect(call.init.method).toBe('POST');
    });

    it('uses the configured model and ignores baseUrl', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('gemini'));
      await run(msgs, 's', noTools, { apiKey: 'k', model: 'gemini-x', baseUrl: 'https://proxy.test' });
      // BC-09 makes Gemini honour baseUrl.
      expect(stub.calls[0].url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse&key=k',
      );
    });

    it('sends systemInstruction and contents, and omits tools when none are given', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('gemini'));
      await run(msgs, 'sys prompt');
      expect(stub.calls[0].body).toEqual({
        systemInstruction: { parts: [{ text: 'sys prompt' }] },
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      });
    });
  });

  describe('formatTools', () => {
    it('uses parameters field (Gemini format)', async () => {
      const stub = stubFetch(() => okStream('gemini'));
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
          functionDeclarations: [
            {
              name: 'test_tool',
              description: 'A test tool',
              parameters: { type: 'object', properties: { x: { type: 'number' } } },
            },
          ],
        },
      ]);
    });
  });

  describe('formatMessages (tool results)', () => {
    it('should format tool results as functionResponse parts', async () => {
      const stub = stubFetch(() => sseResponse([
        chunk({ candidates: [{ content: { parts: [{ text: 'response' }] } }] }),
      ]));
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

      // tool_result message becomes a "user" role with functionResponse part
      const toolResultMsg = body.contents[2];
      expect(toolResultMsg.role).toBe('user');
      expect(toolResultMsg.parts[0].functionResponse).toEqual({
        name: 'tool_result', // BC-11 sends the real function name
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

    it('sends each tool result as its own user turn and keeps empty assistant text parts', async () => { // new in Step 0
      const stub = stubFetch(() => okStream('gemini'));
      const messages: AiMessage[] = [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 'a', name: 'tool_a', input: {} },
            { type: 'tool_use', id: 'b', name: 'tool_b', input: { n: 1 } },
          ],
        },
        { role: 'tool_result', toolUseId: 'a', content: 'ra' },
        { role: 'tool_result', toolUseId: 'b', content: 'rb' },
      ];
      await run(messages);
      // BC-11 merges consecutive tool results into one turn with real names.
      expect(stub.calls[0].body.contents).toEqual([
        { role: 'user', parts: [{ text: 'go' }] },
        {
          role: 'model',
          parts: [
            { text: '' },
            { functionCall: { name: 'tool_a', args: {} } },
            { functionCall: { name: 'tool_b', args: { n: 1 } } },
          ],
        },
        { role: 'user', parts: [{ functionResponse: { name: 'tool_result', response: { result: 'ra' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'tool_result', response: { result: 'rb' } } }] },
      ]);
    });
  });

  describe('streaming', () => { // new in Step 0
    it('yields text, a synthesised tool id, and usage on every chunk that carries it', async () => { // new in Step 0
      stubFetch(() => sseResponse([
        chunk({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 } }),
        chunk({ candidates: [{ content: { parts: [{ text: 'lo' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } }),
        chunk({
          candidates: [{ content: { parts: [{ functionCall: { name: 'get_apps', args: { q: 'x' } } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
        }),
      ]));
      const events = await run();
      const tool = events.find((e) => e.type === 'tool_use') as Extract<AiStreamEvent, { type: 'tool_use' }>;
      expect(tool.id).toMatch(/^gemini-\d+-[a-z0-9]+$/);
      // BC-11 emits usage once; today every chunk with usageMetadata yields a usage event.
      expect(events).toEqual([
        { type: 'text', text: 'Hel' },
        { type: 'usage', inputTokens: 9, outputTokens: 1 },
        { type: 'text', text: 'lo' },
        { type: 'usage', inputTokens: 9, outputTokens: 2 },
        { type: 'tool_use', id: tool.id, name: 'get_apps', input: { q: 'x' } },
        { type: 'usage', inputTokens: 9, outputTokens: 4 },
      ]);
    });

    it('defaults missing functionCall args to an empty object', async () => { // new in Step 0
      stubFetch(() => sseResponse([chunk({ candidates: [{ content: { parts: [{ functionCall: { name: 'noargs' } }] } }] })]));
      const events = await run();
      expect(events).toMatchObject([{ type: 'tool_use', name: 'noargs', input: {} }]);
    });

    it('ends quietly on a safety stop with no parts', async () => { // new in Step 0
      stubFetch(() => sseResponse([chunk({ candidates: [{ finishReason: 'SAFETY' }] })]));
      // BC-05 makes safety, blocked, and malformed-call stops produce a visible message.
      expect(await run()).toEqual([]);
    });

    it('skips unparseable data lines and accepts a stream with no terminator', async () => { // new in Step 0
      stubFetch(() => sseResponse([
        { data: 'not json' },
        chunk({ candidates: [{ content: { parts: [{ text: 'fine' }] } }] }),
      ]));
      expect(await run()).toEqual([{ type: 'text', text: 'fine' }]);
    });

    it('reassembles a chunk split across network reads, with CRLF endings', async () => { // new in Step 0
      const line = 'data: {"candidates":[{"content":{"parts":[{"text":"split ok"}]}}]}\r\n\r\n';
      stubFetch(() => chunkedResponse([line.slice(0, 20), line.slice(20, line.length - 3), line.slice(line.length - 3)]));
      expect(await run()).toEqual([{ type: 'text', text: 'split ok' }]);
    });

    it('throws a RateLimitError on 429', async () => { // new in Step 0
      stubFetch(() => textResponse('quota', 429));
      await expect(run()).rejects.toMatchObject({ name: 'RateLimitError', message: 'Gemini rate limited (429)' });
    });

    it('throws when the response has no body', async () => { // new in Step 0
      stubFetch(() => new Response(null, { status: 200 }));
      await expect(run()).rejects.toThrow('Gemini response has no body');
    });

    it('stops quietly when aborted mid-stream', async () => { // new in Step 0
      stubFetch(() => chunkedResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"first"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"never seen"}]}}]}\n\n',
      ]));
      const ac = new AbortController();
      const seen: AiStreamEvent[] = [];
      for await (const e of gemini().createStreamingRequest(msgs, 's', noTools, { signal: ac.signal })) {
        seen.push(e);
        ac.abort();
      }
      expect(seen).toEqual([{ type: 'text', text: 'first' }]);
    });
  });
});
