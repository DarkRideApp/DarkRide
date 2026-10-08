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
export class ConnectionError extends AiProviderError {}
export class OutputLimitError extends AiProviderError {}
export class UnknownProviderError extends AiProviderError {}

export class NoModelsConfiguredError extends Error {
  constructor(message = 'No AI models configured. Add one in Settings → Integrations.') {
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
    err instanceof ConnectionError
  );
}
