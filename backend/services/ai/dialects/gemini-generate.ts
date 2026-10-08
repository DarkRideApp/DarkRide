import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';
import { createLoggers } from '../../../logs';
import { parseSSEStream, safeText } from '../http';
import { AiProviderError, AuthError, OutputLimitError, OverloadedError, QuotaExhaustedError, RateLimitError } from '../errors';
import type { AiRequest, Dialect, DialectContext } from '../dialect';
import { toolInput } from '../tool-input';

const { log } = createLoggers('ai-gemini');
/** Finish reasons that mean the model ended normally. Every other reason is shown to the user. */
const NORMAL_FINISH = new Set(['STOP', 'MAX_TOKENS']);
/** Documented stand-in for a thought signature we do not have (a replayed or injected call). */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';
const isGemini3 = (model: string): boolean => /^gemini-3/i.test(model);

/**
 * Tool-call ids this dialect generated itself (Gemini sent none). Gemini must only ever see ids it issued, so
 * these are never replayed. Ids from an earlier process are recognised by the default generator's shape
 * (`call_` + 24 hex); this set also covers an injected generator. Bounded so a long-lived process stays small.
 */
const generatedIds = new Set<string>();
const MAX_GENERATED_IDS = 10_000;
const GENERATED_ID_SHAPE = /^call_[0-9a-f]{24}$/;

function generateId(ctx: DialectContext): string {
  const id = ctx.newId();
  generatedIds.add(id);
  if (generatedIds.size > MAX_GENERATED_IDS) generatedIds.delete(generatedIds.values().next().value as string);
  return id;
}

/** The id to send back to Gemini for a tool_use id, or undefined when it is one we made up. */
function serverId(id: string): string | undefined {
  return id && !generatedIds.has(id) && !GENERATED_ID_SHAPE.test(id) ? id : undefined;
}

function headers(ctx: DialectContext): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(ctx.apiKey ? { 'x-goog-api-key': ctx.apiKey } : {}) };
}

/**
 * Gemini 3 rejects a replayed function call without a thought signature. We do not keep the real one, so the first
 * functionCall part of each model turn carries the documented stand-in; parallel calls after it carry none.
 */
