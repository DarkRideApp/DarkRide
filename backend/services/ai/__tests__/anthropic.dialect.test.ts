// backend/services/ai/__tests__/anthropic.dialect.test.ts
// fixtures: hand-written from https://platform.claude.com/docs/en/build-with-claude/streaming (wire shape only)
import { describe, it, expect } from 'vitest';
import { anthropicDialect } from '../dialects/anthropic-messages';
import { makeCtx } from '../test-ctx';
import { sseResponse, sseBody, chunkedResponse, collect } from '../test-helpers';
import { OutputLimitError, OverloadedError, RateLimitError, AiProviderError } from '../errors';
import type { AiToolDefinition } from '../../../../shared/types/ai-chat';

const ev = (type: string, extra: object = {}) => ({ event: type, data: JSON.stringify({ type, ...extra }) });
const start = (usage: object = { input_tokens: 7 }) => ev('message_start', { message: { usage } });
const text = (t: string) => ev('content_block_delta', { delta: { type: 'text_delta', text: t } });
const toolStart = (id: string, name: string) => ev('content_block_start', { content_block: { type: 'tool_use', id, name } });
const toolDelta = (json: string) => ev('content_block_delta', { delta: { type: 'input_json_delta', partial_json: json } });
const blockStop = () => ev('content_block_stop');
const msgDelta = (stop_reason: string, out: number, extra: object = {}) => ev('message_delta', { delta: { stop_reason, ...extra }, usage: { output_tokens: out } });
const stop = () => ev('message_stop');
const run = (events: any[]) => collect(anthropicDialect.parseStream(sseResponse(events), makeCtx('anthropic')));
const tools: AiToolDefinition[] = [{ name: 'get_apps', description: 'List', inputSchema: { properties: { q: { type: 'string' } } }, context: [] }];
const req = { messages: [{ role: 'user' as const, content: 'hi' }], systemPrompt: 'sys', tools };

describe('buildChat', () => {
  it('url, headers, and base body', () => {
    const b = anthropicDialect.buildChat(makeCtx('anthropic', { model: 'claude-sonnet-5-5' }), req, { stream: true });
    expect(b.url).toBe('https://api.anthropic.com/v1/messages');
    expect(b.headers['x-api-key']).toBe('sk-test-placeholder');
    expect(b.headers['anthropic-version']).toBe('2023-06-01');
    expect(b.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16000, system: 'sys', stream: true, cache_control: { type: 'ephemeral' } });
  });
  it('omits x-api-key when no key is configured', () => {
    const b = anthropicDialect.buildChat(makeCtx('anthropic', { apiKey: undefined }), req, { stream: true });
    expect(Object.keys(b.headers).map((k) => k.toLowerCase())).not.toContain('x-api-key');
    expect(b.headers['anthropic-version']).toBe('2023-06-01');
  });
  it('formats tools with input_schema', () => {
    const body: any = anthropicDialect.buildChat(makeCtx('anthropic'), req, { stream: true }).body;
    expect(body.tools).toEqual([{ name: 'get_apps', description: 'List', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }]);
  });
  it('never sends sampling, thinking, or tool_choice, even when asked for temperature', () => {
    const body: any = anthropicDialect.buildChat(makeCtx('anthropic'), { ...req, temperature: 0 }, { stream: true }).body;
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) expect(body[k]).toBeUndefined();
  });
  it('omits cache_control when cache is false, omits system when empty, passes stop_sequences and max tokens', () => {
    const body: any = anthropicDialect.buildChat(makeCtx('anthropic'), { ...req, systemPrompt: '', cache: false, stopSequences: ['\n\n\n'], maxOutputTokens: 256 }, { stream: true }).body;
    expect(body.cache_control).toBeUndefined();
    expect(body.system).toBeUndefined();
    expect(body.stop_sequences).toEqual(['\n\n\n']);
    expect(body.max_tokens).toBe(256);
  });
  it('sends output_config.effort only for 5.x models', () => {
    const r = { ...req, effort: 'low' as const };
    expect((anthropicDialect.buildChat(makeCtx('anthropic', { model: 'claude-haiku-5-5' }), r, { stream: true }).body as any).output_config).toEqual({ effort: 'low' });
    expect((anthropicDialect.buildChat(makeCtx('anthropic', { model: 'claude-opus-5-5' }), r, { stream: true }).body as any).output_config).toEqual({ effort: 'low' });
    expect((anthropicDialect.buildChat(makeCtx('anthropic', { model: 'claude-haiku-4-5-20251001' }), r, { stream: true }).body as any).output_config).toBeUndefined();
    expect((anthropicDialect.buildChat(makeCtx('anthropic', { model: 'claude-sonnet-4-6' }), r, { stream: true }).body as any).output_config).toBeUndefined();
  });
  it('matches the effort model pattern on a version boundary only', () => {
    const r = { ...req, effort: 'low' as const };
    const effort = (model: string) => (anthropicDialect.buildChat(makeCtx('anthropic', { model }), r, { stream: true }).body as any).output_config;
    for (const m of ['claude-opus-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5']) expect(effort(m)).toEqual({ effort: 'low' });
    for (const m of ['claude-opus-50', 'claude-opus-500-1', 'claude-opus-4-5']) expect(effort(m)).toBeUndefined();
  });
  it('merges consecutive tool results into one user message and keeps tool_use ids', () => {
    const body: any = anthropicDialect.buildChat(makeCtx('anthropic'), {
      ...req,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool_use', id: 't1', name: 'a', input: {} }, { type: 'tool_use', id: 't2', name: 'b', input: {} }] },
        { role: 'tool_result', toolUseId: 't1', content: 'r1' },
        { role: 'tool_result', toolUseId: 't2', content: 'r2' },
      ],
    }, { stream: true }).body;
    expect(body.messages[1].content).toEqual([{ type: 'tool_use', id: 't1', name: 'a', input: {} }, { type: 'tool_use', id: 't2', name: 'b', input: {} }]);
    expect(body.messages[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'r1' }, { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
    ] });
  });
});

