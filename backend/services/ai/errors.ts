export interface AiErrorOptions { status?: number; provider?: string; cause?: unknown }

export class AiProviderError extends Error {
  status?: number;
  provider?: string;
  constructor(message: string, opts: AiErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.status = opts.status;
    this.provider = opts.provider;
  }
}

export class RateLimitError extends AiProviderError {
  readonly headers: Headers;
  constructor(message: string, headers: Headers, opts: AiErrorOptions = {}) {
    super(message, opts);
    this.headers = headers;
  }
}
export class QuotaExhaustedError extends AiProviderError {}
export class OverloadedError extends AiProviderError {}
export class AuthError extends AiProviderError {}
/**
 * A 403 that does not prove the key is bad: the key lacks access to this model, a moderation or guardrail block, a
 * region or organisation restriction. Another model may still work, so the router tries the next one, but nothing is
 * put on cooldown.
 */
export class PermissionDeniedError extends AiProviderError {}
/**
 * The model declined to answer: an Anthropic `refusal` stop (for example the cyber safeguard), a Gemini safety or prompt
 * block, an OpenAI-style `content_filter`. It says something about this request and nothing about the model's health, so
 * the router tries the next model but starts no cooldown. The message is what the user should read.
 */
export class ModelRefusedError extends AiProviderError {}
export class ConnectionError extends AiProviderError {}
export class OutputLimitError extends AiProviderError {}
export class UnknownProviderError extends AiProviderError {}

export class NoModelsConfiguredError extends Error {
  constructor(message = 'No AI models configured. Add one in Settings → AI.') {
    super(message);
    this.name = 'NoModelsConfiguredError';
  }
}

export class AllModelsFailedError extends AiProviderError {
  readonly attempts: { model: string; error: string }[];
  constructor(attempts: { model: string; error: string }[], opts: AiErrorOptions = {}) {
    super(
      `All AI models are rate-limited or unavailable:\n${attempts.map((a) => `${a.model}: ${a.error}`).join('\n')}`,
      opts,
    );
    this.attempts = attempts;
  }
}

/** Errors on which the router may try the next model, when nothing has been yielded yet. */
export function isFallbackEligible(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof QuotaExhaustedError ||
    err instanceof OverloadedError ||
    err instanceof AuthError ||
    err instanceof PermissionDeniedError ||
    err instanceof ModelRefusedError ||
    err instanceof ConnectionError
  );
}