function formatContents(messages: AiMessage[], model: string): any[] {
  const names = new Map<string, string>();
  for (const m of messages) if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
  const signCalls = isGemini3(model);

  const contents: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      const parts: any[] = [];
      let signed = false;
      for (const b of msg.content) {
        if (b.type === 'text') { if (b.text) parts.push({ text: b.text }); continue; }
        const id = serverId(b.id);
        const part: any = { functionCall: { ...(id ? { id } : {}), name: b.name, args: b.input } };
        if (signCalls && !signed) { part.thoughtSignature = SKIP_SIGNATURE; signed = true; }
        parts.push(part);
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else {
      const id = serverId(msg.toolUseId);
      const part = { functionResponse: { ...(id ? { id } : {}), name: names.get(msg.toolUseId) ?? 'tool_result', response: { result: msg.content } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && last.parts.every((p: any) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  return contents;
}

/**
 * The least thinking each model family accepts (https://ai.google.dev/gemini-api/docs/generate-content/thinking):
 * 2.5 Flash and Flash-Lite turn it off with a budget of 0, 2.5 Pro cannot turn it off (minimum 128), Gemini 3 takes
 * a level. Other models get nothing, since an unknown field could be rejected.
 */
function lowThinking(model: string): Record<string, unknown> | undefined {
  if (/^gemini-2\.5-flash/i.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-2\.5-pro/i.test(model)) return { thinkingBudget: 128 };
  if (isGemini3(model)) return { thinkingLevel: 'low' };
  return undefined;
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
 * HTTP-level hook. Handles the cases the generic classifier gets wrong for Google: a bad key answered with 400
 * (not 401), a key-level PERMISSION_DENIED 403, and a spent quota answered with 429 (generic would make it a
 * RateLimitError).
 * Everything else returns undefined and takes the generic path, which keeps Retry-After for a plain 429.
 */
function classifyError(status: number, _headers: Headers, bodyText: string): AiProviderError | undefined {
  const { error } = parseErrorBody(bodyText);
  const quota = status === 429 && isQuotaExhausted(error);
  // A 403 PERMISSION_DENIED is about the key itself (leaked, disabled, restricted, or the API is off for its project),
  // so every model on it fails alike. Any other 403 is left to the generic path.
  const deniedKey = status === 403 && error?.status === 'PERMISSION_DENIED';
  if (!quota && !deniedKey && !(status === 400 && isBadKeyBody(bodyText))) return undefined;
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
  const provider = ctx.descriptor.id;
  let usage: { input: number; output: number } | undefined;
  let sawChunk = false;
  let finished = false;
  let produced = false;   // any visible text or tool call so far

  for await (const sse of parseSSEStream(res.body, signal)) {
    if (sse.data === '[DONE]') break;
    let p: any;
    try { p = JSON.parse(sse.data); } catch { continue; }
    if (!p || typeof p !== 'object') continue;
    sawChunk = true;
    if (p.error) throw classifyStreamError(p, ctx);

    if (p.promptFeedback?.blockReason && !p.candidates?.length) {
      finished = true;
      yield { type: 'text', text: `${shortName} blocked this request (reason: ${safeText(p.promptFeedback.blockReason, ctx)}).` };
    }
    const cand = p.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (!part || part.thought) continue;
      if (part.text) { produced = true; yield { type: 'text', text: part.text }; }
      else if (part.functionCall) {
        // Gemini 3 sends an id with every call and expects it back on the result; older models send none.
        const fc = part.functionCall;
        const id = typeof fc.id === 'string' && fc.id ? fc.id : generateId(ctx);
        produced = true;
        yield { type: 'tool_use', id, name: fc.name, input: toolInput(fc.args) };
      }
    }
    const fr: unknown = cand?.finishReason;
    if (fr) {
      finished = true;
      if (fr === 'MAX_TOKENS') {
        // Thinking tokens count against maxOutputTokens, so a small budget can run out before any answer.
        if (!produced) throw new OutputLimitError(`${shortName} response was cut off by the output token limit before any text.`, { provider });
        log(`${shortName} response was cut off by the output token limit`);
      } else if (!NORMAL_FINISH.has(String(fr))) {
        yield { type: 'text', text: `${shortName} stopped this response (reason: ${safeText(fr, ctx)}).` };
      }
    }

    if (p.usageMetadata) {
      usage = {
        input: p.usageMetadata.promptTokenCount ?? 0,
        output: (p.usageMetadata.candidatesTokenCount ?? 0) + (p.usageMetadata.thoughtsTokenCount ?? 0),
      };
    }
  }
  if (signal?.aborted) return;
  // A 200 that closes early (a dropped connection, a proxy timeout) must not pass for a complete answer.
  if (!sawChunk) throw new AiProviderError(`${shortName} returned an empty response`, { provider });
  if (!finished) throw new AiProviderError(`${shortName} stream ended before finishReason`, { provider });
  if (usage) yield { type: 'usage', inputTokens: usage.input, outputTokens: usage.output };
}

export const geminiDialect: Dialect = {
  id: 'gemini-generate',

  buildChat(ctx: DialectContext, req: AiRequest, opts: { stream: boolean }) {
    const body: any = { contents: formatContents(req.messages, ctx.model) };
    if (req.systemPrompt) body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
    if (req.tools.length > 0) body.tools = formatTools(req.tools);
    const gen: any = {};
    if (req.maxOutputTokens) gen.maxOutputTokens = req.maxOutputTokens;
    if (req.stopSequences?.length) gen.stopSequences = req.stopSequences;
    if (req.temperature !== undefined) gen.temperature = req.temperature;
    const thinking = req.effort === 'low' ? lowThinking(ctx.model) : undefined;
    if (thinking) gen.thinkingConfig = thinking;
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
