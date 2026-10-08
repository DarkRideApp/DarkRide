import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';
import { createLoggers } from '../../../logs';
import { parseSSEStream, safeText } from '../http';
import { AiProviderError, AuthError, OverloadedError, QuotaExhaustedError, RateLimitError } from '../errors';
import type { AiRequest, Dialect, DialectContext } from '../dialect';

const { log } = createLoggers('ai-gemini');
const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'MALFORMED_FUNCTION_CALL']);

function headers(ctx: DialectContext): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(ctx.apiKey ? { 'x-goog-api-key': ctx.apiKey } : {}) };
}

function formatContents(messages: AiMessage[]): any[] {
  const names = new Map<string, string>();
  for (const m of messages) if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);

  const contents: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      const parts: any[] = [];
      for (const b of msg.content) {
        if (b.type === 'text') { if (b.text) parts.push({ text: b.text }); }
        else parts.push({ functionCall: { name: b.name, args: b.input } });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else {
      const part = { functionResponse: { name: names.get(msg.toolUseId) ?? 'tool_result', response: { result: msg.content } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && last.parts.every((p: any) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  return contents;
}

function formatTools(tools: AiToolDefinition[]): any[] {
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }];
}

/**
 * Is a RESOURCE_EXHAUSTED / 429 error a genuinely exhausted quota rather than a transient limit?
 * Calling a transient limit "quota" benches every model on the credential for the whole cooldown, while calling
 * a spent daily quota a rate limit only benches one model row, so every doubtful case answers false.
 */
function isQuotaExhausted(err: any): boolean {
  const ids: string[] = [];
  for (const detail of Array.isArray(err?.details) ? err.details : []) {
    for (const v of Array.isArray(detail?.violations) ? detail.violations : []) {
      for (const k of [v?.quotaId, v?.quotaMetric]) if (typeof k === 'string') ids.push(k);
    }
  }
  // Structured QuotaFailure info is authoritative: only a per-day / per-month limit counts, whatever the wording says.
  if (ids.length > 0) return ids.some((id) => /PerDay|PerMonth|Daily/i.test(id));
  return /billing/i.test(String(err?.message ?? ''));
}

function classifyStreamError(payload: any, ctx: DialectContext): AiProviderError {
  const e = payload?.error ?? payload ?? {};
  const isObj = typeof e === 'object';
  const message = String((isObj ? e.message : e) || 'Unknown error');
  const text = `${ctx.descriptor.shortName} stream error: ${safeText(message, ctx)}`;
  const code = Number(isObj ? e.code : NaN);
  const grpcStatus: unknown = isObj ? e.status : undefined;
  const opts = { provider: ctx.descriptor.id, status: Number.isFinite(code) && code > 0 ? code : undefined };
  // RESOURCE_EXHAUSTED is gRPC's name for HTTP 429, and Google sends both transient limits and spent quota as one.
  if (code === 429 || grpcStatus === 'RESOURCE_EXHAUSTED') {
    return isQuotaExhausted(e) ? new QuotaExhaustedError(text, opts) : new RateLimitError(text, new Headers(), opts);
  }
  if (code === 502 || code === 503 || grpcStatus === 'UNAVAILABLE') return new OverloadedError(text, opts);
  return new AiProviderError(text, opts);
}

function parseErrorBody(bodyText: string): { json: boolean; error?: any } {
  try { return { json: true, error: JSON.parse(bodyText)?.error }; } catch { return { json: false }; }
}

/** Gemini answers a bad API key with HTTP 400 INVALID_ARGUMENT (reason API_KEY_INVALID), not 401. */
function isBadKeyBody(bodyText: string): boolean {
  const { json, error } = parseErrorBody(bodyText);
  if (!json) return /API_KEY_INVALID|API key not valid/i.test(bodyText);
  // Structured body: trust the reason code or a message that STARTS with the phrase, not a proxy message that echoes it.
  if (Array.isArray(error?.details) && error.details.some((d: any) => d?.reason === 'API_KEY_INVALID')) return true;
  return typeof error?.message === 'string' && /^API key not valid/i.test(error.message);
}

/**
 * HTTP-level hook. Handles the two cases the generic classifier gets wrong for Google:
 * a bad key answered with 400 (not 401), and a spent quota answered with 429 (generic would make it a RateLimitError).
 * Everything else returns undefined and takes the generic path, which keeps Retry-After for a plain 429.
 */
function classifyError(status: number, _headers: Headers, bodyText: string): AiProviderError | undefined {
  const quota = status === 429 && isQuotaExhausted(parseErrorBody(bodyText).error);
  if (!quota && !(status === 400 && isBadKeyBody(bodyText))) return undefined;
  const { error } = parseErrorBody(bodyText);
  const msg = typeof error?.message === 'string' && error.message ? error.message : bodyText.trim();
  // Deliberately the raw upstream text: the hook has no DialectContext (no key to redact with). classifyHttpError
  // redacts the key first and only then caps the length, so a key straddling a cap can never leave a prefix behind.
  // Capping here would run before that redaction and cut a key in half.
  const text = `Gemini API error (${status}): ${msg}`;
  return quota ? new QuotaExhaustedError(text, { status }) : new AuthError(text, { status });
}

async function* parseStream(res: Response, ctx: DialectContext, signal?: AbortSignal): AsyncGenerator<AiStreamEvent> {
  const shortName = ctx.descriptor.shortName;
  if (!res.body) throw new AiProviderError(`${shortName} response has no body`);
  let usage: { input: number; output: number } | undefined;

  for await (const sse of parseSSEStream(res.body, signal)) {
    if (sse.data === '[DONE]') break;
    let p: any;
    try { p = JSON.parse(sse.data); } catch { continue; }
    if (!p || typeof p !== 'object') continue;
    if (p.error) throw classifyStreamError(p, ctx);

    if (p.promptFeedback?.blockReason && !p.candidates?.length) {
      yield { type: 'text', text: `${shortName} blocked this request (reason: ${safeText(p.promptFeedback.blockReason, ctx)}).` };
    }
    const cand = p.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (!part || part.thought) continue;
      if (part.text) yield { type: 'text', text: part.text };
      else if (part.functionCall) yield { type: 'tool_use', id: ctx.newId(), name: part.functionCall.name, input: part.functionCall.args || {} };
    }
    const fr: string | undefined = cand?.finishReason;
    if (fr && BLOCKED.has(fr)) yield { type: 'text', text: `${shortName} stopped this response (reason: ${fr}).` };
    else if (fr === 'MAX_TOKENS') log(`${shortName} response was cut off by the output token limit`);

    if (p.usageMetadata) {
      usage = {
        input: p.usageMetadata.promptTokenCount ?? 0,
        output: (p.usageMetadata.candidatesTokenCount ?? 0) + (p.usageMetadata.thoughtsTokenCount ?? 0),
      };
    }
  }
  if (usage) yield { type: 'usage', inputTokens: usage.input, outputTokens: usage.output };
}

export const geminiDialect: Dialect = {
  id: 'gemini-generate',

  buildChat(ctx: DialectContext, req: AiRequest, opts: { stream: boolean }) {
    const body: any = { contents: formatContents(req.messages) };
    if (req.systemPrompt) body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
    if (req.tools.length > 0) body.tools = formatTools(req.tools);
    const gen: any = {};
    if (req.maxOutputTokens) gen.maxOutputTokens = req.maxOutputTokens;
    if (req.stopSequences?.length) gen.stopSequences = req.stopSequences;
    if (req.temperature !== undefined) gen.temperature = req.temperature;
    if (Object.keys(gen).length > 0) body.generationConfig = gen;
    const method = opts.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return { url: `${ctx.baseUrl}/v1beta/models/${encodeURIComponent(ctx.model)}:${method}`, headers: headers(ctx), body };
  },

  parseStream,
  classifyStreamError,
  classifyError,

  buildListModels(ctx: DialectContext, page?: string) {
    return { url: `${ctx.baseUrl}/v1beta/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, headers: headers(ctx) };
  },
  parseModels(json: any) {
    const models = (json?.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent'))
      .map((m: any) => { const id = String(m.name).replace(/^models\//, ''); return { id, name: m.displayName || id }; });
    return { models, next: json?.nextPageToken || undefined };
  },
};
