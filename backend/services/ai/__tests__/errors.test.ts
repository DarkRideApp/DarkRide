import { describe, it, expect } from 'vitest';
import {
  AiProviderError, RateLimitError, QuotaExhaustedError, OverloadedError, AuthError, ConnectionError,
  OutputLimitError, AllModelsFailedError, NoModelsConfiguredError, PermissionDeniedError, ModelRefusedError, isFallbackEligible,
} from '../errors';

describe('errors', () => {
  it('ModelRefusedError is a provider error the router may fall back on', () => {
    const e = new ModelRefusedError('Claude declined this request (category: cyber).', { provider: 'anthropic' });
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e.name).toBe('ModelRefusedError');
    expect(e.provider).toBe('anthropic');
    expect(e.message).toBe('Claude declined this request (category: cyber).');
    expect(isFallbackEligible(e)).toBe(true);
  });

  it('RateLimitError keeps (message, headers) and name', () => {
    const h = new Headers({ 'x-ratelimit-limit-requests': '100' });
    const e = new RateLimitError('rate limited', h);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e.name).toBe('RateLimitError');
    expect(e.message).toBe('rate limited');
    expect(e.headers).toBe(h);
  });
  it('subclasses carry their own name and status/provider/cause', () => {
    const cause = new Error('boom');
    const e = new QuotaExhaustedError('no credits', { status: 402, provider: 'anthropic', cause });
    expect(e.name).toBe('QuotaExhaustedError');
    expect(e.status).toBe(402);
    expect(e.provider).toBe('anthropic');
    expect((e as any).cause).toBe(cause);
  });
  it('isFallbackEligible', () => {
    expect(isFallbackEligible(new RateLimitError('x', new Headers()))).toBe(true);
    expect(isFallbackEligible(new QuotaExhaustedError('x'))).toBe(true);
    expect(isFallbackEligible(new OverloadedError('x'))).toBe(true);
    expect(isFallbackEligible(new AuthError('x'))).toBe(true);
    expect(isFallbackEligible(new ConnectionError('x'))).toBe(true);
    expect(isFallbackEligible(new PermissionDeniedError('x'))).toBe(true);
    expect(isFallbackEligible(new OutputLimitError('x'))).toBe(false);
    expect(isFallbackEligible(new AiProviderError('x'))).toBe(false);
    expect(isFallbackEligible(new Error('x'))).toBe(false);
    const abort = new DOMException('aborted', 'AbortError');
    expect(isFallbackEligible(abort)).toBe(false);
  });
  it('AllModelsFailedError builds the legacy-prefixed message from attempts', () => {
    const e = new AllModelsFailedError([{ model: 'a', error: 'rate limited' }, { model: 'b', error: 'Anthropic API error (401): bad key' }]);
    expect(e.message).toBe('All AI models are rate-limited or unavailable:\na: rate limited\nb: Anthropic API error (401): bad key');
    expect(e.attempts).toHaveLength(2);
  });
  it('NoModelsConfiguredError default message points at Settings → AI', () => {
    // Was: "Add one in Settings → Integrations.". Now: AI providers and models are managed under Settings → AI.
    expect(new NoModelsConfiguredError().message).toBe('No AI models configured. Add one in Settings → AI.');
  });
});
