// fixtures: hand-written from https://ai.google.dev/api/generate-content (wire shape only)
import { describe, it, expect } from 'vitest';
import { geminiDialect } from '../dialects/gemini-generate';
import { makeCtx } from '../test-ctx';
import { sseResponse, collect } from '../test-helpers';
import { classifyHttpError } from '../http';
import { AiProviderError, AuthError, OverloadedError, QuotaExhaustedError, RateLimitError } from '../errors';

const chunk = (o: unknown) => ({ data: JSON.stringify(o) });
const parts = (p: unknown[], extra: object = {}) => chunk({ candidates: [{ content: { role: 'model', parts: p }, ...extra }] });
const run = (events: any[]) => collect(geminiDialect.parseStream(sseResponse(events), makeCtx('gemini')));
const thrown = async (events: any[]): Promise<any> => {
  try { await collect(geminiDialect.parseStream(sseResponse(events), makeCtx('gemini'))); } catch (e) { return e; }
  throw new Error('expected parseStream to throw');
};
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
  it('a plain user text turn after tool results is never merged into the functionResponse turn', () => {
    const body: any = geminiDialect.buildChat(makeCtx('gemini'), {
      ...req,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'first', input: {} }] },
        { role: 'tool_result', toolUseId: 'a', content: 'ra' },
        { role: 'user', content: 'thanks' },
        { role: 'tool_result', toolUseId: 'a', content: 'again' },
      ],
    }, { stream: true }).body;
    expect(body.contents).toHaveLength(5);
    expect(body.contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'first', response: { result: 'ra' } } }] });
    expect(body.contents[3]).toEqual({ role: 'user', parts: [{ text: 'thanks' }] });
    expect(body.contents[4]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'first', response: { result: 'again' } } }] });
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
  it('MAX_TOKENS does not throw and still yields the text it produced', async () => {
    await expect(run([parts([{ text: 'cut' }], { finishReason: 'MAX_TOKENS' })])).resolves.toEqual([{ type: 'text', text: 'cut' }]);
  });
  it('skips thought parts so reasoning never reaches the chat', async () => {
    const events = await run([parts([{ text: 'secret reasoning', thought: true }, { text: 'answer' }])]);
    expect(events).toEqual([{ type: 'text', text: 'answer' }]);
  });
  it('skips chunks that are not JSON objects instead of throwing', async () => {
    const events = await run([
      { data: 'null' }, { data: '7' }, { data: '"str"' }, { data: 'not json at all' }, { data: '[]' },
      parts([{ text: 'ok' }]),
    ]);
    expect(events).toEqual([{ type: 'text', text: 'ok' }]);
  });
  it('redacts the key out of a hostile blockReason', async () => {
    const events = await run([chunk({ promptFeedback: { blockReason: 'bad sk-test-placeholder bad' } })]);
    const text = (events.find((e) => e.type === 'text') as any).text as string;
    expect(text).toContain('***');
    expect(text).not.toContain('sk-test-placeholder');
  });
});

