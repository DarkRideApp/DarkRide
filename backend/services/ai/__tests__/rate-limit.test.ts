import { describe, it, expect } from 'vitest';
import { parseRateLimitHeaders } from '../rate-limit';

describe('parseRateLimitHeaders', () => {
  it('anthropic scheme', () => {
    const h = new Headers({
      'anthropic-ratelimit-requests-limit': '1000', 'anthropic-ratelimit-requests-remaining': '950',
      'anthropic-ratelimit-requests-reset': '2026-04-02T12:00:00Z', 'anthropic-ratelimit-tokens-limit': '100000',
      'anthropic-ratelimit-tokens-remaining': '95000', 'anthropic-ratelimit-tokens-reset': '2026-04-02T12:00:00Z',
    });
    expect(parseRateLimitHeaders('anthropic', h)).toEqual({
      requestsLimit: 1000, requestsRemaining: 950, requestsReset: '2026-04-02T12:00:00Z',
      tokensLimit: 100000, tokensRemaining: 95000, tokensReset: '2026-04-02T12:00:00Z',
    });
  });
  it('x-ratelimit scheme for openrouter, codestral, mistral, openai', () => {
    const h = new Headers({ 'x-ratelimit-limit-requests': '60', 'x-ratelimit-remaining-requests': '59', 'x-ratelimit-reset-requests': '1s' });
    for (const id of ['openrouter', 'codestral', 'mistral', 'openai']) {
      expect(parseRateLimitHeaders(id, h)).toMatchObject({ requestsLimit: 60, requestsRemaining: 59, requestsReset: '1s', tokensLimit: null });
    }
  });
  it('non-numeric, non-finite and blank header values give null, never NaN; zero stays zero', () => {
    const h = new Headers({
      'x-ratelimit-limit-requests': 'abc', 'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-limit-tokens': 'Infinity', 'x-ratelimit-remaining-tokens': '',
    });
    expect(parseRateLimitHeaders('openai', h)).toEqual({
      requestsLimit: null, requestsRemaining: 0, requestsReset: null,
      tokensLimit: null, tokensRemaining: null, tokensReset: null,
    });
    const a = new Headers({ 'anthropic-ratelimit-requests-limit': 'NaN', 'anthropic-ratelimit-tokens-remaining': '-' });
    const parsed = parseRateLimitHeaders('anthropic', a);
    expect(parsed.requestsLimit).toBeNull();
    expect(parsed.tokensRemaining).toBeNull();
  });
  it('unknown, none-scheme, and missing headers give all nulls', () => {
    const nulls = { requestsLimit: null, requestsRemaining: null, requestsReset: null, tokensLimit: null, tokensRemaining: null, tokensReset: null };
    expect(parseRateLimitHeaders('some-unknown', new Headers({ 'x-ratelimit-limit-requests': '1' }))).toEqual(nulls);
    expect(parseRateLimitHeaders('gemini', new Headers())).toEqual(nulls);
    expect(parseRateLimitHeaders('ollama', new Headers())).toEqual(nulls);
  });
});