describe('parseStream usage', () => {
  it('emits total input including cache once, and output as a delta from the cumulative count', async () => {
    const events = await run([
      start({ input_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 1 }),
      text('hi'), msgDelta('end_turn', 20), stop(),
    ]);
    expect(events).toEqual([
      { type: 'usage', inputTokens: 460, outputTokens: 0, cachedInputTokens: 400 },
      { type: 'text', text: 'hi' },
      { type: 'usage', inputTokens: 0, outputTokens: 20 },
    ]);
  });
  it('sums to the real total when message_delta usage repeats (cumulative)', async () => {
    const events = await run([start(), text('a'), msgDelta('end_turn', 5), msgDelta('end_turn', 9), stop()]);
    const out = events.filter((e) => e.type === 'usage').reduce((n, e: any) => n + e.outputTokens, 0);
    expect(out).toBe(9);
  });
  it('a lower cumulative output_tokens after a higher one never produces a negative delta', async () => {
    const events = await run([start(), text('a'), msgDelta('end_turn', 9), msgDelta('end_turn', 5), stop()]);
    const outs = events.filter((e) => e.type === 'usage').map((e: any) => e.outputTokens);
    expect(outs.every((n) => n >= 0)).toBe(true);
    expect(outs.reduce((n, x) => n + x, 0)).toBe(9);
  });
  it('no cachedInputTokens key when nothing was read from cache', async () => {
    const events = await run([start(), msgDelta('end_turn', 1), stop()]);
    expect((events[0] as any).cachedInputTokens).toBeUndefined();
  });
});

