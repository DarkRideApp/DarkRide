import type { AiProviderDescriptor } from '../../../shared/lib/ai-provider-catalog';
import {
  AiProviderError, AuthError, ConnectionError, OverloadedError, PermissionDeniedError, QuotaExhaustedError, RateLimitError,
} from './errors';
import type { BuiltRequest, Dialect, DialectContext, AiRequest } from './dialect';

// ── SSE / NDJSON readers ──────────────────────────────────────────────

/**
 * Longest line (in characters) a stream reader buffers while waiting for its line ending. Real events are a few KB;
 * a server that never sends a newline would otherwise grow the buffer without bound.
 */
export const MAX_STREAM_LINE_CHARS = 8 * 1024 * 1024;

/**
 * A stream line passed MAX_STREAM_LINE_CHARS. The readers do not know which provider they read, so the message is
 * generic; DialectProvider rethrows it with the provider's name.
 */
export class LineTooLongError extends AiProviderError {
  constructor() { super('The server sent a line longer than 8 MB'); }
}

/**
 * The unfinished last line of a stream, kept as the pieces that arrived so each piece is copied once (when the line
 * completes) rather than once per chunk. Throws LineTooLongError when it passes MAX_STREAM_LINE_CHARS.
 */
class PendingLine {
  private parts: string[] = [];
  private length = 0;

  hold(text: string): void {
    if (!text) return;
    this.parts.push(text);
    this.length += text.length;
    if (this.length > MAX_STREAM_LINE_CHARS) throw new LineTooLongError();
  }

  /** The held text followed by `rest`, as one line. Empties the buffer. */
  take(rest: string): string {
    if (this.length === 0) return rest;
    this.parts.push(rest);
    const line = this.parts.join('');
    this.parts = [];
    this.length = 0;
    return line;
  }
}

/**
 * Reading the response body failed (the connection was reset or closed early, or the request was aborted). The
 * original error is the `cause`. Not an AiProviderError: DialectProvider decides what it means, using the caller's
 * signal, so a bug in a parser is never mistaken for a dropped connection.
 */
export class StreamReadError extends Error {
  constructor(cause: unknown) {
    super('Reading the response stream failed', { cause });
    this.name = 'StreamReadError';
  }
}

/** `reader.read()`, with a rejection wrapped as a StreamReadError. Only the read is wrapped. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    return await reader.read();
  } catch (err) {
    throw new StreamReadError(err);
  }
}

/** Stop reading the body (so a consumer that stops iterating also closes the connection), then release it. */
function closeReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  reader.cancel().catch(() => { /* already closed or errored */ });
  reader.releaseLock();
}

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const pending = new PendingLine();
  // The previous chunk ended in CR: an LF at the start of this one completes that CRLF, it is not an empty line.
  let skipLF = false;
  let currentEvent: string | undefined;
  let currentData: string[] = [];
  const lineEnding = /\r\n|\r|\n/g;

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await readChunk(reader);
      if (done) break;
      let text = decoder.decode(value, { stream: true });
      if (skipLF && text) {
        if (text.charCodeAt(0) === 10) text = text.slice(1);
        skipLF = false;
      }

      // SSE permits CRLF, LF, or CR endings. Only the new chunk is searched; an unfinished line waits in `pending`.
      let start = 0;
      lineEnding.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = lineEnding.exec(text)) !== null) {
        const line = pending.take(text.slice(start, match.index));
        start = match.index + match[0].length;
        lineEnding.lastIndex = start;
        if (match[0] === '\r' && start === text.length) skipLF = true;

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
      pending.hold(text.slice(start));
    }

    if (currentData.length > 0) {
      yield { event: currentEvent, data: currentData.join('\n') };
    }
  } finally {
    closeReader(reader);
  }
}

export async function* parseNDJSONStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const pending = new PendingLine();

  function parse(line: string): { ok: true; value: any } | { ok: false } {
    const trimmed = line.trim();
    if (!trimmed) return { ok: false };
    try { return { ok: true, value: JSON.parse(trimmed) }; } catch { return { ok: false }; }   // skip malformed lines
  }

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await readChunk(reader);
      if (done) break;
      const text = decoder.decode(value, { stream: true });

      // Only the new chunk is searched; an unfinished line waits in `pending`.
      let start = 0;
      let end: number;
      while ((end = text.indexOf('\n', start)) !== -1) {
        const parsed = parse(pending.take(text.slice(start, end)));
        start = end + 1;
        if (parsed.ok) yield parsed.value;
      }
      pending.hold(text.slice(start));
    }

    // A last line without a trailing newline is still a line.
    const parsed = parse(pending.take(decoder.decode()));
    if (parsed.ok) yield parsed.value;
  } finally {
    closeReader(reader);
  }
}

