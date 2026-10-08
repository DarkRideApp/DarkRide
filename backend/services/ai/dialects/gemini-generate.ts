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

function classifyStreamError(payload: any, ctx: DialectContext): AiProviderError {
  const e = payload?.error ?? payload ?? {};
  const isObj = typeof e === 'object';
  const message = String((isObj ? e.message : e) || 'Unknown error');
  const text = `${ctx.descriptor.shortName} stream error: ${safeText(message, ctx)}`;
  const code = Number(isObj ? e.code : NaN);
  const grpcStatus: unknown = isObj ? e.status : undefined;
  const opts = { provider: ctx.descriptor.id, status: Number.isFinite(code) && code > 0 ? code : undefined };
  // Quota wording is checked before the status code: Google sends its billing/quota exhaustion as a 429.
  if (grpcStatus === 'RESOURCE_EXHAUSTED' && /billing|quota/i.test(message)) return new QuotaExhaustedError(text, opts);
  if (code === 429) return new RateLimitError(text, new Headers(), opts);
  if (code === 502 || code === 503 || grpcStatus === 'UNAVAILABLE') return new OverloadedError(text, opts);
  return new AiProviderError(text, opts);
}

/** Gemini answers a bad API key with HTTP 400 INVALID_ARGUMENT (reason API_KEY_INVALID), not 401. */
function classifyError(status: number, _headers: Headers, bodyText: string): AiProviderError | undefined {
  if (status !== 400 || !/API_KEY_INVALID|API key not valid/i.test(bodyText)) return undefined;
  let msg = bodyText.trim();
  try {
    const m = JSON.parse(bodyText)?.error?.message;
    if (typeof m === 'string' && m) msg = m;
  } catch { /* not JSON: use the raw text */ }
  // No DialectContext on this hook, so there is no key to redact; safeText still caps the length.
  return new AuthError(`Gemini API error (400): ${safeText(msg, {})}`, { status });
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