describe('parseStream content', () => {
  it('buffers a tool call from partial json and yields it once', async () => {
    const events = await run([start(), toolStart('tu_1', 'get_apps'), toolDelta('{"q":'), toolDelta('"x"}'), blockStop(), msgDelta('tool_use', 3), stop()]);
    expect(events.filter((e) => e.type === 'tool_use')).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'get_apps', input: { q: 'x' } }]);
  });
  it('ignores thinking, redacted_thinking, ping, and unknown events', async () => {
    const events = await run([
      start(), ev('ping'),
      ev('content_block_start', { content_block: { type: 'thinking' } }),
      ev('content_block_delta', { delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      ev('content_block_delta', { delta: { type: 'signature_delta', signature: 'abc' } }),
      ev('content_block_stop'), ev('something_new'), text('answer'), msgDelta('end_turn', 2), stop(),
    ]);
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'answer' }]);
  });
  it('a refusal becomes one visible message and does not throw', async () => {
    const events = await run([start(), msgDelta('refusal', 0, { stop_details: { type: 'refusal', category: 'cyber' } }), stop()]);
    const t = events.filter((e) => e.type === 'text') as any[];
    expect(t).toHaveLength(1);
    expect(t[0].text).toContain('Claude declined this request');
    expect(t[0].text).toContain('cyber');
    expect(t[0].text).toContain('Cyber Verification Program');
  });
  it('a refusal with a null category still reads sensibly', async () => {
    const events = await run([start(), msgDelta('refusal', 0, { stop_details: { type: 'refusal', category: null } }), stop()]);
    expect((events.find((e) => e.type === 'text') as any).text).toBe('Claude declined this request.');
  });
  it('keeps the refusal category when a later usage-only message_delta arrives', async () => {
    const events = await run([
      start(),
      msgDelta('refusal', 0, { stop_details: { type: 'refusal', category: 'cyber' } }),
      ev('message_delta', { delta: {}, usage: { output_tokens: 4 } }),
      stop(),
    ]);
    const t = events.filter((e) => e.type === 'text') as any[];
    expect(t).toHaveLength(1);
    expect(t[0].text).toContain('(category: cyber)');
    expect(t[0].text).toContain('Cyber Verification Program');
  });
  it('keeps the refusal category when a repeated refusal delta carries no stop_details', async () => {
    const events = await run([
      start(),
      msgDelta('refusal', 0, { stop_details: { type: 'refusal', category: 'cyber' } }),
      msgDelta('refusal', 0),
      stop(),
    ]);
    expect((events.find((e) => e.type === 'text') as any).text).toContain('(category: cyber)');
  });
  it('reads stop_details from the top level of the message_delta event as well as from delta', async () => {
    const events = await run([
      start(),
      ev('message_delta', { delta: { stop_reason: 'refusal' }, stop_details: { type: 'refusal', category: 'cyber' }, usage: { output_tokens: 0 } }),
      stop(),
    ]);
    const t = events.filter((e) => e.type === 'text') as any[];
    expect(t).toHaveLength(1);
    expect(t[0].text).toContain('(category: cyber)');
    expect(t[0].text).toContain('Cyber Verification Program');
  });
  it('ignores a non-string refusal category', async () => {
    for (const category of [42, { a: 1 }, ['cyber'], true]) {
      const events = await run([start(), msgDelta('refusal', 0, { stop_details: { type: 'refusal', category } }), stop()]);
      expect((events.find((e) => e.type === 'text') as any).text).toBe('Claude declined this request.');
    }
  });
  it('redacts the api key if it appears inside the refusal category', async () => {
    const events = await run([start(), msgDelta('refusal', 0, { stop_details: { type: 'refusal', category: 'x-sk-test-placeholder-y' } }), stop()]);
    const text = (events.find((e) => e.type === 'text') as any).text as string;
    expect(text).not.toContain('sk-test-placeholder');
    expect(text).toContain('(category: x-***-y)');
  });
  it('caps an oversized refusal category', async () => {
    const events = await run([start(), msgDelta('refusal', 0, { stop_details: { type: 'refusal', category: 'a'.repeat(5000) } }), stop()]);
    expect(((events.find((e) => e.type === 'text') as any).text as string).length).toBeLessThan(700);
  });
  it('a tool_use block with no input_json_delta yields an empty input object', async () => {
    const events = await run([start(), toolStart('tu_1', 'get_apps'), blockStop(), msgDelta('tool_use', 3), stop()]);
    expect(events.filter((e) => e.type === 'tool_use')).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'get_apps', input: {} }]);
  });
  it('yields two separate tool_use events for back-to-back tool_use blocks', async () => {
    const events = await run([
      start(),
      toolStart('tu_1', 'get_apps'), toolDelta('{"q":"a"}'), blockStop(),
      toolStart('tu_2', 'get_devices'), toolDelta('{"q":"b"}'), blockStop(),
      msgDelta('tool_use', 6), stop(),
    ]);
    expect(events.filter((e) => e.type === 'tool_use')).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'get_apps', input: { q: 'a' } },
      { type: 'tool_use', id: 'tu_2', name: 'get_devices', input: { q: 'b' } },
    ]);
  });
  it('max_tokens and context-window stops throw OutputLimitError with the legacy text', async () => {
    await expect(run([start(), text('x'), msgDelta('max_tokens', 9), stop()])).rejects.toThrow('Anthropic response reached its output token limit');
    await expect(run([start(), msgDelta('model_context_window_exceeded', 0), stop()])).rejects.toBeInstanceOf(OutputLimitError);
  });
  it('throws when the stream ends before message_stop', async () => {
    await expect(run([start(), text('x')])).rejects.toThrow(/before message_stop/);
  });
  it('an abort between reads ends the stream quietly instead of reporting a truncated response', async () => {
    const ac = new AbortController();
    const first = sseBody([start(), text('a')]);
    const second = sseBody([text('b'), msgDelta('end_turn', 2), stop()]);
    const out: any[] = [];
    for await (const e of anthropicDialect.parseStream(chunkedResponse([first, second]), makeCtx('anthropic'), ac.signal)) {
      out.push(e);
      if (e.type === 'text') ac.abort();      // the consumer cancels; the parser must not throw "before message_stop"
    }
    expect(out.some((e) => e.type === 'text')).toBe(true);
  });
  it('classifies in-stream errors', async () => {
    await expect(run([ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })])).rejects.toBeInstanceOf(OverloadedError);
    await expect(run([ev('error', { error: { type: 'rate_limit_error', message: 'slow' } })])).rejects.toBeInstanceOf(RateLimitError);
    await expect(run([ev('error', { error: { type: 'api_error', message: 'boom' } })])).rejects.toThrow('Anthropic stream error: boom');
    await expect(run([ev('error', { error: { type: 'api_error', message: 'boom' } })])).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('models', () => {
  it('requests limit=1000 and follows after_id', () => {
    const ctx = makeCtx('anthropic');
    expect(anthropicDialect.buildListModels!(ctx).url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(anthropicDialect.buildListModels!(ctx, 'abc').url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=abc');
    expect(anthropicDialect.parseModels!({ data: [{ id: 'm1', display_name: 'M1' }, { id: 'm2' }], has_more: true, last_id: 'm2' }))
      .toEqual({ models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'm2' }], next: 'm2' });
    expect(anthropicDialect.parseModels!({ data: [], has_more: false }).next).toBeUndefined();
  });
});
