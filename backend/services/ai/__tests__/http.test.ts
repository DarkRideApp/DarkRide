import { describe, it, expect, afterEach, vi } from 'vitest';
import { classifyHttpError, redact, safeText, upstreamMessage, sendChat, parseSSEStream } from '../http';
import { AuthError, QuotaExhaustedError, RateLimitError, OverloadedError, ConnectionError, AiProviderError } from '../errors';
import { getProviderDescriptor } from '../../../../shared/lib/ai-provider-catalog';
import type { Dialect, DialectContext } from '../dialect';
import { stubFetch, jsonResponse, textResponse, sseResponse, chunkedResponse } from '../test-helpers';

afterEach(() => vi.unstubAllGlobals());

const ctxFor = (id: string, extra: Partial<DialectContext> = {}): DialectContext => ({
  descriptor: getProviderDescriptor(id)!, baseUrl: 'https://x.test', apiKey: 'sk-test-placeholder',
  model: 'm', newId: () => 'id-1', flags: {}, ...extra,
});
const nullDialect: Dialect = {
  id: 'openai-chat',
  buildChat: (ctx) => ({ url: `${ctx.baseUrl}/chat`, headers: { authorization: `Bearer ${ctx.apiKey}` }, body: { m: ctx.model, flag: ctx.flags.noStreamUsage ?? false } }),
  parseStream: async function* () {},
};

describe('classifyHttpError', () => {
  const cls = (status: number, body: string, headers: Record<string, string> = {}, id = 'openai') =>
    classifyHttpError(nullDialect, ctxFor(id), status, new Headers(headers), body);

  it('401/403 -> AuthError with the descriptor hint appended', () => {
    const e = cls(401, '{"error":{"message":"bad key"}}', {}, 'codestral');
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toMatch(/^Codestral API error \(401\): bad key/);
    expect(e.message).toContain('Hint:');
    expect(e.message).toContain('codestral.mistral.ai');
  });
  it('402 -> Quota, but 402 with Retry-After -> RateLimit', () => {
    expect(cls(402, 'insufficient credits')).toBeInstanceOf(QuotaExhaustedError);
    expect(cls(402, 'in flight', { 'retry-after': '5' })).toBeInstanceOf(RateLimitError);
  });
  it('credit balance message -> Quota at any status', () => {
    expect(cls(400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', {}, 'anthropic'))
      .toBeInstanceOf(QuotaExhaustedError);
  });
  it('openai-style quota codes at 429 -> Quota; plain 429 -> RateLimit', () => {
    expect(cls(429, '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}')).toBeInstanceOf(QuotaExhaustedError);
    expect(cls(429, '{"error":{"code":"project_spend_limit_exceeded","message":"x"}}')).toBeInstanceOf(QuotaExhaustedError);
    const e = cls(429, 'slow down', { 'x-ratelimit-remaining-requests': '0' });
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).headers.get('x-ratelimit-remaining-requests')).toBe('0');
  });
  it('anthropic spend limits', () => {
    expect(cls(400, '{"error":{"message":"You have reached your specified workspace API usage limits."}}', {}, 'anthropic')).toBeInstanceOf(QuotaExhaustedError);
    expect(cls(429, '{"error":{"type":"rate_limit_error","message":"x","details":{"error_code":"enforced_spend_limit_reached"}}}', {}, 'anthropic')).toBeInstanceOf(QuotaExhaustedError);
  });
  it('502/503/529/408 -> Overloaded', () => {
    for (const s of [502, 503, 529, 408]) expect(cls(s, 'busy')).toBeInstanceOf(OverloadedError);
  });
  it('other statuses -> AiProviderError with status in the message', () => {
    const e = cls(500, 'oops');
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e).not.toBeInstanceOf(OverloadedError);
    expect(e.message).toBe('OpenAI API error (500): oops');
  });
  it('an HTML error page never throws and is capped and redacted', () => {
    const html = '<html> sk-test-placeholder ' + 'x'.repeat(5000) + ' </html>';   // key inside the first 500 chars, so redaction (not just the cap) is exercised
    const e = classifyHttpError(nullDialect, ctxFor('openai'), 502, new Headers(), html);
    expect(e.message.length).toBeLessThan(700);
    expect(e.message).not.toContain('sk-test-placeholder');
  });
  it('a key straddling the 500-char cap leaves no fragment of the key (redact before cap)', () => {
    const key = 'sk-test-placeholder';
    // Pad so that 1..15 leading characters of the key sit inside the first 500 chars of the text.
    for (let pad = 485; pad <= 499; pad++) {
      const plain = classifyHttpError(nullDialect, ctxFor('openai'), 502, new Headers(), 'x'.repeat(pad) + key + ' tail');
      expect(plain.message, `plain body, pad ${pad}`).not.toContain('sk-');
      const json = classifyHttpError(nullDialect, ctxFor('openai'), 400, new Headers(), JSON.stringify({ error: { message: 'x'.repeat(pad) + key + ' tail' } }));
      expect(json.message, `json body, pad ${pad}`).not.toContain('sk-');
    }
    const e = classifyHttpError(nullDialect, ctxFor('openai'), 502, new Headers(), 'x'.repeat(494) + key);
    expect(e.message).not.toContain(key.slice(0, 6));
    expect(e.message).toContain('***');
  });
});

