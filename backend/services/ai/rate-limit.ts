import { getProviderDescriptor } from '../../../shared/lib/ai-provider-catalog';

export interface ParsedRateLimitHeaders {
  requestsLimit: number | null; requestsRemaining: number | null; requestsReset: string | null;
  tokensLimit: number | null; tokensRemaining: number | null; tokensReset: string | null;
}

const NULLS: ParsedRateLimitHeaders = {
  requestsLimit: null, requestsRemaining: null, requestsReset: null,
  tokensLimit: null, tokensRemaining: null, tokensReset: null,
};
/** Missing, blank, non-numeric and non-finite values (NaN, Infinity) all become null, never NaN. */
const num = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// A lookup table, not an if-chain: the scheme name 'anthropic' equals a provider id, and the provider-id guard
// (backend/services/ai/__tests__/provider-branch-guard.test.ts) flags comparisons against provider-id literals outside the
// catalog and the dialects.
const PARSERS: Record<'anthropic' | 'x-ratelimit' | 'none', (h: Headers) => ParsedRateLimitHeaders> = {
  anthropic: (headers) => {
    const rl = (k: string) => headers.get(`anthropic-ratelimit-${k}`);
    return {
      requestsLimit: num(rl('requests-limit')), requestsRemaining: num(rl('requests-remaining')), requestsReset: rl('requests-reset'),
      tokensLimit: num(rl('tokens-limit')), tokensRemaining: num(rl('tokens-remaining')), tokensReset: rl('tokens-reset'),
    };
  },
  'x-ratelimit': (headers) => {
    const rl = (k: string) => headers.get(`x-ratelimit-${k}`);
    return {
      requestsLimit: num(rl('limit-requests')), requestsRemaining: num(rl('remaining-requests')), requestsReset: rl('reset-requests'),
      tokensLimit: num(rl('limit-tokens')), tokensRemaining: num(rl('remaining-tokens')), tokensReset: rl('reset-tokens'),
    };
  },
  none: () => ({ ...NULLS }),
};

export function parseRateLimitHeaders(providerId: string, headers: Headers): ParsedRateLimitHeaders {
  const scheme = getProviderDescriptor(providerId)?.rateLimitScheme ?? 'none';
  return PARSERS[scheme](headers);
}