// ── Redaction and messages ───────────────────────────────────────────

const MAX_UPSTREAM_CHARS = 500;
// Backstop for a message a dialect hook built itself: its prefix ("Gemini API error (400): ") plus up to
// MAX_UPSTREAM_CHARS of upstream text and possibly a hint. Only stops runaway text; not a tighter limit.
const MAX_ERROR_MESSAGE_CHARS = 1000;

/**
 * Mask the API key and any URL userinfo (`scheme://user:pass@` and the token-only `scheme://token@`).
 * Keys shorter than 6 characters are deliberately NOT masked: a string that short would mangle ordinary text.
 */
export function redact(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join('***');
  // Anchored on the literal "://" (no leading scheme pattern) so the scan stays linear on a 64 KB body of letters.
  // '@' is allowed inside the match so a password containing '@' is masked up to the LAST '@' of the authority;
  // '/', '?' and '#' end the authority, so '@' in a path, query or fragment is left alone.
  out = out.replace(/(:\/\/)[^\s/?#]+@/g, '$1***@');
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

/** Error `code` values (OpenAI style) that mean the account is out of credit or over a spend limit. */
export const OPENAI_QUOTA_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);

/**
 * Error `code` or `type` strings for a rate limit or an overloaded server. An HTTP error is classified by its status;
 * these are for errors sent inside a 200 stream, where the string is all there is.
 */
export const RATE_LIMIT_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error']);
export const OVERLOADED_CODES = new Set(['overloaded', 'overloaded_error', 'engine_overloaded', 'service_unavailable']);

/** HTTP statuses (and numeric in-stream codes) for a busy or briefly unreachable server. */
export const OVERLOADED_STATUSES: readonly number[] = [502, 503, 529, 408];

/**
 * Redact (and cap) an error's message and stack in place. Throws if a property it has to change is not writable.
 * V8 bakes the construction-time message into the stack header, so the stack is scrubbed too.
 */
function scrubError(err: Error, apiKey: string | undefined, maxChars: number): void {
  const original = err.message;
  const message = redact(original, apiKey).slice(0, maxChars);
  if (message !== original) err.message = message;
  if (typeof err.stack === 'string') {
    const stack = redact(message !== original ? err.stack.split(original).join(message) : err.stack, apiKey);
    if (stack !== err.stack) err.stack = stack;
  }
}

/** One level of `cause`: a string is redacted, an Error has its message and stack redacted in place. Throws if it cannot. */
function scrubCause(holder: { cause?: unknown }, apiKey: string | undefined): void {
  const cause = holder.cause;
  if (typeof cause === 'string') {
    const redacted = redact(cause, apiKey);
    if (redacted !== cause) holder.cause = redacted;
  } else if (cause instanceof Error) {
    scrubError(cause, apiKey, Infinity);
  }
}

/** How deep redactedCause follows a `cause` chain. fetch puts the detail one level down (TypeError -> socket error). */
const MAX_CAUSE_DEPTH = 5;

/**
 * `err` made safe to attach as a `cause`: its message and stack, and those of the errors in its own `cause` chain,
 * are redacted in place. Returns undefined if that is not possible.
 */
export function redactedCause(err: unknown, apiKey: string | undefined): unknown {
  const holder = { cause: err };
  try {
    scrubCause(holder, apiKey);
    const seen = new Set<unknown>([holder.cause]);
    let current: unknown = holder.cause;
    for (let depth = 1; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
      const next = (current as { cause?: unknown }).cause;
      if (next === undefined || seen.has(next)) break;
      scrubCause(current as { cause?: unknown }, apiKey);
      seen.add(next);
      current = (current as { cause?: unknown }).cause;
    }
    return holder.cause;
  } catch { return undefined; }
}

/**
 * A dialect's classifyError hook has no DialectContext, so it cannot redact or tag its own errors. Do it here, once,
 * for every dialect: mask the key and URL userinfo (BEFORE the cap) in the message, stack and cause, cap the message,
 * and fill in provider and status if the hook left them unset. The error is edited in place, so its class (and e.g. a
 * RateLimitError's headers) and identity are preserved. If it cannot be edited (frozen or read-only) the result is a
 * plain AiProviderError built from the redacted message, without the cause. Never throws.
 */
function normaliseHookError(err: AiProviderError, ctx: DialectContext, status: number): AiProviderError {
  try {
    scrubError(err, ctx.apiKey, MAX_ERROR_MESSAGE_CHARS);
    scrubCause(err, ctx.apiKey);
    err.provider ??= ctx.descriptor.id;
    err.status ??= status;
    return err;
  } catch {
    let raw = '';
    try { raw = String(err.message ?? ''); } catch { /* unreadable message */ }
    return new AiProviderError(redact(raw, ctx.apiKey).slice(0, MAX_ERROR_MESSAGE_CHARS), { status, provider: ctx.descriptor.id });
  }
}

export function classifyHttpError(
  dialect: Dialect,
  ctx: DialectContext,
  status: number,
  headers: Headers,
  bodyText: string,
): AiProviderError {
  const fromDialect = dialect.classifyError?.(status, headers, bodyText);
  if (fromDialect) return normaliseHookError(fromDialect, ctx, status);

  const d: AiProviderDescriptor = ctx.descriptor;
  const opts = { status, provider: d.id };
  const info = errorInfo(bodyText);
  const msg = upstreamMessage(bodyText, ctx.apiKey);   // redacts, then caps
  const base = `${d.shortName} API error (${status}): ${msg}`;
  const retryAfter = headers.get('retry-after');

  // Only a 401 proves the credentials are wrong. A 403 refuses one request or resource (a moderation or guardrail
  // block, a key without access to one model, a region or organisation restriction): another model may still work,
  // so it is a PermissionDeniedError (below, after the quota markers), which falls back without putting anything on
  // cooldown.
  if (status === 401) {
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
  if (OVERLOADED_STATUSES.includes(status)) return new OverloadedError(base, opts);
  if (status === 403) return new PermissionDeniedError(base, opts);
  return new AiProviderError(base, opts);
}

// ── Sending ──────────────────────────────────────────────────────────

const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;

/** 50 -> "50ms", 2000 -> "2s", 1500 -> "1.5s". Never rounds a sub-second timeout down to "0s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

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
    const cause = redactedCause(err, ctx.apiKey);   // the raw fetch error may echo the URL or key in its message or stack
    if (timedOut) {
      throw new ConnectionError(`${d.shortName} did not respond within ${formatDuration(timeoutMs)}`, { provider: d.id, cause });
    }
    if (signal?.aborted) throw err;
    const causeMsg = String(err?.cause?.message ?? err?.message ?? err);
    if (/redirect/i.test(causeMsg)) {
      throw new ConnectionError(
        `${d.shortName} answered with a redirect. Redirects are not followed because they could forward the API key. Use the final URL as Base URL.`,
        { provider: d.id, cause },
      );
    }
    throw new ConnectionError(`${d.shortName} request failed: ${redact(causeMsg, ctx.apiKey).slice(0, MAX_UPSTREAM_CHARS)}`, { provider: d.id, cause });
  } finally {
    clearTimeout(timer);
  }
}

// An error body only feeds a 500-char message and a few classifier regexes, so it is read in bounded form:
// at most 64 KB, and at most 10 s (the header timer is already cleared, and a caller may pass no signal).
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 10_000;

/**
 * Read up to MAX_ERROR_BODY_BYTES of an error body, then cancel the rest. Never throws: a read error, a stall
 * past ERROR_BODY_TIMEOUT_MS, a caller abort, or a body that cannot be read at all all return whatever was read.
 *
 * If the read stops early (anything other than a clean end of body or the 64 KB cap) the body may end in the
 * middle of an echoed API key, which no later redaction can recognise. So when an `apiKey` of 6+ characters is
 * known, the last `apiKey.length - 1` characters are dropped: the longest key prefix that could be dangling.
 */
async function readBodyText(res: Response, apiKey?: string): Promise<string> {
  const { text, end } = await readCapped(res.body, MAX_ERROR_BODY_BYTES, ERROR_BODY_TIMEOUT_MS);
  const stoppedEarly = end === 'timeout' || end === 'error';   // the size cap is a deliberate stop, not a cut-off
  if (stoppedEarly && apiKey && apiKey.length >= 6) return text.slice(0, Math.max(0, text.length - (apiKey.length - 1)));
  return text;
}

/**
 * Read a body as text, at most `maxBytes` and (optionally) for at most `deadlineMs`, then cancel whatever is left.
 * Never throws: `end` says why reading stopped, and `error` carries a read failure.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null, maxBytes: number, deadlineMs?: number,
): Promise<{ text: string; end: 'done' | 'cap' | 'timeout' | 'error'; error?: unknown }> {
  if (!body) return { text: '', end: 'done' };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let end: 'done' | 'cap' | 'timeout' | 'error' = 'cap';
  let error: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = deadlineMs === undefined
    ? new Promise<never>(() => { /* no deadline */ })
    : new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), deadlineMs); });
  try {
    reader = body.getReader();
    while (bytes < maxBytes) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timeout') { end = 'timeout'; break; }
      if (next.done) { end = 'done'; break; }
      const room = maxBytes - bytes;
      const chunk = next.value.length > room ? next.value.subarray(0, room) : next.value;
      bytes += chunk.length;
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } catch (err) {
    end = 'error';
    error = err;
  } finally {
    clearTimeout(timer);
    reader?.cancel().catch(() => { /* already closed or errored */ });
  }
  return { text, end, error };
}

