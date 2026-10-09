// backend/services/ai/__tests__/openai-chat.dialect.test.ts
// fixtures: hand-written from https://platform.openai.com/docs/api-reference/chat-streaming (wire shape only)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openAiChatDialect, __resetOpenAiChatMemo } from '../dialects/openai-chat';
import { makeCtx } from '../test-ctx';
import { sseResponse, sseBody, chunkedResponse, collect } from '../test-helpers';
import { OutputLimitError, AiProviderError, ModelRefusedError, OverloadedError, QuotaExhaustedError, RateLimitError } from '../errors';
import type { AiToolDefinition } from '../../../../shared/types/ai-chat';

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
vi.mock('../../../logs', () => ({
  createLoggers: () => ({ log: logSpy, error: vi.fn() }),
}));

beforeEach(() => { __resetOpenAiChatMemo(); logSpy.mockClear(); });

const run = (res: Response, id = 'openai-compatible') => collect(openAiChatDialect.parseStream(res, makeCtx(id)));
const chunk = (o: unknown) => ({ data: JSON.stringify(o) });
const delta = (d: unknown, finish: string | null = null) => chunk({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const tc = (o: { index?: number; id?: string; name?: string; args?: string }) => ({
  tool_calls: [{ ...(o.index !== undefined ? { index: o.index } : {}), ...(o.id ? { id: o.id } : {}),
    function: { ...(o.name ? { name: o.name } : {}), ...(o.args !== undefined ? { arguments: o.args } : {}) } }],
});
const tools: AiToolDefinition[] = [{ name: 'get_apps', description: 'List apps', inputSchema: { type: 'object', properties: {} }, context: [] }];

describe('buildChat', () => {
  const req = { messages: [{ role: 'user' as const, content: 'hi' }], systemPrompt: 'sys', tools };

  it('builds url, bearer auth, system-first messages and tool functions', () => {
    const built = openAiChatDialect.buildChat(makeCtx('openrouter', { model: 'm' }), req, { stream: true });
    expect(built.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(built.headers.Authorization).toBe('Bearer sk-test-placeholder');
    const b: any = built.body;
    expect(b.model).toBe('m');
    expect(b.stream).toBe(true);
    expect(b.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(b.tools).toEqual([{ type: 'function', function: { name: 'get_apps', description: 'List apps', parameters: { type: 'object', properties: {} } } }]);
  });
  it('omits Authorization when there is no key (local server)', () => {
    const built = openAiChatDialect.buildChat(makeCtx('openai-compatible', { apiKey: undefined }), req, { stream: true });
    expect(built.headers.Authorization).toBeUndefined();
  });
  it('omits Authorization when the key is an empty string', () => {
    const built = openAiChatDialect.buildChat(makeCtx('openai-compatible', { apiKey: '' }), req, { stream: true });
    expect(built.headers.Authorization).toBeUndefined();
  });
  it('maps assistant tool_use and tool_result messages', () => {
    const built: any = openAiChatDialect.buildChat(makeCtx('openai-compatible'), {
      ...req,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'get_apps', input: { q: 1 } }] },
        { role: 'tool_result', toolUseId: 'c1', content: 'done' },
      ],
    }, { stream: true }).body;
    expect(built.messages[2]).toEqual({ role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_apps', arguments: '{"q":1}' } }] });
    expect(built.messages[3]).toEqual({ role: 'tool', content: 'done', tool_call_id: 'c1' });
  });
  it('uses max_completion_tokens and no stop for openai; max_tokens and stop elsewhere', () => {
    const lim = { ...req, maxOutputTokens: 256, stopSequences: ['\n\n\n'] };
    const o: any = openAiChatDialect.buildChat(makeCtx('openai', { model: 'x' }), lim, { stream: true }).body;
    expect(o.max_completion_tokens).toBe(256); expect(o.max_tokens).toBeUndefined(); expect(o.stop).toBeUndefined();
    const c: any = openAiChatDialect.buildChat(makeCtx('openai-compatible'), lim, { stream: true }).body;
    expect(c.max_tokens).toBe(256); expect(c.stop).toEqual(['\n\n\n']);
  });
  it('sends stream_options per descriptor and honours the retry flag', () => {
    const a: any = openAiChatDialect.buildChat(makeCtx('openai', { model: 'x' }), req, { stream: true }).body;
    expect(a.stream_options).toEqual({ include_usage: true });
    const t: any = openAiChatDialect.buildChat(makeCtx('openai-compatible'), req, { stream: true }).body;
    expect(t.stream_options).toEqual({ include_usage: true });
    const flagged: any = openAiChatDialect.buildChat(makeCtx('openai-compatible', { flags: { noStreamUsage: true } }), req, { stream: true }).body;
    expect(flagged.stream_options).toBeUndefined();
    const never: any = openAiChatDialect.buildChat(makeCtx('ollama'), req, { stream: true }).body;
    expect(never.stream_options).toBeUndefined();
  });
  it('passes temperature when set', () => {
    const b: any = openAiChatDialect.buildChat(makeCtx('openai-compatible'), { ...req, temperature: 0 }, { stream: true }).body;
    expect(b.temperature).toBe(0);
  });
});

describe('retryWith', () => {
  it('returns a no-usage context after a stream_options rejection and remembers it per base URL', () => {
    const ctx = makeCtx('openai-compatible');
    const next = openAiChatDialect.retryWith!(400, 'Unrecognized request argument: stream_options', ctx);
    expect(next?.flags.noStreamUsage).toBe(true);
    const later: any = openAiChatDialect.buildChat(makeCtx('openai-compatible'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).body;
    expect(later.stream_options).toBeUndefined();
  });
  it('a 422 that names stream_options also triggers the retry without it', () => {
    const next = openAiChatDialect.retryWith!(422, '{"detail":[{"loc":["body","stream_options"],"msg":"Extra inputs are not permitted"}]}', makeCtx('mistral'));
    expect(next?.flags.noStreamUsage).toBe(true);
    expect(openAiChatDialect.retryWith!(422, 'something else', makeCtx('mistral'))).toBeUndefined();
  });
  it('ignores other failures and providers that always send it', () => {
    expect(openAiChatDialect.retryWith!(400, 'something else', makeCtx('openai-compatible'))).toBeUndefined();
    expect(openAiChatDialect.retryWith!(500, 'stream_options', makeCtx('openai-compatible'))).toBeUndefined();
    expect(openAiChatDialect.retryWith!(400, 'stream_options', makeCtx('openai'))).toBeUndefined();
  });
});

describe('parseStream', () => {
  it('yields text, then usage once at the end (usage chunk has empty choices)', async () => {
    const events = await run(sseResponse([
      delta({ content: 'Hel' }), delta({ content: 'lo' }, 'stop'),
      chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } }), { data: '[DONE]' },
    ]));
    expect(events).toEqual([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'usage', inputTokens: 11, outputTokens: 4 }]);
  });

  it.each([
    ['an array', '[1,2]'],
    ['a number', '5'],
    ['a string', '"text"'],
    ['null', 'null'],
  ])('tool arguments that parse to %s become an empty object', async (_label, args) => {
    const events = await run(sseResponse([delta(tc({ index: 0, id: 'a', name: 'f', args })), delta({}, 'tool_calls'), { data: '[DONE]' }]));
    expect(events).toEqual([{ type: 'tool_use', id: 'a', name: 'f', input: {} }]);
  });

  it('object tool arguments are passed through untouched', async () => {
    const events = await run(sseResponse([delta(tc({ index: 0, id: 'a', name: 'f', args: '{"a":[1,{"b":2}]}' })), delta({}, 'tool_calls'), { data: '[DONE]' }]));
    expect(events).toEqual([{ type: 'tool_use', id: 'a', name: 'f', input: { a: [1, { b: 2 }] } }]);
  });

  it('arguments that parse only as a number are not complete at finish_reason: a late fragment still joins that call', async () => {
    // The name arrives after finish_reason. If '1' counted as complete, the call would be flushed (and dropped, having
    // no name) at finish_reason, and the late fragment would start a separate call under a made-up id.
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'a', args: '1' })),
      delta({}, 'tool_calls'),
      delta(tc({ index: 0, name: 'f', args: '2' })),
      { data: '[DONE]' },
    ]));
    expect(events).toEqual([{ type: 'tool_use', id: 'a', name: 'f', input: {} }]);
  });

  it('parallel tool calls keyed by index: interleaved fragments are concatenated per call, emitted in the order the calls started', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'a', name: 'first', args: '{"x":' })),
      delta(tc({ index: 1, id: 'b', name: 'second', args: '{"y"' })),
      delta(tc({ index: 1, args: ':2}' })), delta(tc({ index: 0, args: '1}' })),
      delta({}, 'tool_calls'), { data: '[DONE]' },
    ]));
    expect(events).toEqual([
      { type: 'tool_use', id: 'a', name: 'first', input: { x: 1 } },
      { type: 'tool_use', id: 'b', name: 'second', input: { y: 2 } },
    ]);
  });

  it('emits calls in the order they started, not by index number', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 1, id: 'b', name: 'second', args: '{"y"' })),
      delta(tc({ index: 0, id: 'a', name: 'first', args: '{"x":' })),
      delta(tc({ index: 0, args: '1}' })), delta(tc({ index: 1, args: ':2}' })),
      delta({}, 'tool_calls'), { data: '[DONE]' },
    ]));
    expect(events.map((e: any) => e.name)).toEqual(['second', 'first']);
    expect(events).toContainEqual({ type: 'tool_use', id: 'a', name: 'first', input: { x: 1 } });
    expect(events).toContainEqual({ type: 'tool_use', id: 'b', name: 'second', input: { y: 2 } });
  });

  it('a re-keyed index does not jump the queue: 0:x, 0:y, 1:z come out x, y, z', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'x', name: 'one', args: '{}' })),
      delta(tc({ index: 0, id: 'y', name: 'two', args: '{}' })),
      delta(tc({ index: 1, id: 'z', name: 'three', args: '{}' })),
      delta({}, 'tool_calls'),
    ]));
    expect(events.map((e: any) => e.id)).toEqual(['x', 'y', 'z']);
  });

  it('no index, id repeated on every fragment, no [DONE] -> one call', async () => {
    const events = await run(sseResponse([
      delta(tc({ id: 'call_1', name: 'get_apps', args: '{"q"' })),
      delta(tc({ id: 'call_1', args: ':"a"}' })),
      delta({}, 'tool_calls'),
    ]));
    expect(events).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_apps', input: { q: 'a' } }]);
  });

  it('no index, id only on the first fragment -> one call', async () => {
    const events = await run(sseResponse([
      delta(tc({ id: 'c', name: 'f', args: '{"a"' })), delta(tc({ args: ':1}' })), delta({}, 'tool_calls'),
    ]));
    expect(events).toEqual([{ type: 'tool_use', id: 'c', name: 'f', input: { a: 1 } }]);
  });

  it('same index with a different id starts a new call (servers that reuse index 0)', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'x', name: 'one', args: '{}' })),
      delta(tc({ index: 0, id: 'y', name: 'two', args: '{}' })),
      delta({}, 'tool_calls'),
    ]));
    expect(events.map((e: any) => e.name)).toEqual(['one', 'two']);
  });

  it('index reused by two calls whose arguments span several fragments: each keeps its own input', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'x', name: 'one', args: '{"a"' })),
      delta(tc({ index: 0, args: ':1' })), delta(tc({ index: 0, args: '}' })),
      delta(tc({ index: 0, id: 'y', name: 'two', args: '{"b":' })),
      delta(tc({ index: 0, args: '2}' })),
      delta({}, 'tool_calls'),
    ]));
    expect(events).toEqual([
      { type: 'tool_use', id: 'x', name: 'one', input: { a: 1 } },
      { type: 'tool_use', id: 'y', name: 'two', input: { b: 2 } },
    ]);
  });

  it('index reused, the id repeated on continuation fragments of the same call', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'x', name: 'one', args: '{"a"' })), delta(tc({ index: 0, id: 'x', args: ':1}' })),
      delta(tc({ index: 0, id: 'y', name: 'two', args: '{"b"' })), delta(tc({ index: 0, id: 'y', args: ':2}' })),
      delta({}, 'tool_calls'),
    ]));
    expect(events).toEqual([
      { type: 'tool_use', id: 'x', name: 'one', input: { a: 1 } },
      { type: 'tool_use', id: 'y', name: 'two', input: { b: 2 } },
    ]);
  });

  it('a late real id replaces a synthesised one instead of splitting the call (index)', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, name: 'f', args: '{"a"' })),
      delta(tc({ index: 0, id: 'real', args: ':1}' })),
      delta({}, 'tool_calls'),
    ]));
    expect(events).toEqual([{ type: 'tool_use', id: 'real', name: 'f', input: { a: 1 } }]);
  });

  it('a late real id replaces a synthesised one instead of splitting the call (no index)', async () => {
    const events = await run(sseResponse([
      delta(tc({ name: 'f', args: '{"a"' })),
      delta(tc({ id: 'real', args: ':1}' })),
      delta({}, 'tool_calls'),
    ]));
    expect(events).toEqual([{ type: 'tool_use', id: 'real', name: 'f', input: { a: 1 } }]);
  });

  it('a synthesised id is not adopted by a fragment that opens another named call', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, name: 'one', args: '{}' })),
      delta(tc({ index: 0, id: 'real', name: 'two', args: '{}' })),
      delta({}, 'tool_calls'),
    ]));
    expect(events).toEqual([
      { type: 'tool_use', id: 'id-1', name: 'one', input: {} },
      { type: 'tool_use', id: 'real', name: 'two', input: {} },
    ]);
  });

  it('a server-sent id is never replaced by a later, different id', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'x', name: 'one', args: '{"a":1}' })), delta(tc({ index: 0, id: 'y', args: '{}' })),
      delta({}, 'tool_calls'),
    ]));
    expect(events).toEqual([{ type: 'tool_use', id: 'x', name: 'one', input: { a: 1 } }]);
  });

  it('finish_reason before the last argument fragment: the incomplete call waits for the rest', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'a', name: 'f', args: '{"q":' })),
      delta({}, 'tool_calls'),
      delta(tc({ index: 0, args: '"v"}' })),
      { data: '[DONE]' },
    ]));
    expect(events).toEqual([{ type: 'tool_use', id: 'a', name: 'f', input: { q: 'v' } }]);
  });

  it('finish_reason before the last fragment, no [DONE]: flushed at the end of the stream', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'a', name: 'f', args: '{"q":' })),
      delta({}, 'tool_calls'),
      delta(tc({ index: 0, args: '"v"}' })),
    ]));
    expect(events).toEqual([{ type: 'tool_use', id: 'a', name: 'f', input: { q: 'v' } }]);
  });

  it('finish_reason with one complete and one incomplete call: the complete one is emitted at once, the other later', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'a', name: 'done', args: '{"k":1}' })),
      delta(tc({ index: 1, id: 'b', name: 'late', args: '{"q":' })),
      delta({}, 'tool_calls'),
      delta(tc({ index: 1, args: '2}' })),
      { data: '[DONE]' },
    ]));
    expect(events).toEqual([
      { type: 'tool_use', id: 'a', name: 'done', input: { k: 1 } },
      { type: 'tool_use', id: 'b', name: 'late', input: { q: 2 } },
    ]);
  });

  it('a deferred call never lets a later complete call jump ahead of it (start order is kept)', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'a', name: 'first', args: '{"x":' })),
      delta(tc({ index: 1, id: 'b', name: 'second', args: '{}' })),
      delta({}, 'tool_calls'),
      delta(tc({ index: 0, args: '1}' })),
      { data: '[DONE]' },
    ]));
    expect(events).toEqual([
      { type: 'tool_use', id: 'a', name: 'first', input: { x: 1 } },
      { type: 'tool_use', id: 'b', name: 'second', input: {} },
    ]);
  });

  it('a complete call that started after an incomplete one waits at finish_reason', async () => {
    const enc = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i === 0) {
          controller.enqueue(enc.encode(sseBody([
            delta(tc({ index: 0, id: 'a', name: 'first', args: '{"x":' })),
            delta(tc({ index: 1, id: 'b', name: 'second', args: '{}' })),
            delta({}, 'tool_calls'),
          ])));
          i++;
        } else if (i === 1) { await gate; controller.enqueue(enc.encode(sseBody([delta(tc({ index: 0, args: '1}' })), { data: '[DONE]' }]))); i++; }
        else controller.close();
      },
    });
    const it2 = openAiChatDialect.parseStream(new Response(body), makeCtx('openai-compatible'))[Symbol.asyncIterator]();
    const pending = it2.next();
    const early = await Promise.race([pending, new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 30))]);
    expect(early).toBe('waiting');                          // nothing is emitted while the first call is still incomplete
    release();
    const names: string[] = [];
    for (let n = await pending; !n.done; n = await it2.next()) names.push((n.value as any).name);
    expect(names).toEqual(['first', 'second']);
  });

  it('usage is emitted once at the end, after a call that was deferred past finish_reason', async () => {
    const events = await run(sseResponse([
      delta(tc({ index: 0, id: 'a', name: 'f', args: '{"q":' })),
      delta({}, 'tool_calls'),
      chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      delta(tc({ index: 0, args: '"v"}' })),
      { data: '[DONE]' },
    ]));
    expect(events).toEqual([
      { type: 'tool_use', id: 'a', name: 'f', input: { q: 'v' } },
      { type: 'usage', inputTokens: 7, outputTokens: 3 },
    ]);
  });

  it('a call that is complete at finish_reason is emitted before the trailing usage chunk is read', async () => {
    const enc = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i === 0) { controller.enqueue(enc.encode(sseBody([delta(tc({ index: 0, id: 'a', name: 'f', args: '{}' })), delta({}, 'tool_calls')]))); i++; }
        else if (i === 1) { await gate; controller.enqueue(enc.encode(sseBody([chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { data: '[DONE]' }]))); i++; }
        else controller.close();
      },
    });
    const it2 = openAiChatDialect.parseStream(new Response(body), makeCtx('openai-compatible'))[Symbol.asyncIterator]();
    const first = await it2.next();                       // would hang here if the call waited for the usage chunk
    expect(first.value).toEqual({ type: 'tool_use', id: 'a', name: 'f', input: {} });
    release();
    const rest: any[] = [];
    for (let n = await it2.next(); !n.done; n = await it2.next()) rest.push(n.value);
    expect(rest).toEqual([{ type: 'usage', inputTokens: 1, outputTokens: 1 }]);
  });

  it('logs when plain text is cut off by the output token limit', async () => {
    const events = await run(sseResponse([delta({ content: 'cut off' }, 'length')]), 'openrouter');
    expect(events).toEqual([{ type: 'text', text: 'cut off' }]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('OpenRouter response was cut off by the output token limit'));
  });

  it('does not log a cut-off line for a normal stop', async () => {
    await run(sseResponse([delta({ content: 'fine' }, 'stop')]), 'openrouter');
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('cut off'));
  });

  it('synthesises an id when the server sends none', async () => {
    const events = await run(sseResponse([delta(tc({ index: 0, name: 'f', args: '{}' })), delta({}, 'tool_calls')]));
    expect(events).toEqual([{ type: 'tool_use', id: 'id-1', name: 'f', input: {} }]);
  });

  it('empty arguments mean {}', async () => {
    const events = await run(sseResponse([delta(tc({ index: 0, id: 'a', name: 'f', args: '' })), delta({}, 'tool_calls')]));
    expect(events).toEqual([{ type: 'tool_use', id: 'a', name: 'f', input: {} }]);
  });

  it('a finish_reason without [DONE] is a complete stream', async () => {
    const events = await run(sseResponse([delta({ content: 'x' }, 'stop')]));
    expect(events).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('neither terminator but content seen: flushes leniently without throwing', async () => {
    const events = await run(sseResponse([delta({ content: 'partial' }), delta(tc({ index: 0, id: 'a', name: 'f', args: '{}' }))]));
    expect(events).toEqual([{ type: 'text', text: 'partial' }, { type: 'tool_use', id: 'a', name: 'f', input: {} }]);
  });

  it('text only, no finish_reason and no [DONE]: returns the text without throwing', async () => {
    expect(await run(sseResponse([delta({ content: 'just text' })]))).toEqual([{ type: 'text', text: 'just text' }]);
  });

  it('neither terminator and nothing seen: throws', async () => {
    await expect(run(sseResponse([]))).rejects.toThrow(/empty response/);
  });

  it('length with a truncated tool call throws OutputLimitError; length with text only does not', async () => {
    await expect(run(sseResponse([delta(tc({ index: 0, id: 'a', name: 'f', args: '{"q":"abc' })), delta({}, 'length')])))
      .rejects.toBeInstanceOf(OutputLimitError);
    const ok = await run(sseResponse([delta({ content: 'cut off' }, 'length')]));
    expect(ok).toEqual([{ type: 'text', text: 'cut off' }]);
  });

  it('malformed arguments that are not truncation still yield {}', async () => {
    const events = await run(sseResponse([delta(tc({ index: 0, id: 'a', name: 'f', args: '{not json' })), delta({}, 'tool_calls')]));
    expect(events).toEqual([{ type: 'tool_use', id: 'a', name: 'f', input: {} }]);
  });

  it('never emits a call without a name', async () => {
    const events = await run(sseResponse([delta(tc({ index: 0, id: 'a', args: '{}' })), delta({}, 'tool_calls')]));
    expect(events).toEqual([]);
  });

  it('classifies in-stream errors', async () => {
    await expect(run(sseResponse([chunk({ error: { code: 402, message: 'insufficient credits' } })]), 'openrouter')).rejects.toBeInstanceOf(QuotaExhaustedError);
    await expect(run(sseResponse([chunk({ error: { code: 429, message: 'slow' } })]), 'openrouter')).rejects.toBeInstanceOf(RateLimitError);
    await expect(run(sseResponse([chunk({ error: { message: 'boom' } })]), 'openrouter')).rejects.toThrow(/OpenRouter stream error: boom/);
    await expect(run(sseResponse([delta({}, 'error')]), 'openrouter')).rejects.toBeInstanceOf(AiProviderError);
  });

  describe('in-stream error codes, numeric and string', () => {
    const cases: Array<[string, Record<string, unknown>, Function]> = [
      ['numeric 402', { code: 402 }, QuotaExhaustedError],
      ['numeric 429', { code: 429 }, RateLimitError],
      ['numeric 502', { code: 502 }, OverloadedError],
      ['numeric 503', { code: 503 }, OverloadedError],
      ['numeric 529', { code: 529 }, OverloadedError],
      ['numeric 408', { code: 408 }, OverloadedError],
      ['numeric status 429', { status: 429 }, RateLimitError],
      ['string code rate_limit_exceeded', { type: 'requests', code: 'rate_limit_exceeded' }, RateLimitError],
      ['string type rate_limit_exceeded', { type: 'rate_limit_exceeded' }, RateLimitError],
      ['string type rate_limit_error', { type: 'rate_limit_error' }, RateLimitError],
      ['string code insufficient_quota', { code: 'insufficient_quota' }, QuotaExhaustedError],
      ['string type insufficient_quota', { type: 'insufficient_quota' }, QuotaExhaustedError],
      ['string code project_spend_limit_exceeded', { code: 'project_spend_limit_exceeded' }, QuotaExhaustedError],
      ['string type overloaded_error', { type: 'overloaded_error' }, OverloadedError],
      ['string code overloaded', { code: 'overloaded' }, OverloadedError],
      ['string code engine_overloaded', { code: 'engine_overloaded' }, OverloadedError],
      ['string code service_unavailable', { code: 'service_unavailable' }, OverloadedError],
      ['string type server_error', { type: 'server_error' }, AiProviderError],
      ['an unknown string code', { code: 'something_else' }, AiProviderError],
      ['a numeric 500', { code: 500 }, AiProviderError],
      ['no code at all', {}, AiProviderError],
    ];
    it.each(cases)('%s', async (_label, fields, cls) => {
      const err: any = await run(sseResponse([chunk({ error: { ...fields, message: 'upstream said no' } })]), 'openai').catch((e) => e);
      expect(err.constructor).toBe(cls);
      expect(err.message).toBe('OpenAI stream error: upstream said no');
      expect(err.provider).toBe('openai');
      if (cls === RateLimitError) expect(err.headers).toBeInstanceOf(Headers);
    });
  });

  it('finish_reason content_filter with nothing produced throws ModelRefusedError, so the router can try another model', async () => {
    const err: any = await run(sseResponse([delta({}, 'content_filter'), { data: '[DONE]' }]), 'openai').catch((e) => e);
    expect(err).toBeInstanceOf(ModelRefusedError);
    expect(err.message).toBe('OpenAI stopped this response (reason: content_filter).');
    expect(err.provider).toBe('openai');
  });

  it('finish_reason content_filter after content keeps it and adds a visible message instead of throwing', async () => {
    const events = await run(sseResponse([delta({ content: 'Sure, ' }), delta({}, 'content_filter'), { data: '[DONE]' }]), 'openai');
    expect(events).toEqual([
      { type: 'text', text: 'Sure, ' },
      { type: 'text', text: 'OpenAI stopped this response (reason: content_filter).' },
    ]);
  });

  it('Mistral finish_reason model_length is treated like length', async () => {
    await expect(run(sseResponse([delta(tc({ index: 0, id: 'a', name: 'f', args: '{"q":"abc' })), delta({}, 'model_length')]), 'mistral'))
      .rejects.toBeInstanceOf(OutputLimitError);
    const ok = await run(sseResponse([delta({ content: 'cut off' }, 'model_length')]), 'mistral');
    expect(ok).toEqual([{ type: 'text', text: 'cut off' }]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Mistral response was cut off by the output token limit'));
  });

  it('survives SSE comments, CRLF, and chunk splits mid-line', async () => {
    const events = await run(chunkedResponse([': OPENROUTER PROCESSING\r\n\r\ndata: {"choices":[{"delta":{"con', 'tent":"hi"},"finish_reason":"stop"}]}\r\n\r\n', 'data: [DONE]\r\n\r\n']));
    expect(events).toEqual([{ type: 'text', text: 'hi' }]);
  });

  describe('caller abort', () => {
    /** Deliver `chunk` as one network read and abort from the consumer on the first text event. */
    async function abortOnFirstText(chunk: string, signal?: AbortSignal) {
      const ac = new AbortController();
      const out: any[] = [];
      const res = chunkedResponse([chunk, sseBody([delta({ content: 'never read' }, 'stop')])]);
      for await (const e of openAiChatDialect.parseStream(res, makeCtx('openai-compatible'), signal ?? ac.signal)) {
        out.push(e);
        if (e.type === 'text') ac.abort();
      }
      return out;
    }

    it('abort after a partial tool call yields no tool_use and does not throw', async () => {
      const out = await abortOnFirstText(sseBody([delta({ content: 'a' }), delta(tc({ index: 0, id: 'c', name: 'f', args: '{"q":"ab' }))]));
      expect(out).toEqual([{ type: 'text', text: 'a' }]);
    });

    it('abort before any content does not throw "empty response"', async () => {
      const ac = new AbortController();
      ac.abort();
      const events = await collect(openAiChatDialect.parseStream(chunkedResponse([sseBody([delta({ content: 'x' })])]), makeCtx('openai-compatible'), ac.signal));
      expect(events).toEqual([]);
    });

    it('abort mid-stream does not emit the held usage event', async () => {
      const out = await abortOnFirstText(sseBody([delta({ content: 'a' }), chunk({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 9 } })]));
      expect(out).toEqual([{ type: 'text', text: 'a' }]);
    });

    it('abort on the text event of a chunk that also finishes the turn emits no tool_use', async () => {
      const out = await abortOnFirstText(sseBody([
        delta(tc({ index: 0, id: 'c', name: 'f', args: '{}' })),
        delta({ content: 'a' }, 'tool_calls'),
        chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ]));
      expect(out).toEqual([{ type: 'text', text: 'a' }]);
    });

    it('abort on the first tool_use of a multi-call flush stops the rest and the usage event', async () => {
      const ac = new AbortController();
      const res = chunkedResponse([sseBody([
        delta(tc({ index: 0, id: 'a', name: 'one', args: '{}' })),
        delta(tc({ index: 1, id: 'b', name: 'two', args: '{}' })),
        delta(tc({ index: 2, id: 'c', name: 'three', args: '{}' })),
        delta({}, 'tool_calls'),
        chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { data: '[DONE]' },
      ])]);
      const out: any[] = [];
      for await (const e of openAiChatDialect.parseStream(res, makeCtx('openai-compatible'), ac.signal)) {
        out.push(e);
        if (e.type === 'tool_use') ac.abort();
      }
      expect(out).toEqual([{ type: 'tool_use', id: 'a', name: 'one', input: {} }]);
    });

    it('events already buffered in the same read are dropped after an abort (no flush, no OutputLimitError)', async () => {
      const done = await abortOnFirstText(sseBody([delta({ content: 'a' }), delta(tc({ index: 0, id: 'c', name: 'f', args: '{}' })), delta({}, 'tool_calls')]));
      expect(done).toEqual([{ type: 'text', text: 'a' }]);
      const cut = await abortOnFirstText(sseBody([delta({ content: 'a' }), delta(tc({ index: 0, id: 'c', name: 'f', args: '{"q":"ab' })), delta({}, 'length')]));
      expect(cut).toEqual([{ type: 'text', text: 'a' }]);
    });
  });

  it('reports prompt_tokens_details.cached_tokens as cachedInputTokens; inputTokens stays prompt_tokens', async () => {
    const events = await run(sseResponse([
      delta({ content: 'a' }, 'stop'),
      chunk({ choices: [], usage: { prompt_tokens: 2048, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1920 } } }),
      { data: '[DONE]' },
    ]));
    expect(events).toEqual([{ type: 'text', text: 'a' }, { type: 'usage', inputTokens: 2048, outputTokens: 3, cachedInputTokens: 1920 }]);
  });
  it('no cachedInputTokens key when cached_tokens is zero, absent, or the details object is missing or null', async () => {
    for (const usage of [
      { prompt_tokens: 8, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
      { prompt_tokens: 8, completion_tokens: 1, prompt_tokens_details: {} },
      { prompt_tokens: 8, completion_tokens: 1, prompt_tokens_details: null },
      { prompt_tokens: 8, completion_tokens: 1 },
    ]) {
      const events = await run(sseResponse([delta({ content: 'a' }, 'stop'), chunk({ choices: [], usage }), { data: '[DONE]' }]));
      expect(events).toEqual([{ type: 'text', text: 'a' }, { type: 'usage', inputTokens: 8, outputTokens: 1 }]);
    }
  });
  it('a usage-only stream yields just usage', async () => {
    const events = await run(sseResponse([chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 0 } }), { data: '[DONE]' }]));
    expect(events).toEqual([{ type: 'usage', inputTokens: 5, outputTokens: 0 }]);
  });
});

