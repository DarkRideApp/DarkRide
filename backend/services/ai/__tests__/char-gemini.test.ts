// Characterization: Gemini behind createProvider, observed only through the wire request it
// sends and the events it yields. First written against the previous single-file implementation;
// every assertion that changed with the dialect rewrite says what the old behaviour was.
// fixtures: hand-written from https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProvider } from '../registry';
import { sseResponse, chunkedResponse, textResponse, okStream, stubFetch, callHeader, collect } from '../test-helpers';
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';

afterEach(() => vi.unstubAllGlobals());

const msgs: AiMessage[] = [{ role: 'user', content: 'hello' }];
const noTools: AiToolDefinition[] = [];

const chunk = (payload: unknown) => ({ data: JSON.stringify(payload) });
const gemini = (cfg: Record<string, any> = { apiKey: 'test-key' }, newId?: () => string) => createProvider('gemini', cfg, { newId });
const run = (messages: AiMessage[] = msgs, system = 'system', tools: AiToolDefinition[] = noTools, cfg?: Record<string, any>) =>
  collect(gemini(cfg).createStreamingRequest(messages, system, tools));

describe('GeminiProvider', () => {
  describe('buildHeaders', () => {
    it('includes Content-Type', async () => {
      const stub = stubFetch(() => okStream('gemini'));
      await run(msgs, 's', noTools, { apiKey: 'test' });
      expect(callHeader(stub.calls[0], 'Content-Type')).toBe('application/json');
    });

    it('sends the key in the x-goog-api-key header, never in the URL', async () => {
      const stub = stubFetch(() => okStream('gemini'));
      await run(msgs, 's', noTools, { apiKey: 'sk-test-placeholder' });
      const call = stub.calls[0];
      // Was `&key=<key>` in the query string (so the key landed in any logged URL) with gemini-2.0-flash,
      // which Google has shut down. Now the key is a header and the default model is gemini-2.5-flash.
      expect(call.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      );
      expect(call.url).not.toContain('sk-test-placeholder');
      expect(callHeader(call, 'authorization')).toBeUndefined();
      expect(callHeader(call, 'x-goog-api-key')).toBe('sk-test-placeholder');
      // Was an exact key-order check on the header object; header names are case-insensitive, so look them up by name.
      expect(callHeader(call, 'content-type')).toBe('application/json');
      expect(call.init.method).toBe('POST');
    });

    it('uses the configured model and honours baseUrl', async () => {
      const stub = stubFetch(() => okStream('gemini'));
      await run(msgs, 's', noTools, { apiKey: 'k', model: 'gemini-x', baseUrl: 'https://proxy.test' });
      // Was ignored: the request always went to Google's host. A configured Base URL is now used.
      expect(stub.calls[0].url).toBe('https://proxy.test/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
    });

    it('sends systemInstruction and contents, and omits tools when none are given', async () => {
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
        name: 'get_info', // was the literal 'tool_result'; now the name of the call this result answers
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

    it('merges consecutive tool results into one user turn and drops empty assistant text parts', async () => {
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
      // Was: an empty { text: '' } part kept in the model turn, and one user turn per result, each named
      // 'tool_result'. Now empty text parts are dropped and the results share one turn with real names.
      expect(stub.calls[0].body.contents).toEqual([
        { role: 'user', parts: [{ text: 'go' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'tool_a', args: {} } },
            { functionCall: { name: 'tool_b', args: { n: 1 } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'tool_a', response: { result: 'ra' } } },
            { functionResponse: { name: 'tool_b', response: { result: 'rb' } } },
          ],
        },
      ]);
    });
  });

  describe('streaming', () => {
    it('yields text, a tool call with an id from the id generator, and usage once at the end', async () => {
      stubFetch(() => sseResponse([
        chunk({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 } }),
        chunk({ candidates: [{ content: { parts: [{ text: 'lo' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } }),
        chunk({
          candidates: [{ content: { parts: [{ functionCall: { name: 'get_apps', args: { q: 'x' } } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
        }),
      ]));
      const events = await collect(gemini({ apiKey: 'k' }, () => 'call-1').createStreamingRequest(msgs, 's', noTools));
      // Was: an id of the form gemini-<timestamp>-<random>, and a usage event on every chunk carrying
      // usageMetadata (which consumers summed, over-counting). Now ids come from the provider's id
      // generator, and usage is emitted once, from the last chunk.
      expect(events).toEqual([
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        { type: 'tool_use', id: 'call-1', name: 'get_apps', input: { q: 'x' } },
        { type: 'usage', inputTokens: 9, outputTokens: 4 },
      ]);
    });

    it('generates a non-empty tool-call id by default', async () => {
      stubFetch(() => sseResponse([chunk({ candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] } }] })]));
      const [tool] = (await run()) as Extract<AiStreamEvent, { type: 'tool_use' }>[];
      expect(tool.id).toMatch(/^call_[0-9a-f]{24}$/);
    });

    it('defaults missing functionCall args to an empty object', async () => {
      stubFetch(() => sseResponse([chunk({ candidates: [{ content: { parts: [{ functionCall: { name: 'noargs' } }] } }] })]));
      const events = await run();
      expect(events).toMatchObject([{ type: 'tool_use', name: 'noargs', input: {} }]);
    });

    it('ends without an error on a safety stop with no parts, and says why', async () => {
      stubFetch(() => sseResponse([chunk({ candidates: [{ finishReason: 'SAFETY' }] })]));
      // Was a silent empty reply; safety, blocked, and malformed-call stops now show a message.
      expect(await run()).toEqual([{ type: 'text', text: 'Gemini stopped this response (reason: SAFETY).' }]);
    });

    it('skips unparseable data lines and accepts a stream with no terminator', async () => {
      stubFetch(() => sseResponse([
        { data: 'not json' },
        chunk({ candidates: [{ content: { parts: [{ text: 'fine' }] } }] }),
      ]));
      expect(await run()).toEqual([{ type: 'text', text: 'fine' }]);
    });

    it('reassembles a chunk split across network reads, with CRLF endings', async () => {
      const line = 'data: {"candidates":[{"content":{"parts":[{"text":"split ok"}]}}]}\r\n\r\n';
      stubFetch(() => chunkedResponse([line.slice(0, 20), line.slice(20, line.length - 3), line.slice(line.length - 3)]));
      expect(await run()).toEqual([{ type: 'text', text: 'split ok' }]);
    });

    it('throws a RateLimitError on 429', async () => {
      stubFetch(() => textResponse('quota', 429));
      // Was exactly "Gemini rate limited (429)"; a 429 now uses the common error wording with the body text.
      await expect(run()).rejects.toMatchObject({ name: 'RateLimitError', message: 'Gemini API error (429): quota' });
    });

    it('throws when the response has no body', async () => {
      stubFetch(() => new Response(null, { status: 200 }));
      await expect(run()).rejects.toThrow('Gemini response has no body');
    });

    it('stops quietly when aborted mid-stream', async () => {
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