describe('in-stream error classification', () => {
  it.each([503, 502])('code %i is OverloadedError', async (code) => {
    const e = await thrown([chunk({ error: { code, message: 'overloaded' } })]);
    expect(e).toBeInstanceOf(OverloadedError);
    expect(e.status).toBe(code);
    expect(e.message).toBe('Gemini stream error: overloaded');
  });
  it('a plain 429 is RateLimitError with an empty Headers, not quota', async () => {
    const e = await thrown([chunk({ error: { code: 429, message: 'slow down' } })]);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).not.toBeInstanceOf(QuotaExhaustedError);
    expect(e.headers).toBeInstanceOf(Headers);
    expect(e.status).toBe(429);
  });
  it('the real 429 RESOURCE_EXHAUSTED billing payload is QuotaExhaustedError', async () => {
    const e = await thrown([chunk({ error: {
      code: 429, status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota, please check your plan and billing details.',
    } })]);
    expect(e).toBeInstanceOf(QuotaExhaustedError);
    expect(e).not.toBeInstanceOf(RateLimitError);
    expect(e.status).toBe(429);
  });
  it('RESOURCE_EXHAUSTED without billing or quota wording stays RateLimitError', async () => {
    const e = await thrown([chunk({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Try again shortly' } })]);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).not.toBeInstanceOf(QuotaExhaustedError);
  });
  it('a 500 is a plain AiProviderError, not overloaded, rate-limited or quota', async () => {
    const e = await thrown([chunk({ error: { code: 500, message: 'internal' } })]);
    expect(e.constructor).toBe(AiProviderError);
    expect(e).not.toBeInstanceOf(OverloadedError);
    expect(e).not.toBeInstanceOf(RateLimitError);
    expect(e).not.toBeInstanceOf(QuotaExhaustedError);
    expect(e.status).toBe(500);
  });
  it('a string code is coerced, so "503" is OverloadedError', async () => {
    const e = await thrown([chunk({ error: { code: '503', message: 'overloaded' } })]);
    expect(e).toBeInstanceOf(OverloadedError);
    expect(e.status).toBe(503);
  });
  it('status UNAVAILABLE without a code is OverloadedError', async () => {
    const e = await thrown([chunk({ error: { status: 'UNAVAILABLE', message: 'try later' } })]);
    expect(e).toBeInstanceOf(OverloadedError);
  });
  it('a string error body keeps its message', async () => {
    const e = await thrown([chunk({ error: 'boom' })]);
    expect(e.constructor).toBe(AiProviderError);
    expect(e.message).toBe('Gemini stream error: boom');
  });
  it.each([
    ['empty string', ''], ['null', null], ['undefined', undefined], ['an object', {}], ['zero', 0], ['negative', -1], ['NaN (serialises to null)', NaN],
  ])('a %s code is a plain AiProviderError with no status', async (_label, code) => {
    const e = await thrown([chunk({ error: { code, message: 'boom' } })]);
    expect(e.constructor).toBe(AiProviderError);
    expect(e.status).toBeUndefined();
    expect(e.message).toBe('Gemini stream error: boom');
  });
  it('RESOURCE_EXHAUSTED with no code and no billing wording is RateLimitError, not a plain error', async () => {
    const e = await thrown([chunk({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } })]);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).not.toBeInstanceOf(QuotaExhaustedError);
  });
  it('redacts the key from the thrown message', async () => {
    const e = await thrown([chunk({ error: { code: 500, message: 'bad key sk-test-placeholder rejected' } })]);
    expect(e.message).toContain('***');
    expect(e.message).not.toContain('sk-test-placeholder');
  });
});

const BILLING_MSG = 'You exceeded your current quota, please check your plan and billing details.';
const quotaDetails = (...quotaIds: string[]) => [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: quotaIds.map((quotaId) => ({
    quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId, quotaDimensions: { location: 'global', model: 'gemini-2.5-flash' }, quotaValue: '20',
  })) },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' },
];
// [label, error fields, is the credential's quota really exhausted]. When unsure the answer is "no" (RateLimit):
// calling a transient limit Quota would bench every model on the credential for the full cooldown.
const QUOTA_CASES: Array<[string, object, boolean]> = [
  ['PerMinute quotaId beats billing wording', { message: BILLING_MSG, details: quotaDetails('GenerateRequestsPerMinutePerProjectPerModel-FreeTier') }, false],
  ['PerDay quotaId', { message: 'Quota exceeded for metric', details: quotaDetails('GenerateRequestsPerDayPerProjectPerModel-FreeTier') }, true],
  ['PerMinute and PerDay violated together', { message: 'Quota exceeded', details: quotaDetails('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier') }, true],
  ['unrecognised quotaId plus billing wording', { message: BILLING_MSG, details: quotaDetails('SomeNewQuotaName-FreeTier') }, false],
  ['transient text that mentions quota but not billing', { message: 'Resource has been exhausted (e.g. check quota).' }, false],
  ['unstructured billing wording', { message: BILLING_MSG }, true],
];

