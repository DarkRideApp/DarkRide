// Compatibility facade: keeps existing imports of './ai-provider' working while they move to './ai/*'.
// Removed once nothing in the repository imports it.
export { RateLimitError } from './ai/errors';
export type { AiProvider, AiProviderConfig, AiStreamingProvider } from './ai/dialect';
export { createProvider } from './ai/registry';
export { parseRateLimitHeaders } from './ai/rate-limit';
export type { ParsedRateLimitHeaders } from './ai/rate-limit';
