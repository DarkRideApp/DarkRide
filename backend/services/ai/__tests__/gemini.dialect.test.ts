// fixtures: hand-written from https://ai.google.dev/api/generate-content (wire shape only)
import { describe, it, expect } from 'vitest';
import { geminiDialect } from '../dialects/gemini-generate';
import { makeCtx } from '../test-ctx';
import { sseResponse, collect } from '../test-helpers';
import { AiProviderError } from '../errors';

const chunk = (o: unknown) => ({ data: JSON.stringify(o) });
const parts = (p: unknown[], extra: object = {}) => chunk({ candidates: [{ content: { role: 'model', parts: p }, ...extra }] });
const run = (events: any[]) => collect(geminiDialect.parseStream(sseResponse(events), makeCtx('gemini')));
const req = { messages: [{ role: 'user' as const, content: 'hi' }], systemPrompt: 'sys', tools: [] };

describe('buildChat', () => {
  it('uses the header for the key, never the URL, and the streaming endpoint', () => {
    const b = geminiDialect.buildChat(makeCtx('gemini', { model: 'gemini-2.5-flash' }), req, { stream: true });
    expect(b.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(b.url).not.toContain('key=');
    expect(b.headers['x-goog-api-key']).toBe('sk-test-placeholder');
  });
  it('system instruction, tools as functionDeclarations, generationConfig only when needed', () => {
    const body: any = geminiDialect.buildChat(makeCtx('gemini'), {
      ...req, tools: [{ name: 'f', description: 'd', inputSchema: { type: 'object', properties: {} }, context: [] }],
      maxOutputTokens: 256, stopSequences: ['x'], temperature: 0,
    }, { stream: true }).body;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }] }]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 256, stopSequences: ['x'], temperature: 0 });
    const plain: any = geminiDialect.buildChat(makeCtx('gemini'), req, { stream: true }).body;
    expect(plain.generationConfig).toBeUndefined();
    expect(plain.tools).toBeUndefined();
  });
  it('tool results carry the real function name and parallel results merge into one user turn', () => {
    const body: any = geminiDialect.buildChat(makeCtx('gemini'), {
      ...req,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'first', input: { x: 1 } }, { type: 'tool_use', id: 'b', name: 'second', input: {} }] },
        { role: 'tool_result', toolUseId: 'a', content: 'ra' },
        { role: 'tool_result', toolUseId: 'b', content: 'rb' },
      ],
    }, { stream: true }).body;
    expect(body.contents).toHaveLength(3);
    expect(body.contents[2]).toEqual({ role: 'user', parts: [
      { functionResponse: { name: 'first', response: { result: 'ra' } } },
      { functionResponse: { name: 'second', response: { result: 'rb' } } },
    ] });
  });
  it('an orphan tool result keeps the literal name tool_result; empty assistant turns are dropped', () => {
    const body: any = geminiDialect.buildChat(makeCtx('gemini'), {
      ...req, messages: [{ role: 'assistant', content: [] }, { role: 'tool_result', toolUseId: 'zzz', content: 'r' }],
    }, { stream: true }).body;
    expect(body.contents).toEqual([{ role: 'user', parts: [{ functionResponse: { name: 'tool_result', response: { result: 'r' } } }] }]);
  });
});

describe('parseStream', () => {
  it('yields text and function calls with generated ids, and usage once from the last chunk', async () => {
    const events = await run([
      parts([{ text: 'Hel' }], {}), chunk({ candidates: [{ content: { parts: [{ text: 'lo' }, { functionCall: { name: 'f', args: { a: 1 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3 } }),
    ]);
    expect(events).toEqual([
      { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' },
      { type: 'tool_use', id: 'id-1', name: 'f', input: { a: 1 } },
      { type: 'usage', inputTokens: 5, outputTokens: 5 },
    ]);
  });
  it('usage reported on every chunk is emitted once', async () => {
    const um = (p: number, c: number) => ({ usageMetadata: { promptTokenCount: p, candidatesTokenCount: c } });
    const events = await run([chunk({ candidates: [{ content: { parts: [{ text: 'a' }] } }], ...um(5, 1) }), chunk({ candidates: [{ content: { parts: [{ text: 'b' }] } }], ...um(5, 4) })]);
    expect(events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 5, outputTokens: 4 }]);
  });
  it('safety and blocked stops become a visible message', async () => {
    for (const reason of ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'MALFORMED_FUNCTION_CALL']) {
      const events = await run([chunk({ candidates: [{ finishReason: reason }] })]);
      const t = events.find((e) => e.type === 'text') as any;
      expect(t.text).toContain(reason);
    }
    const blocked = await run([chunk({ promptFeedback: { blockReason: 'OTHER' } })]);
    expect((blocked.find((e) => e.type === 'text') as any).text).toContain('OTHER');
  });
  it('MAX_TOKENS does not throw', async () => {
    const events = await run([parts([{ text: 'cut' }], { finishReason: 'MAX_TOKENS' })]);
    expect(events).toEqual([{ type: 'text', text: 'cut' }]);
  });
  it('classifies an in-stream error object', async () => {
    await expect(run([chunk({ error: { code: 503, message: 'overloaded' } })])).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('models', () => {
  it('lists with pageSize 1000, paginates, strips models/ and keeps generateContent models', () => {
    const ctx = makeCtx('gemini');
    expect(geminiDialect.buildListModels!(ctx).url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect(geminiDialect.buildListModels!(ctx, 'tok').url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=tok');
    const r = geminiDialect.parseModels!({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
      ], nextPageToken: 'n2',
    });
    expect(r).toEqual({ models: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }], next: 'n2' });
  });
});