describe.each(QUOTA_CASES)('quota or rate limit: %s', (_label, fields, isQuota) => {
  const error = { code: 429, status: 'RESOURCE_EXHAUSTED', ...fields };
  const expectKind = (e: any) => {
    if (isQuota) { expect(e).toBeInstanceOf(QuotaExhaustedError); expect(e).not.toBeInstanceOf(RateLimitError); }
    else { expect(e).toBeInstanceOf(RateLimitError); expect(e).not.toBeInstanceOf(QuotaExhaustedError); }
    expect(e.status).toBe(429);
  };
  it('in-stream', async () => { expectKind(await thrown([chunk({ error })])); });
  it('HTTP 429 through classifyHttpError', () => {
    const headers = new Headers({ 'retry-after': '7' });
    const e: any = classifyHttpError(geminiDialect, makeCtx('gemini'), 429, headers, JSON.stringify({ error }));
    expectKind(e);
    if (isQuota) expect(e.message).toBe(`Gemini API error (429): ${(fields as any).message}`);
    else expect(e.headers.get('retry-after')).toBe('7');   // the generic path keeps the headers for the cooldown
  });
  it('classifyError returns a QuotaExhaustedError for a quota 429 and defers otherwise', () => {
    const r = geminiDialect.classifyError!(429, new Headers(), JSON.stringify({ error }));
    if (isQuota) expect(r).toBeInstanceOf(QuotaExhaustedError); else expect(r).toBeUndefined();
  });
});