/** Largest successful JSON body (a model list or a completion) read before giving up. Real model lists are about 1 MB. */
export const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Read and parse a 2xx JSON body (a model list or a completion), bounded at MAX_JSON_BODY_BYTES.
 * - After the caller aborted (or a timeout fired), a read failure propagates unchanged.
 * - Any other read failure (the server dropped the connection mid-body) is a ConnectionError, so callers can fall back.
 * - A body over the cap is "too large"; one that does not parse (a login page or captive portal) is "not JSON".
 */
export async function readJson(res: Response, ctx: DialectContext, signal?: AbortSignal): Promise<unknown> {
  const d = ctx.descriptor;
  // One byte past the cap tells "exactly at the cap" apart from "over it".
  const { text, end, error } = await readCapped(res.body, MAX_JSON_BODY_BYTES + 1);
  if (end === 'error') {
    if (signal?.aborted) throw error;
    throw new ConnectionError(`${d.shortName} closed the connection while sending the response`, { provider: d.id, cause: redactedCause(error, ctx.apiKey) });
  }
  if (end === 'cap') throw new AiProviderError(`${d.shortName} response is too large`, { provider: d.id, status: res.status });
  try {
    return JSON.parse(text);
  } catch {
    throw new AiProviderError(`${d.shortName} returned a response that is not JSON. Check the Base URL.`, { provider: d.id, status: res.status });
  }
}