describe('redact', () => {
  it('removes the key and URL userinfo', () => {
    expect(redact('bad key sk-test-placeholder at https://u:p@host.test/x', 'sk-test-placeholder'))
      .toBe('bad key *** at https://***@host.test/x');
  });
  it('does nothing harmful without a key', () => {
    expect(redact('plain')).toBe('plain');
  });
});

describe('upstreamMessage', () => {
  it('prefers error.message, then error string, then raw text', () => {
    expect(upstreamMessage('{"error":{"message":"a"}}')).toBe('a');
    expect(upstreamMessage('{"error":"b"}')).toBe('b');
    expect(upstreamMessage('plain text')).toBe('plain text');
  });
  it('redacts the optional key before capping, for both JSON and plain bodies', () => {
    const key = 'sk-test-placeholder';
    expect(upstreamMessage(`{"error":{"message":"bad ${key} here"}}`, key)).toBe('bad *** here');
    expect(upstreamMessage(`oops ${key}`, key)).toBe('oops ***');
    expect(upstreamMessage('x'.repeat(494) + key, key)).not.toContain(key.slice(0, 6));
    expect(upstreamMessage(JSON.stringify({ error: { message: 'x'.repeat(494) + key } }), key)).not.toContain(key.slice(0, 6));
    expect(upstreamMessage('y'.repeat(900), key)).toHaveLength(500);
  });
});

describe('safeText', () => {
  it('redacts the key and then caps at 500 chars', () => {
    expect(safeText('bad sk-test-placeholder', { apiKey: 'sk-test-placeholder' })).toBe('bad ***');
    expect(safeText(undefined, {})).toBe('');
    expect(safeText('y'.repeat(900), { apiKey: 'sk-test-placeholder' })).toHaveLength(500);
  });
  it('a key straddling the 500-char cap leaves no fragment of the key', () => {
    const key = 'sk-test-placeholder';
    for (let pad = 485; pad <= 499; pad++) {
      expect(safeText('x'.repeat(pad) + key + ' tail', { apiKey: key }), `pad ${pad}`).not.toContain('sk-');
    }
    expect(safeText('x'.repeat(494) + key, { apiKey: key })).not.toContain(key.slice(0, 6));
  });
});

describe('sendChat', () => {
  it('returns the response on 2xx and sets redirect: error', async () => {
    const stub = stubFetch(() => jsonResponse({ ok: true }));
    const { res } = await sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true });
    expect(res.ok).toBe(true);
    expect(stub.calls[0].init.redirect).toBe('error');
    expect(stub.calls[0].url).toBe('https://x.test/chat');
  });
  it('maps a thrown network error to ConnectionError without leaking the key', async () => {
    stubFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }) }); });
    await expect(sendChat(nullDialect, ctxFor('ollama', { baseUrl: 'http://127.0.0.1:11434' }), { messages: [], systemPrompt: '', tools: [] }, { stream: true }))
      .rejects.toBeInstanceOf(ConnectionError);
  });
  it('explains a redirect refusal', async () => {
    stubFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }); });
    await expect(sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }))
      .rejects.toThrow(/redirect/i);
  });
  it('does not send anything for an already-aborted signal and passes the abort through', async () => {
    const stub = stubFetch(() => jsonResponse({}));
    const ac = new AbortController(); ac.abort();
    await expect(sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [], signal: ac.signal }, { stream: true }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(stub.calls).toHaveLength(0);
  });
  it('times out waiting for headers with ConnectionError', async () => {
    vi.useFakeTimers();
    stubFetch((_c) => new Promise<Response>(() => {})); // never resolves
    const ctx = ctxFor('openai', { descriptor: { ...getProviderDescriptor('openai')!, headersTimeoutMs: 50 } as any });
    const p = sendChat(nullDialect, ctx, { messages: [], systemPrompt: '', tools: [] }, { stream: true });
    const assertion = expect(p).rejects.toThrow(/did not respond within/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    await expect(p).rejects.toBeInstanceOf(ConnectionError);
    vi.useRealTimers();
  });
  it('retries once with an adjusted context when retryWith returns one', async () => {
    const dialect: Dialect = { ...nullDialect, retryWith: (status, body, ctx) => status === 400 && /stream_options/.test(body) ? { ...ctx, flags: { noStreamUsage: true } } : undefined };
    const stub = stubFetch((_c, n) => n === 0 ? textResponse('unknown field stream_options', 400) : jsonResponse({ ok: true }));
    const { res, ctx } = await sendChat(dialect, ctxFor('openai-compatible'), { messages: [], systemPrompt: '', tools: [] }, { stream: true });
    expect(res.ok).toBe(true);
    expect(ctx.flags.noStreamUsage).toBe(true);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0].body.flag).toBe(false);
    expect(stub.calls[1].body.flag).toBe(true);
  });
});

describe('parseSSEStream', () => {
  it('handles CRLF split across chunks, comments, and multi-line data', async () => {
    const res = chunkedResponse([': hi\r', '\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\n', 'data: [DONE]\n\n']);
    const out: any[] = [];
    for await (const e of parseSSEStream(res.body!)) out.push(e);
    expect(out).toEqual([{ event: 'a', data: '1\n2' }, { data: '[DONE]' }]);
  });
});