describe('classifyError', () => {
  const badKeyBody = JSON.stringify({ error: {
    code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
  } });
  it('a 400 for a bad key is AuthError (Gemini does not answer 401)', () => {
    const e = geminiDialect.classifyError!(400, new Headers(), badKeyBody) as any;
    expect(e).toBeInstanceOf(AuthError);
    expect(e.status).toBe(400);
    expect(e.message).toBe('Gemini API error (400): API key not valid. Please pass a valid API key.');
  });
  it('matches on the reason code alone, and on a non-JSON body', () => {
    expect(geminiDialect.classifyError!(400, new Headers(), '{"error":{"message":"x","details":[{"reason":"API_KEY_INVALID"}]}}')).toBeInstanceOf(AuthError);
    const e = geminiDialect.classifyError!(400, new Headers(), '<html>API key not valid</html>') as any;
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toContain('API key not valid');
  });
  it('a JSON 400 that merely echoes the phrase mid-sentence is not treated as a bad key', () => {
    const proxy = JSON.stringify({ error: { code: 400, message: 'upstream said: API key not valid', status: 'INVALID_ARGUMENT' } });
    expect(geminiDialect.classifyError!(400, new Headers(), proxy)).toBeUndefined();
    const reasonText = JSON.stringify({ error: { code: 400, message: 'bad field, see API_KEY_INVALID in the docs' } });
    expect(geminiDialect.classifyError!(400, new Headers(), reasonText)).toBeUndefined();
    expect(classifyHttpError(geminiDialect, makeCtx('gemini'), 400, new Headers(), proxy).constructor).toBe(AiProviderError);
  });
  it('a JSON 400 whose message starts with the phrase matches, with no details', () => {
    const body = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } });
    expect(geminiDialect.classifyError!(400, new Headers(), body)).toBeInstanceOf(AuthError);
  });
  it('the hook leaves capping to classifyHttpError, which caps the final message at 1000 characters', () => {
    const body = `API key not valid ${'x'.repeat(5000)}`;
    expect((geminiDialect.classifyError!(400, new Headers(), body) as any).message.length).toBeGreaterThan(1000);
    const e = classifyHttpError(geminiDialect, makeCtx('gemini'), 400, new Headers(), body);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message.length).toBeLessThanOrEqual(1000);
  });
  it('an unrelated 400 and other statuses return undefined', () => {
    expect(geminiDialect.classifyError!(400, new Headers(), '{"error":{"code":400,"message":"Invalid JSON payload","status":"INVALID_ARGUMENT"}}')).toBeUndefined();
    expect(geminiDialect.classifyError!(500, new Headers(), badKeyBody)).toBeUndefined();
    expect(geminiDialect.classifyError!(429, new Headers(), '{}')).toBeUndefined();
  });
  it('classifyHttpError uses the hook for a bad-key 400 and falls through for others', () => {
    const ctx = makeCtx('gemini');
    expect(classifyHttpError(geminiDialect, ctx, 400, new Headers(), badKeyBody)).toBeInstanceOf(AuthError);
    expect(classifyHttpError(geminiDialect, ctx, 400, new Headers(), '{"error":{"message":"Invalid JSON payload"}}').constructor).toBe(AiProviderError);
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

// A key an upstream echoes back must be redacted BEFORE any length cap, or a key straddling the cut leaves a prefix behind.
describe('key echoed by the upstream never survives, even straddling a cap (real dialect through classifyHttpError)', () => {
  const KEY = 'AIzaSyPLACEHOLDERKEY1234567890abcd';
  const bodies: Record<string, (message: string) => { status: number; body: string; cls: Function }> = {
    'bad-key 400': (message) => ({
      status: 400, cls: AuthError,
      body: JSON.stringify({ error: { code: 400, message, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }),
    }),
    'quota 429': (message) => ({
      status: 429, cls: QuotaExhaustedError,
      body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `${message} billing details` } }),
    }),
  };
  const rows = Object.keys(bodies).flatMap((path) => [0, 480, 490, 495, 499].map((offset) => [path, offset] as const));
  it.each(rows)('%s, key echoed at offset %i', (path, offset) => {
    const { status, body, cls } = bodies[path](`${'x'.repeat(offset)}${KEY} tail`);
    const e = classifyHttpError(geminiDialect, makeCtx('gemini', { apiKey: KEY }), status, new Headers(), body);
    expect(e).toBeInstanceOf(cls);
    expect(e.message).toContain('***');
    expect(e.message.length).toBeLessThanOrEqual(1000);
    for (const text of [e.message, String(e.stack)]) {
      expect(text).not.toContain(KEY);
      // any 4+ character prefix of the key contains the first four characters
      expect(text).not.toContain(KEY.slice(0, 4));
    }
  });
});

