import { describe, it, expect, afterEach, vi } from 'vitest';
import { classifyHttpError, redact, safeText, upstreamMessage, sendChat, sendChecked, parseSSEStream } from '../http';
import { AuthError, QuotaExhaustedError, RateLimitError, OverloadedError, ConnectionError, AiProviderError } from '../errors';
import { getProviderDescriptor } from '../../../../shared/lib/ai-provider-catalog';
import type { Dialect, DialectContext } from '../dialect';
import { stubFetch, jsonResponse, textResponse, sseResponse, chunkedResponse } from '../test-helpers';

// useRealTimers lives here so a failed assertion in a fake-timer test cannot leak fake timers into later tests.
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
  it('redacts the token-only userinfo form (no colon) as well as user:pass', () => {
    expect(redact('GET https://sk-abc123@host.test/x failed')).toBe('GET https://***@host.test/x failed');
    expect(redact('GET https://u:p@host.test/x failed')).toBe('GET https://***@host.test/x failed');
    expect(redact('http://tok@127.0.0.1:11434/api')).toBe('http://***@127.0.0.1:11434/api');
    expect(redact('wss://tok@host.test/socket')).toBe('wss://***@host.test/socket');
    expect(redact('HTTPS://tok@host.test/x')).toBe('HTTPS://***@host.test/x');
  });
  it('stays linear on a large body with no URL in it (a scheme-prefix pattern would be quadratic here)', () => {
    const started = Date.now();
    redact('e'.repeat(64 * 1024), 'sk-test-placeholder');
    redact('://' + 'e'.repeat(64 * 1024), 'sk-test-placeholder');
    redact('a:/'.repeat(20_000), 'sk-test-placeholder');
    redact('://' + 'a@'.repeat(32 * 1024), 'sk-test-placeholder');
    redact('://' + '@'.repeat(64 * 1024), 'sk-test-placeholder');
    redact('a@'.repeat(32 * 1024), 'sk-test-placeholder');
    redact('://a'.repeat(16 * 1024), 'sk-test-placeholder');
    expect(Date.now() - started).toBeLessThan(250);
  });
  it('redacts userinfo whose password contains a literal @ up to the LAST @ of the authority', () => {
    expect(redact('GET https://u:p@ss@host.test/x failed')).toBe('GET https://***@host.test/x failed');
    expect(redact('https://u:p@@ss@host.test/x')).toBe('https://***@host.test/x');
  });
  it('leaves URLs without userinfo alone, including an @ in the path or query', () => {
    expect(redact('see https://host.test/users/@me and https://host.test/p?mail=a@b.test'))
      .toBe('see https://host.test/users/@me and https://host.test/p?mail=a@b.test');
    expect(redact('mail me at a@b.test')).toBe('mail me at a@b.test');
    expect(redact('file:///home/u/@x and file:///etc/hosts')).toBe('file:///home/u/@x and file:///etc/hosts');
    expect(redact('https://host.test?mail=a@b.test#frag@x')).toBe('https://host.test?mail=a@b.test#frag@x');
  });
  it('does not redact keys shorter than 6 characters (documented: they would mangle ordinary text), but does at exactly 6', () => {
    expect(redact('pw abc12 here', 'abc12')).toBe('pw abc12 here');
    expect(redact('pw abc123 here', 'abc123')).toBe('pw *** here');
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
  it('the raw fetch error attached as cause carries no key or URL userinfo in its message or stack', async () => {
    const leaky = `bad ${'sk-test-placeholder'} at https://u:p@host.test/x`;
    const make: Array<() => Error> = [
      () => new TypeError(leaky),                                                       // generic "request failed" branch
      () => Object.assign(new TypeError(leaky), { cause: new Error('unexpected redirect') }),   // redirect branch
    ];
    for (const build of make) {
      const raw = build();
      stubFetch(() => { throw raw; });
      const err = await sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
      expect(err).toBeInstanceOf(ConnectionError);
      expect(err.cause).toBe(raw);
      for (const text of [(err.cause as Error).message, (err.cause as Error).stack ?? '', err.message]) {
        expect(text).not.toContain('sk-test-placeholder');
        expect(text).not.toContain('u:p@');
      }
      vi.unstubAllGlobals();
    }
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
  });
  it('names a sub-second header timeout in ms and a fractional one with a decimal, never "0s"', async () => {
    for (const [timeoutMs, expected] of [[50, /within 50ms$/], [1500, /within 1\.5s$/], [2000, /within 2s$/]] as const) {
      vi.useFakeTimers();
      stubFetch((_c) => new Promise<Response>(() => {}));
      const ctx = ctxFor('openai', { descriptor: { ...getProviderDescriptor('openai')!, headersTimeoutMs: timeoutMs } as any });
      const p = sendChat(nullDialect, ctx, { messages: [], systemPrompt: '', tools: [] }, { stream: true });
      const assertion = expect(p).rejects.toThrow(expected);
      await vi.advanceTimersByTimeAsync(timeoutMs + 10);
      await assertion;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it('the header timeout only covers the wait for headers: nothing is aborted once the response arrives', async () => {
    vi.useFakeTimers();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stub = stubFetch(() => new Response(new ReadableStream<Uint8Array>({ start(c) { body = c; } }), { status: 200 }));
    const ctx = ctxFor('openai', { descriptor: { ...getProviderDescriptor('openai')!, headersTimeoutMs: 50 } as any });
    const { res } = await sendChat(nullDialect, ctx, { messages: [], systemPrompt: '', tools: [] }, { stream: true });
    expect(vi.getTimerCount()).toBe(0);                       // the header timer was cleared
    await vi.advanceTimersByTimeAsync(10_000);                // far past headersTimeoutMs, body still open
    expect((stub.calls[0].init.signal as AbortSignal).aborted).toBe(false);
    body.enqueue(new TextEncoder().encode('late chunk'));     // the stream is still readable after the timeout window
    body.close();
    expect(await res.text()).toBe('late chunk');
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
  it('retry then fail: exactly 2 fetches, the adjusted context is used, and the error comes from the SECOND response', async () => {
    const seenFlags: Array<boolean | undefined> = [];
    const retryWith = vi.fn((status: number, body: string, ctx: DialectContext) =>
      status === 400 && /stream_options/.test(body) ? { ...ctx, flags: { noStreamUsage: true } } : undefined);
    const dialect: Dialect = {
      ...nullDialect,
      buildChat: (ctx, req, opts) => { seenFlags.push(ctx.flags.noStreamUsage); return nullDialect.buildChat(ctx, req, opts); },
      retryWith,
    };
    const stub = stubFetch((_c, n) => n === 0 ? textResponse('unknown field stream_options', 400) : textResponse('upstream is busy', 503));
    const err = await sendChat(dialect, ctxFor('openai-compatible'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
    expect(stub.calls).toHaveLength(2);
    expect(seenFlags).toEqual([undefined, true]);
    expect(retryWith).toHaveBeenCalledTimes(1);                // a second failure is not retried again
    expect(err).toBeInstanceOf(OverloadedError);               // 503 from the second response, not the 400 from the first
    expect(err.message).toBe('OpenAI-compatible API error (503): upstream is busy');
  });

  describe('error body reading', () => {
    const KB = 1024;
    it('a 5 MB error body is read only up to 64 KB, the rest is cancelled, and the message is capped', async () => {
      let pulls = 0;
      let cancelled = false;
      const chunk = new TextEncoder().encode('e'.repeat(16 * KB));
      const total = (5 * 1024 * KB) / (16 * KB);                // 320 chunks of 16 KB
      const body = new ReadableStream<Uint8Array>({
        pull(c) { if (pulls++ < total) c.enqueue(chunk); else c.close(); },
        cancel() { cancelled = true; },
      });
      stubFetch(() => new Response(body, { status: 500 }));
      const started = Date.now();
      const err = await sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err.message.length).toBeLessThan(600);
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(10);                           // stopped near 4 chunks, never drained 320
    });
    it('a body that errors mid-read does not throw out of sendChat and keeps what was read', async () => {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode('partial text')); else c.error(new Error('socket reset')); },
      });
      stubFetch(() => new Response(body, { status: 500 }));
      const err = await sendChat(nullDialect, ctxFor('openai', { apiKey: undefined }), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err.message).toBe('OpenAI API error (500): partial text');
    });
    it('a stalled partial body does not hang sendChat when no signal is passed', async () => {
      vi.useFakeTimers();
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('half a body')); } });   // never closes
      stubFetch(() => new Response(body, { status: 500 }));
      const p = sendChat(nullDialect, ctxFor('openai', { apiKey: undefined }), { messages: [], systemPrompt: '', tools: [] }, { stream: true });
      const assertion = expect(p).rejects.toThrow('OpenAI API error (500): half a body');
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    });
    it('a partial read that ends mid-key never leaks a key prefix (stream error)', async () => {
      const key = 'sk-test-placeholder';
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode('invalid key sk-test-pla')); else c.error(new Error('socket reset')); },
      });
      stubFetch(() => new Response(body, { status: 500 }));
      const err = await sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err.message).not.toContain('sk-test-pla');
      expect(err.message).not.toContain('sk-');
      expect(err.message).not.toContain(key);
    });
    it('a partial read that ends mid-key never leaks a key prefix (10 s stall)', async () => {
      vi.useFakeTimers();
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('bad key sk-test-pla')); } });   // never closes
      stubFetch(() => new Response(body, { status: 500 }));
      const p = sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true });
      const assertion = expect(p).rejects.not.toThrow(/sk-/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      await expect(p).rejects.toBeInstanceOf(AiProviderError);
    });
    it('a partial read that ends mid-key never leaks a key prefix (caller abort)', async () => {
      const ac = new AbortController();
      const stub = stubFetch((call) => {
        const signal = call.init.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('invalid key sk-test-pla'));
            signal.addEventListener('abort', () => c.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
          },
        });
        return new Response(body, { status: 500 });
      });
      const p = sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [], signal: ac.signal }, { stream: true }).catch((e) => e);
      await vi.waitFor(() => expect(stub.calls).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 20));              // let the first chunk be read before aborting
      ac.abort();
      const err = await p;
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err.message).not.toContain('sk-');
    });
    it('a complete short body is not clipped: the key is redacted in place and the rest kept', async () => {
      stubFetch(() => new Response('invalid key sk-test-placeholder-1234', { status: 500 }));
      const err = await sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
      expect(err.message).toBe('OpenAI API error (500): invalid key ***-1234');
    });
    it('without a key (or with a key under 6 chars) a partial body is kept whole', async () => {
      for (const apiKey of [undefined, 'abc12']) {
        let n = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode('partial text')); else c.error(new Error('socket reset')); },
        });
        stubFetch(() => new Response(body, { status: 500 }));
        const err = await sendChat(nullDialect, ctxFor('openai', { apiKey }), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
        expect(err.message).toBe('OpenAI API error (500): partial text');
        vi.unstubAllGlobals();
      }
    });
    it('the 10 s deadline timer is cleared after a normal read', async () => {
      vi.useFakeTimers();
      stubFetch(() => new Response('plain failure', { status: 500 }));
      const err = await sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
      expect(err.message).toBe('OpenAI API error (500): plain failure');
      expect(vi.getTimerCount()).toBe(0);
    });
    it('a response with a null body gives an empty upstream message instead of throwing', async () => {
      stubFetch(() => new Response(null, { status: 500 }));
      const err = await sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err.message).toBe('OpenAI API error (500): ');
    });
    it('never throws, even when the body stream is already locked (getReader fails)', async () => {
      stubFetch(() => {
        const res = new Response('locked body', { status: 502 });
        res.body!.getReader();                                  // lock it so a second getReader() throws TypeError
        return res;
      });
      const err = await sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
      expect(err).toBeInstanceOf(OverloadedError);
      expect(err.message).toBe('OpenAI API error (502): ');
    });
    it('a UTF-8 character split across chunks is decoded intact', async () => {
      const bytes = new TextEncoder().encode('café au lait');   // 'e-acute' is 2 bytes
      const split = 4;                                             // cuts between the two bytes of e-acute
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(bytes.slice(0, split)); c.enqueue(bytes.slice(split)); c.close(); },
      });
      stubFetch(() => new Response(body, { status: 500 }));
      const err = await sendChat(nullDialect, ctxFor('openai'), { messages: [], systemPrompt: '', tools: [] }, { stream: true }).catch((e) => e);
      expect(err.message).toBe('OpenAI API error (500): café au lait');
    });
  });
});

