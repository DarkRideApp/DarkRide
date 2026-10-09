// backend/services/ai/dialects/openai-chat.ts
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';
import { createLoggers } from '../../../logs';
import { OPENAI_QUOTA_CODES, OVERLOADED_CODES, OVERLOADED_STATUSES, RATE_LIMIT_CODES, parseSSEStream, safeText } from '../http';
import { AiProviderError, ModelRefusedError, OutputLimitError, OverloadedError, QuotaExhaustedError, RateLimitError } from '../errors';
import type { AiCompleteRequest, AiRequest, Dialect, DialectContext } from '../dialect';
import { isPlainObject, toolInput } from '../tool-input';

const { log } = createLoggers('ai-openai-chat');

/** Base URLs whose server rejected stream_options. Process lifetime. */
const rejectedStreamOptions = new Set<string>();
export function __resetOpenAiChatMemo(): void { rejectedStreamOptions.clear(); }

function headers(ctx: DialectContext): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...(ctx.descriptor.extraHeaders ?? {}) };
  if (ctx.descriptor.auth.scheme === 'bearer' && ctx.apiKey) h.Authorization = `Bearer ${ctx.apiKey}`;
  return h;
}

function formatMessages(messages: AiMessage[], systemPrompt: string): any[] {
  const out: any[] = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      let text = '';
      const toolCalls: any[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') text += block.text;
        else toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
      }
      const entry: any = { role: 'assistant', content: text };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
    } else {
      out.push({ role: 'tool', content: msg.content, tool_call_id: msg.toolUseId });
    }
  }
  return out;
}

