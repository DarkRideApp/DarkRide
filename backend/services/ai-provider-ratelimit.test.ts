import { describe, it, expect } from 'vitest';
import { RateLimitError, parseRateLimitHeaders } from './ai-provider';

describe('RateLimitError', () => {
  it('should be an instance of Error', () => {
    const headers = new Headers();
    const err = new RateLimitError('rate limited', headers);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('should have name set to RateLimitError', () => {
    const err = new RateLimitError('test', new Headers());
    expect(err.name).toBe('RateLimitError');
  });

  it('should store the message', () => {
    const err = new RateLimitError('Anthropic rate limited (429)', new Headers());
    expect(err.message).toBe('Anthropic rate limited (429)');
  });

  it('should store the headers', () => {
    const headers = new Headers({ 'x-ratelimit-limit-requests': '100' });
    const err = new RateLimitError('rate limited', headers);
    expect(err.headers).toBe(headers);
    expect(err.headers.get('x-ratelimit-limit-requests')).toBe('100');
  });
});

describe('parseRateLimitHeaders', () => {
  describe('anthropic provider', () => {
    it('should parse anthropic-ratelimit headers', () => {
      const headers = new Headers({
        'anthropic-ratelimit-requests-limit': '1000',
        'anthropic-ratelimit-requests-remaining': '950',
        'anthropic-ratelimit-requests-reset': '2026-04-02T12:00:00Z',
        'anthropic-ratelimit-tokens-limit': '100000',
        'anthropic-ratelimit-tokens-remaining': '95000',
        'anthropic-ratelimit-tokens-reset': '2026-04-02T12:00:00Z',
      });
      const result = parseRateLimitHeaders('anthropic', headers);
      expect(result).toEqual({
        requestsLimit: 1000,
        requestsRemaining: 950,
        requestsReset: '2026-04-02T12:00:00Z',
        tokensLimit: 100000,
        tokensRemaining: 95000,
        tokensReset: '2026-04-02T12:00:00Z',
      });
    });

    it('should return null for missing anthropic headers', () => {
      const result = parseRateLimitHeaders('anthropic', new Headers());
      expect(result).toEqual({
        requestsLimit: null,
        requestsRemaining: null,
        requestsReset: null,
        tokensLimit: null,
        tokensRemaining: null,
        tokensReset: null,
      });
    });

    it('should handle partial anthropic headers gracefully', () => {
      const headers = new Headers({
        'anthropic-ratelimit-requests-limit': '1000',
        'anthropic-ratelimit-requests-remaining': '950',
        // missing requests-reset, all token headers
      });
      const result = parseRateLimitHeaders('anthropic', headers);
      expect(result).toEqual({
        requestsLimit: 1000,
        requestsRemaining: 950,
        requestsReset: null,
        tokensLimit: null,
        tokensRemaining: null,
        tokensReset: null,
      });
    });
  });

  describe('openrouter provider', () => {
    it('should parse openrouter x-ratelimit headers', () => {
      const headers = new Headers({
        'x-ratelimit-limit-requests': '200',
        'x-ratelimit-remaining-requests': '150',
        'x-ratelimit-reset-requests': '30s',
        'x-ratelimit-limit-tokens': '40000',
        'x-ratelimit-remaining-tokens': '35000',
        'x-ratelimit-reset-tokens': '60s',
      });

      const result = parseRateLimitHeaders('openrouter', headers);
      expect(result).toEqual({
        requestsLimit: 200,
        requestsRemaining: 150,
        requestsReset: '30s',
        tokensLimit: 40000,
        tokensRemaining: 35000,
        tokensReset: '60s',
      });
    });

    it('should return null for missing openrouter headers', () => {
      const result = parseRateLimitHeaders('openrouter', new Headers());
      expect(result).toEqual({
        requestsLimit: null,
        requestsRemaining: null,
        requestsReset: null,
        tokensLimit: null,
        tokensRemaining: null,
        tokensReset: null,
      });
    });
  });

  describe('codestral provider', () => {
    it('should parse codestral headers (same format as openrouter)', () => {
      const headers = new Headers({
        'x-ratelimit-limit-requests': '60',
        'x-ratelimit-remaining-requests': '58',
        'x-ratelimit-reset-requests': '1s',
      });

      const result = parseRateLimitHeaders('codestral', headers);
      expect(result.requestsLimit).toBe(60);
      expect(result.requestsRemaining).toBe(58);
      expect(result.requestsReset).toBe('1s');
      expect(result.tokensLimit).toBeNull();
    });
  });

  describe('gemini and ollama providers', () => {
    it('should return all nulls for gemini', () => {
      const headers = new Headers({ 'some-header': 'value' });
      const result = parseRateLimitHeaders('gemini', headers);
      expect(result).toEqual({
        requestsLimit: null,
        requestsRemaining: null,
        requestsReset: null,
        tokensLimit: null,
        tokensRemaining: null,
        tokensReset: null,
      });
    });

    it('should return all nulls for ollama', () => {
      const result = parseRateLimitHeaders('ollama', new Headers());
      expect(result).toEqual({
        requestsLimit: null,
        requestsRemaining: null,
        requestsReset: null,
        tokensLimit: null,
        tokensRemaining: null,
        tokensReset: null,
      });
    });
  });

  describe('unknown provider', () => {
    it('should return all nulls for unknown provider', () => {
      const result = parseRateLimitHeaders('some-unknown', new Headers());
      expect(result).toEqual({
        requestsLimit: null,
        requestsRemaining: null,
        requestsReset: null,
        tokensLimit: null,
        tokensRemaining: null,
        tokensReset: null,
      });
    });
  });
});