describe('sendChecked', () => {
  const list = (ctx: DialectContext) => ({ url: `${ctx.baseUrl}/models`, headers: { authorization: `Bearer ${ctx.apiKey}` } });
  it('sends a GET with no body and returns a 2xx response', async () => {
    const stub = stubFetch(() => jsonResponse({ data: [] }));
    const { res } = await sendChecked(nullDialect, ctxFor('openai'), list, { method: 'GET' });
    expect(res.ok).toBe(true);
    expect(stub.calls[0].init.method).toBe('GET');
    expect(stub.calls[0].init.body).toBeUndefined();
    expect(stub.calls[0].init.redirect).toBe('error');
  });
  it('classifies a non-2xx with the provider message, redacted', async () => {
    stubFetch(() => textResponse('{"error":{"message":"bad key sk-test-placeholder"}}', 401));
    const err = await sendChecked(nullDialect, ctxFor('openai'), list, { method: 'GET' }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toBe('OpenAI API error (401): bad key ***');
  });
  it('reads a stalled error body bounded by the deadline instead of hanging', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('half a body')); } });   // never closes
    stubFetch(() => new Response(body, { status: 500 }));
    const p = sendChecked(nullDialect, ctxFor('openai', { apiKey: undefined }), list, { method: 'GET' });
    const assertion = expect(p).rejects.toThrow('OpenAI API error (500): half a body');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
  it('never calls retryWith unless retry is asked for', async () => {
    const retryWith = vi.fn(() => ({ ...ctxFor('openai'), flags: { noStreamUsage: true } }));
    const stub = stubFetch(() => textResponse('unknown field stream_options', 400));
    const err = await sendChecked({ ...nullDialect, retryWith }, ctxFor('openai'), list).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(retryWith).not.toHaveBeenCalled();
    expect(stub.calls).toHaveLength(1);
  });
});