function formatTools(tools: AiToolDefinition[]): any[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

function wantsUsage(ctx: DialectContext): boolean {
  const mode = ctx.descriptor.streamUsage ?? 'never';
  if (mode === 'always') return true;
  if (mode === 'try') return !ctx.flags.noStreamUsage && !rejectedStreamOptions.has(ctx.baseUrl);
  return false;
}

function classifyStreamError(payload: any, ctx: DialectContext): AiProviderError {
  const e = payload?.error ?? payload ?? {};
  const msg = typeof e === 'string' ? e : String(e.message ?? e.type ?? 'Unknown stream error');
  const code = Number(typeof e === 'object' ? (e.code ?? e.status) : NaN);
  // OpenRouter sends a numeric code; OpenAI-style servers send string `code` and `type` values instead.
  const names = typeof e === 'object' ? [e.code, e.type].filter((v): v is string => typeof v === 'string') : [];
  const named = (codes: Set<string>) => names.some((n) => codes.has(n));
  const text = `${ctx.descriptor.shortName} stream error: ${safeText(msg, ctx)}`;
  const opts = { provider: ctx.descriptor.id, status: Number.isFinite(code) ? code : undefined };
  if (code === 402 || named(OPENAI_QUOTA_CODES)) return new QuotaExhaustedError(text, opts);
  if (code === 429 || named(RATE_LIMIT_CODES)) return new RateLimitError(text, new Headers(), opts);
  if (OVERLOADED_STATUSES.includes(code) || named(OVERLOADED_CODES)) return new OverloadedError(text, opts);
  return new AiProviderError(text, opts);
}

/** One tool call being assembled. `synthetic` marks an id we made up because the server had not sent one yet. */
interface Buf { id: string; synthetic: boolean; name: string; args: string }

/** The response was cut off: `length` is the output token limit, Mistral's `model_length` the model's context length. */
function cutOff(finish: string | null): boolean {
  return finish === 'length' || finish === 'model_length';
}

/**
 * True when a call's arguments are ready to emit: none at all, or a JSON object. A fragment that parses as something
 * else (`1`, `[1]`) may still be the start of a longer value, so the call keeps waiting for more.
 */
function argsComplete(args: string): boolean {
  if (args.trim() === '') return true;
  try { return isPlainObject(JSON.parse(args)); } catch { return false; }
}

async function* parseStream(res: Response, ctx: DialectContext, signal?: AbortSignal): AsyncGenerator<AiStreamEvent> {
  const shortName = ctx.descriptor.shortName;
  if (!res.body) throw new AiProviderError(`${shortName} response has no body`);

  /** Insertion order is the order the calls started, which is the order they are emitted in. */
  const bufs = new Map<number, Buf>();
  /** Wire `index` -> key of the buffer now receiving that index's fragments (re-pointed when a server reuses an index for a new call). */
  const keyByIndex = new Map<number, number>();
  let nextSynthetic = 1_000_000;
  let newest: number | undefined;
  let finish: string | null = null;
  let done = false;
  let sawContent = false;
  let usage: { input: number; output: number; cached: number } | undefined;

  /**
   * Emit finished tool calls in the order they started. A non-final flush (at finish_reason) stops at the first buffer
   * whose arguments are not yet a complete JSON object, because some servers send finish_reason before the last argument fragment, and a
   * later call must not overtake it. The final flush (end of stream, or a 'length' finish) emits everything: unparsable
   * arguments become `{}`, or an OutputLimitError after truncation. Returns early once the caller has aborted.
   */
  function* flush(final: boolean): Generator<AiStreamEvent> {
    for (const [key, b] of [...bufs]) {
      if (signal?.aborted) return;
      if (!final && !argsComplete(b.args)) break;
      bufs.delete(key);
      if (key === newest) newest = undefined;
      if (!b.name) continue;
      let input: Record<string, any> = {};
      if (b.args.trim() !== '') {
        try { input = toolInput(JSON.parse(b.args)); }
        catch {
          if (cutOff(finish)) {
            throw new OutputLimitError(`${shortName} response reached its output token limit in the middle of a tool call`, { provider: ctx.descriptor.id });
          }
        }
      }
      sawContent = true;
      yield { type: 'tool_use', id: b.id, name: b.name, input };
    }
    if (final) { bufs.clear(); keyByIndex.clear(); newest = undefined; }
  }

  for await (const sse of parseSSEStream(res.body, signal)) {
    // The caller cancelled: events still buffered from the last read are not acted on.
    if (signal?.aborted) return;
    if (sse.data === '[DONE]') { done = true; break; }
    let p: any;
    try { p = JSON.parse(sse.data); } catch { continue; }
    if (p?.error) throw classifyStreamError(p, ctx);
    // prompt_tokens already includes the cached part; cached_tokens is the share of it read from cache.
    if (p?.usage) usage = { input: p.usage.prompt_tokens ?? 0, output: p.usage.completion_tokens ?? 0, cached: p.usage.prompt_tokens_details?.cached_tokens ?? 0 };
    const choice = p?.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason === 'error') throw classifyStreamError({ error: choice.error ?? p.error ?? { message: 'upstream error' } }, ctx);

    const d = choice.delta;
    if (d?.content) {
      sawContent = true;
      yield { type: 'text', text: d.content };
      if (signal?.aborted) return;
    }

    for (const call of d?.tool_calls ?? []) {
      // A server-sent id that differs from the buffer's own id starts a new call. A fragment that carries a real id for a
      // buffer whose id we made up completes that buffer's id instead, unless it opens another named call.
      const startsNew = (cur: Buf | undefined): boolean => {
        if (!cur || !call.id || cur.id === call.id) return false;
        if (cur.synthetic && !(call.function?.name && cur.name)) return false;
        return true;
      };
      let key: number;
      if (typeof call.index === 'number') {
        const mapped = keyByIndex.get(call.index) ?? call.index;
        key = startsNew(bufs.get(mapped)) ? nextSynthetic++ : mapped;
        keyByIndex.set(call.index, key);
      } else {
        const cur = newest === undefined ? undefined : bufs.get(newest);
        key = newest !== undefined && cur && !startsNew(cur) ? newest : nextSynthetic++;
      }
      let b = bufs.get(key);
      if (!b) { b = { id: call.id || ctx.newId(), synthetic: !call.id, name: '', args: '' }; bufs.set(key, b); }
      else if (call.id && b.synthetic) { b.id = call.id; b.synthetic = false; }
      newest = key;
      if (call.function?.name) b.name = call.function.name;
      if (call.function?.arguments) b.args += call.function.arguments;
    }

    if (choice.finish_reason) {
      finish = choice.finish_reason;
      yield* flush(cutOff(finish)); // keep reading afterwards: the usage chunk (and any late argument fragment) follows
      if (signal?.aborted) return;
      if (cutOff(finish)) log(`${shortName} response was cut off by the output token limit`);
      // A filtered response would otherwise just stop, which reads like a finished (or empty) answer.
      if (finish === 'content_filter') {
        const message = `${shortName} stopped this response (reason: ${safeText(finish, ctx)}).`;
        // Nothing produced yet: an error the router can fall back on. Otherwise keep what arrived and add the message.
        if (!sawContent) throw new ModelRefusedError(message, { provider: ctx.descriptor.id });
        yield { type: 'text', text: message };
        if (signal?.aborted) return;
      }
    }
  }

  // Aborted between reads: the stream is incomplete because the caller cancelled it, not because the server
  // misbehaved. Never flush a half-built tool call as `input: {}`, never emit usage, never report "empty response".
  if (signal?.aborted) return;

  if (finish === null && !done) {
    if (bufs.size === 0 && !sawContent) throw new AiProviderError(`${shortName} returned an empty response`, { provider: ctx.descriptor.id });
    log(`${shortName} stream ended without finish_reason or [DONE]; flushing what arrived`);
  }
  yield* flush(true);
  if (signal?.aborted) return;
  if (usage) yield { type: 'usage', inputTokens: usage.input, outputTokens: usage.output, ...(usage.cached > 0 ? { cachedInputTokens: usage.cached } : {}) };
}

