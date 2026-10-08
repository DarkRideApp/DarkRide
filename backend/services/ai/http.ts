import type { AiProviderDescriptor } from '../../../shared/lib/ai-provider-catalog';
import {
  AiProviderError, AuthError, ConnectionError, OverloadedError, QuotaExhaustedError, RateLimitError,
} from './errors';
import type { BuiltRequest, Dialect, DialectContext, AiRequest } from './dialect';

// ── SSE / NDJSON readers (moved verbatim from ai-provider.ts) ─────────

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE permits CRLF, LF, or CR endings. Keep a trailing CR buffered so
      // a CRLF split across network chunks remains one line ending.
      let lineEnd: number;
      while ((lineEnd = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const match = buffer.match(/\r\n|\r|\n/)!;
        if (match[0] === '\r' && lineEnd === buffer.length - 1) break;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + match[0].length);

        if (line === '') {
          if (currentData.length > 0) {
            yield { event: currentEvent, data: currentData.join('\n') };
            currentEvent = undefined;
            currentData = [];
          }
          continue;
        }

        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
        if (field === 'event') currentEvent = fieldValue;
        else if (field === 'data') currentData.push(fieldValue);
      }
    }

    if (currentData.length > 0) {
      yield { event: currentEvent, data: currentData.join('\n') };
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* parseNDJSONStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
          // skip malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Redaction and messages ───────────────────────────────────────────

const MAX_UPSTREAM_CHARS = 500;

export function redact(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join('***');
  out = out.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]*@/g, '$1***@');
  return out;
}

/**
 * Redact the key and cap the length of any upstream-supplied text before it goes into an error message.
 * Redaction runs on the full text BEFORE the cap, so a key straddling the cap can never leave a prefix behind.
 */
export function safeText(msg: unknown, ctx: { apiKey?: string }): string {
  return redact(String(msg ?? ''), ctx.apiKey).slice(0, MAX_UPSTREAM_CHARS);
}

/** Extract the provider's message from an error body, redact `apiKey` (if given), then cap at 500 chars. */
export function upstreamMessage(bodyText: string, apiKey?: string): string {
  const trimmed = bodyText.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const err = parsed?.error;
    const msg =
      (typeof err === 'object' && err !== null && (err.message || err.type)) ||
      (typeof err === 'string' ? err : undefined) ||
      parsed?.message;
    if (typeof msg === 'string' && msg) return redact(msg, apiKey).slice(0, MAX_UPSTREAM_CHARS);
  } catch { /* not JSON */ }
  return redact(trimmed, apiKey).slice(0, MAX_UPSTREAM_CHARS);
}

function errorInfo(bodyText: string): { type?: string; code?: string; message?: string; details?: any } {
  try {
    const e = JSON.parse(bodyText)?.error;
    if (e && typeof e === 'object') return { type: e.type, code: typeof e.code === 'string' ? e.code : undefined, message: e.message, details: e.details };
  } catch { /* ignore */ }
  return {};
}

const OPENAI_QUOTA_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);

export function classifyHttpError(
  dialect: Dialect,
  ctx: DialectContext,
  status: number,
  headers: Headers,
  bodyText: string,
): AiProviderError {
  const fromDialect = dialect.classifyError?.(status, headers, bodyText);
  if (fromDialect) return fromDialect;

  const d: AiProviderDescriptor = ctx.descriptor;
  const opts = { status, provider: d.id };
  const info = errorInfo(bodyText);
  const msg = upstreamMessage(bodyText, ctx.apiKey);   // redacts, then caps
  const base = `${d.shortName} API error (${status}): ${msg}`;
  const retryAfter = headers.get('retry-after');

  if (status === 401 || status === 403) {
    return new AuthError(d.authHint ? `${base} Hint: ${d.authHint}` : base, opts);
  }
  if (/credit balance is too low/i.test(bodyText)) return new QuotaExhaustedError(base, opts);
  if (status === 400 && /reached your specified (workspace )?API usage limits/i.test(bodyText)) {
    return new QuotaExhaustedError(base, opts);
  }
  if (status === 429 && info.details?.error_code === 'enforced_spend_limit_reached') {
    return new QuotaExhaustedError(base, opts);
  }
  if (info.type === 'insufficient_quota' || (info.code && OPENAI_QUOTA_CODES.has(info.code))) {
    return new QuotaExhaustedError(base, opts);
  }
  if (status === 402) {
    return retryAfter ? new RateLimitError(base, headers, opts) : new QuotaExhaustedError(base, opts);
  }
  if (status === 429) return new RateLimitError(base, headers, opts);
  if ([502, 503, 529, 408].includes(status)) return new OverloadedError(base, opts);
  return new AiProviderError(base, opts);
}

// ── Sending ──────────────────────────────────────────────────────────

const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

export async function sendBuilt(
  built: BuiltRequest,
  ctx: DialectContext,
  signal?: AbortSignal,
  method: 'POST' | 'GET' = 'POST',
): Promise<Response> {
  if (signal?.aborted) throw abortError(signal);

  const d = ctx.descriptor;
  const ac = new AbortController();
  // Left attached for the life of the stream so a caller abort also cancels body reads.
  // Known trade-off: a long-lived signal reused across many requests accumulates one listener per request.
  signal?.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
  const timeoutMs = d.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);

  try {
    return await fetch(built.url, {
      method,
      headers: built.headers,
      body: method === 'POST' ? JSON.stringify(built.body) : undefined,
      signal: ac.signal,
      redirect: 'error',
    });
  } catch (err: any) {
    if (timedOut) {
      throw new ConnectionError(`${d.shortName} did not respond within ${Math.round(timeoutMs / 1000)}s`, { provider: d.id, cause: err });
    }
    if (signal?.aborted) throw err;
    const causeMsg = String(err?.cause?.message ?? err?.message ?? err);
    if (/redirect/i.test(causeMsg)) {
      throw new ConnectionError(
        `${d.shortName} answered with a redirect. Redirects are not followed because they could forward the API key. Use the final URL as Base URL.`,
        { provider: d.id, cause: err },
      );
    }
    throw new ConnectionError(`${d.shortName} request failed: ${redact(causeMsg, ctx.apiKey).slice(0, MAX_UPSTREAM_CHARS)}`, { provider: d.id, cause: err });
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

export async function sendChat(
  dialect: Dialect,
  ctx: DialectContext,
  req: AiRequest,
  opts: { stream: boolean },
): Promise<{ res: Response; ctx: DialectContext }> {
  let current = ctx;
  for (let attempt = 0; attempt < 2; attempt++) {
    const built = dialect.buildChat(current, req, opts);
    const res = await sendBuilt(built, current, req.signal);
    if (res.ok) return { res, ctx: current };
    const bodyText = await readBodyText(res);
    if (attempt === 0) {
      const retry = dialect.retryWith?.(res.status, bodyText, current);
      if (retry) { current = retry; continue; }
    }
    throw classifyHttpError(dialect, current, res.status, res.headers, bodyText);
  }
  throw new AiProviderError('unreachable');
}