/**
 * Send one request built from the context and return the 2xx response; a non-2xx has its body read bounded and is
 * thrown classified. With `retry`, the dialect's retryWith hook may adjust the context once and the request is
 * rebuilt from it. Chat, completion, listing, and connection tests all go through here.
 */
export async function sendChecked(
  dialect: Dialect,
  ctx: DialectContext,
  build: (ctx: DialectContext) => { url: string; headers: Record<string, string>; body?: unknown },
  opts: { signal?: AbortSignal; method?: 'POST' | 'GET'; retry?: boolean } = {},
): Promise<{ res: Response; ctx: DialectContext }> {
  let current = ctx;
  for (let attempt = 0; ; attempt++) {
    const res = await sendBuilt({ body: undefined, ...build(current) }, current, opts.signal, opts.method);
    if (res.ok) return { res, ctx: current };
    const bodyText = await readBodyText(res, current.apiKey);
    const retry = opts.retry && attempt === 0 ? dialect.retryWith?.(res.status, bodyText, current) : undefined;
    if (!retry) throw classifyHttpError(dialect, current, res.status, res.headers, bodyText);
    current = retry;
  }
}

export function sendChat(
  dialect: Dialect,
  ctx: DialectContext,
  req: AiRequest,
  opts: { stream: boolean },
): Promise<{ res: Response; ctx: DialectContext }> {
  return sendChecked(dialect, ctx, (c) => dialect.buildChat(c, req, opts), { signal: req.signal, retry: true });
}
