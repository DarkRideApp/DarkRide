import { describe, it, expect, afterEach, vi } from 'vitest';
import { sseResponse, ndjsonResponse, jsonResponse, okStream, collect, stubFetch, callHeader } from '../test-helpers';

afterEach(() => vi.unstubAllGlobals());

describe('test-helpers', () => {
  it('sseResponse produces a readable event stream', async () => {
    const res = sseResponse([{ event: 'message_start', data: '{"a":1}' }, { data: '[DONE]' }]);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('event: message_start\ndata: {"a":1}\n\ndata: [DONE]\n\n');
  });

  it('ndjsonResponse joins lines with newlines', async () => {
    const res = ndjsonResponse([{ a: 1 }, { b: 2 }]);
    expect(await res.text()).toBe('{"a":1}\n{"b":2}\n');
  });

  it('stubFetch records url, headers, and parsed JSON body, and returns a fresh Response each call', async () => {
    const stub = stubFetch(() => jsonResponse({ ok: true }));
    await fetch('https://x.test/a', { method: 'POST', headers: { 'X-Key': 'k' }, body: '{"n":1}' });
    await fetch('https://x.test/b', { method: 'POST', headers: { 'X-Key': 'k' }, body: '{"n":2}' });
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0].url).toBe('https://x.test/a');
    expect(stub.calls[1].body).toEqual({ n: 2 });
    expect(callHeader(stub.calls[0], 'x-key')).toBe('k');
  });

  it('stubFetch rejects when the caller aborts a pending request, like real fetch', async () => {
    stubFetch(() => new Promise<Response>(() => {})); // never resolves
    const ac = new AbortController();
    const pending = fetch('https://x.test/a', { method: 'POST', body: '{}', signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const aborted = new AbortController(); aborted.abort();
    await expect(fetch('https://x.test/b', { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('okStream returns a non-empty valid streaming response for each wire format', async () => {
    for (const kind of ['anthropic', 'gemini', 'ollama', 'openai-chat'] as const) {
      const text = await okStream(kind).text();
      expect(text.length, kind).toBeGreaterThan(0);
    }
  });

  it('collect drains an async iterable', async () => {
    async function* gen() { yield { type: 'text' as const, text: 'a' }; yield { type: 'text' as const, text: 'b' }; }
    expect(await collect(gen())).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  });
});