describe('malformed error shapes never throw and land on the safe side', () => {
  const BILLING = 'check your plan and billing details';
  const exhausted = (fields: object) => ({ code: 429, status: 'RESOURCE_EXHAUSTED', ...fields });
  const viol = (v: unknown) => [{ violations: v }];

  // [label, error object, expected class for the stream path]
  const STREAM_ROWS: Array<[string, any, Function]> = [
    ['details is an object', exhausted({ message: 'm', details: { violations: [{ quotaId: 'PerDay' }] } }), RateLimitError],
    ['details is a string', exhausted({ message: 'm', details: 'PerDay' }), RateLimitError],
    ['details is null', exhausted({ message: 'm', details: null }), RateLimitError],
    ['details is null with billing wording', exhausted({ message: BILLING, details: null }), QuotaExhaustedError],
    ['violations is missing', exhausted({ message: 'm', details: [{}] }), RateLimitError],
    ['violations is an object', exhausted({ message: 'm', details: viol({ quotaId: 'PerDay' }) }), RateLimitError],
    ['violations is a string', exhausted({ message: 'm', details: viol('PerDay') }), RateLimitError],
    ['details entries are null, a number and an array', exhausted({ message: 'm', details: [null, 5, [], 'x'] }), RateLimitError],
    ['violations entries are null, a number, a string and an array', exhausted({ message: 'm', details: viol([null, 3, 'PerDay', []]) }), RateLimitError],
    ['quotaId is a number', exhausted({ message: 'm', details: viol([{ quotaId: 5 }]) }), RateLimitError],
    ['quotaId is null and quotaMetric an object', exhausted({ message: 'm', details: viol([{ quotaId: null, quotaMetric: {} }]) }), RateLimitError],
    ['message is missing', exhausted({}), RateLimitError],
    ['message is numeric', exhausted({ message: 12345 }), RateLimitError],
    ['message is an object', exhausted({ message: { billing: true } }), RateLimitError],
    ['code is the string "429"', { code: '429', message: 'm' }, RateLimitError],
    ['code is the string "429" with billing wording and status', { code: '429', status: 'RESOURCE_EXHAUSTED', message: BILLING }, QuotaExhaustedError],
    ['error is true', true, AiProviderError],
    ['error is a number', 42, AiProviderError],
    ['error is an empty array', [], AiProviderError],
    ['error is an empty object', {}, AiProviderError],
  ];
  it.each(STREAM_ROWS)('stream: %s', async (_label, error, cls) => {
    const e = await thrown([chunk({ error })]);
    expect(e.constructor).toBe(cls);
  });

  it.each([[null], ['str'], [429], [undefined]])('classifyStreamError called with a %s payload returns a plain AiProviderError', (payload) => {
    const e = geminiDialect.classifyStreamError!(payload, makeCtx('gemini')) as any;
    expect(e.constructor).toBe(AiProviderError);
    expect(e.status).toBeUndefined();
  });

  // [label, raw body]: the hook must answer undefined, and the generic path must still classify without throwing.
  const BODY_ROWS: Array<[string, string]> = [
    ['a JSON string', '"str"'],
    ['a JSON array', '[1]'],
    ['JSON null', 'null'],
    ['a JSON number', '429'],
    ['error: null', '{"error":null}'],
    ['error: true', '{"error":true}'],
    ['error: a string', '{"error":"API key not valid"}'],
    ['error: an array', '{"error":[{"message":"billing"}]}'],
    ['an empty body', ''],
    ['an HTML page', '<html><body><h1>502 Bad Gateway</h1></body></html>'],
  ];
  it.each(BODY_ROWS)('HTTP 429 with %s: hook defers, generic path gives RateLimitError', (_label, body) => {
    expect(geminiDialect.classifyError!(429, new Headers(), body)).toBeUndefined();
    const headers = new Headers({ 'retry-after': '3' });
    const e: any = classifyHttpError(geminiDialect, makeCtx('gemini'), 429, headers, body);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.headers.get('retry-after')).toBe('3');
  });
  it.each(BODY_ROWS)('HTTP 400 with %s: hook defers, generic path gives a plain AiProviderError', (_label, body) => {
    expect(geminiDialect.classifyError!(400, new Headers(), body)).toBeUndefined();
    expect(classifyHttpError(geminiDialect, makeCtx('gemini'), 400, new Headers(), body).constructor).toBe(AiProviderError);
  });

  it.each([
    ['details is an object', { message: 'm', details: { violations: [{ quotaId: 'PerDay' }] } }],
    ['details is null', { message: 'm', details: null }],
    ['details entries are null, a number and an array', { message: 'm', details: [null, 5, []] }],
    ['violations is an object', { message: 'm', details: viol({ quotaId: 'PerDay' }) }],
    ['violations entries are null, a number and an array', { message: 'm', details: viol([null, 3, []]) }],
    ['quotaId is a number', { message: 'm', details: viol([{ quotaId: 5 }]) }],
    ['message is missing', {}],
    ['message is numeric', { message: 429 }],
  ])('HTTP 429 body whose error has %s: hook defers', (_label, error) => {
    expect(geminiDialect.classifyError!(429, new Headers(), JSON.stringify({ error }))).toBeUndefined();
  });
});