export const openAiChatDialect: Dialect = {
  id: 'openai-chat',

  buildChat(ctx: DialectContext, req: AiRequest, opts: { stream: boolean }) {
    const d = ctx.descriptor;
    const body: any = { model: ctx.model, messages: formatMessages(req.messages, req.systemPrompt), stream: opts.stream };
    if (req.tools.length > 0) body.tools = formatTools(req.tools);
    if (req.maxOutputTokens) body[d.maxTokensParam ?? 'max_tokens'] = req.maxOutputTokens;
    if (req.stopSequences?.length && d.sendStop !== false) body.stop = req.stopSequences;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (opts.stream && wantsUsage(ctx)) body.stream_options = { include_usage: true };
    return { url: `${ctx.baseUrl}/chat/completions`, headers: headers(ctx), body };
  },

  parseStream,

  buildFim(ctx: DialectContext, req: AiCompleteRequest) {
    const fim = ctx.descriptor.capabilities.fim!;
    const body: any = { model: ctx.model, prompt: req.prefix, suffix: req.suffix };
    if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens;
    if (req.stopSequences?.length && ctx.descriptor.sendStop !== false) body.stop = req.stopSequences;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    return { url: `${ctx.baseUrl}${fim.path}`, headers: headers(ctx), body };
  },
  parseFim(json: any): string {
    return json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? '';
  },

  buildListModels(ctx: DialectContext) {
    const path = (ctx.descriptor.listModels as { path: string }).path;
    return { url: `${ctx.baseUrl}${path}`, headers: headers(ctx) };
  },
  parseModels(json: any) {
    const models = (json?.data ?? []).map((m: any) => ({ id: m.id, name: m.name || m.id }));
    return { models };
  },

  classifyStreamError,

  retryWith(status, bodyText, ctx) {
    if ((status === 400 || status === 422) && ctx.descriptor.streamUsage === 'try' && !ctx.flags.noStreamUsage && /stream_options/i.test(bodyText)) {
      rejectedStreamOptions.add(ctx.baseUrl);
      return { ...ctx, flags: { ...ctx.flags, noStreamUsage: true } };
    }
    return undefined;
  },
};