describe('models and FIM', () => {
  it('lists /models and falls back to id when name is missing', () => {
    const ctx = makeCtx('mistral');
    const req = openAiChatDialect.buildListModels!(ctx);
    expect(req.url).toBe('https://api.mistral.ai/v1/models');
    expect(openAiChatDialect.parseModels!({ data: [{ id: 'a' }, { id: 'b', name: 'B' }] }).models)
      .toEqual([{ id: 'a', name: 'a' }, { id: 'b', name: 'B' }]);
  });
  it('builds a FIM request and reads the completion', () => {
    const built: any = openAiChatDialect.buildFim!(makeCtx('codestral'), { prefix: 'def f(', suffix: '): pass', maxOutputTokens: 256, stopSequences: ['\n\n\n'], temperature: 0 });
    expect(built.url).toBe('https://api.mistral.ai/v1/fim/completions');
    expect(built.body).toMatchObject({ model: 'codestral-latest', prompt: 'def f(', suffix: '): pass', max_tokens: 256, temperature: 0 });
    expect(openAiChatDialect.parseFim!({ choices: [{ message: { content: 'x: int' } }] })).toBe('x: int');
    expect(openAiChatDialect.parseFim!({ choices: [{ text: 'y' }] })).toBe('y');
    expect(openAiChatDialect.parseFim!({})).toBe('');
  });
});