describe('classifyHttpError: dialect classifyError hook results are normalised centrally', () => {
  const KEY = 'sk-test-placeholder';
  const withHook = (hook: Dialect['classifyError']): Dialect => ({ ...nullDialect, classifyError: hook });
  const run = (dialect: Dialect, status = 401, body = 'oops', id = 'openai') =>
    classifyHttpError(dialect, ctxFor(id), status, new Headers(), body);

  it('redacts the key and URL userinfo, tags provider and status, and keeps class and identity', () => {
    const fromHook = new AuthError(`bad key ${KEY} at https://u:p@host.test/x`);
    const e = run(withHook(() => fromHook), 401);
    expect(e).toBe(fromHook);                                  // same object, not wrapped
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toBe('bad key *** at https://***@host.test/x');
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain('u:p@');
    expect(e.provider).toBe('openai');
    expect(e.status).toBe(401);
    expect(e.stack ?? '').not.toContain(KEY);                  // the stack header embeds the original message
    expect(e.stack ?? '').not.toContain('u:p@');
  });
  it('fills status from the HTTP status when the hook set none, but keeps a status the hook set', () => {
    expect(run(withHook(() => new QuotaExhaustedError('q')), 429).status).toBe(429);
    expect(run(withHook(() => new QuotaExhaustedError('q', { status: 418 })), 429).status).toBe(418);
  });
  it('keeps a provider the hook already set', () => {
    const e = run(withHook(() => new AuthError('x', { provider: 'custom-id' })), 401);
    expect(e.provider).toBe('custom-id');
  });
  it('preserves every error class the hook can return (RateLimitError keeps its headers)', () => {
    const headers = new Headers({ 'retry-after': '3' });
    const e = run(withHook(() => new RateLimitError(`slow ${KEY}`, headers, { status: 429 })), 429);
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).headers.get('retry-after')).toBe('3');
    expect(e.message).toBe('slow ***');
  });
  it('redacts BEFORE capping: a key straddling the message cap leaves no fragment', () => {
    for (const pad of [990, 995, 999, 1000]) {
      const e = run(withHook(() => new OverloadedError('x'.repeat(pad) + KEY + ' tail')), 503);
      expect(e.message, `pad ${pad}`).not.toContain('sk-');
    }
  });
  it('caps a huge hook message', () => {
    const e = run(withHook(() => new AiProviderError('z'.repeat(50_000))), 500);
    expect(e.message.length).toBeLessThanOrEqual(1000);
  });
  it('does not clip a normal hook message (prefix plus up to 500 chars of upstream text)', () => {
    const msg = `Gemini API error (400): ${'u'.repeat(500)}`;
    expect(run(withHook(() => new AuthError(msg)), 400).message).toBe(msg);
  });
  describe('a hook error that cannot be edited degrades to a plain AiProviderError and never throws', () => {
    const msg = `bad key ${KEY} at https://u:p@host.test/x`;
    const expectPlain = (e: AiProviderError, original: AiProviderError, status: number) => {
      expect(e).toBeInstanceOf(AiProviderError);
      expect(e).not.toBe(original);
      expect(e.constructor).toBe(AiProviderError);
      expect(e.message).toBe('bad key *** at https://***@host.test/x');
      expect(e.provider).toBe('openai');
      expect(e.status).toBe(status);
      expect(e.cause).toBeUndefined();                          // the raw cause is never attached to the fallback
      expect(e.stack ?? '').not.toContain(KEY);
    };

    it('a frozen error', () => {
      const frozen = Object.freeze(new AuthError(msg, { cause: new Error(`boom ${KEY}`) }));
      expectPlain(run(withHook(() => frozen), 401), frozen, 401);
    });
    it('a non-writable message', () => {
      const original = new RateLimitError(msg, new Headers(), { status: 429 });
      Object.defineProperty(original, 'message', { writable: false });
      expectPlain(run(withHook(() => original), 429), original, 429);
    });
  });

  describe('cause on a hook error is redacted (one level)', () => {
    it('an Error cause has its message and stack redacted in place', () => {
      const cause = new Error(`boom ${KEY}`);
      const e = run(withHook(() => new AuthError('x', { cause })), 401);
      expect(e.cause).toBe(cause);
      expect(cause.message).toBe('boom ***');
      expect(cause.stack ?? '').not.toContain(KEY);
    });
    it('a string cause is redacted', () => {
      const e = run(withHook(() => new AuthError('x', { cause: `raw ${KEY} at https://u:p@host.test/x` })), 401);
      expect(e.cause).toBe('raw *** at https://***@host.test/x');
    });
  });

  it('a hook returning undefined falls through to the generic path unchanged', () => {
    const hook = vi.fn(() => undefined);
    const e = run(withHook(hook), 500, 'oops');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e.message).toBe('OpenAI API error (500): oops');
    expect(e.provider).toBe('openai');
    expect(e.status).toBe(500);
  });
});

describe('classifyHttpError precedence', () => {
  const cls = (status: number, body: string, headers: Record<string, string> = {}, id = 'openai') =>
    classifyHttpError(nullDialect, ctxFor(id), status, new Headers(headers), body);

  it('a 401 whose body says "credit balance is too low" is an AuthError (status rules beat body markers for 401/403)', () => {
    const e = cls(401, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}', {}, 'anthropic');
    expect(e).toBeInstanceOf(AuthError);
    expect(e).not.toBeInstanceOf(QuotaExhaustedError);
  });
  it('a 402 with Retry-After and a plain body is a RateLimitError', () => {
    expect(cls(402, 'payment required, try again later', { 'retry-after': '7' })).toBeInstanceOf(RateLimitError);
  });
  it('a 402 with Retry-After AND an insufficient_quota body is still QuotaExhausted (body rules run before the 402 status rule)', () => {
    const e = cls(402, '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}', { 'retry-after': '7' });
    expect(e).toBeInstanceOf(QuotaExhaustedError);
    expect(e).not.toBeInstanceOf(RateLimitError);
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
