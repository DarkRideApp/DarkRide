// backend/services/ai/dialects/openai-chat.ts
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';
import { createLoggers } from '../../../logs';
import { parseSSEStream, safeText } from '../http';
import { AiProviderError, OutputLimitError, OverloadedError, QuotaExhaustedError, RateLimitError } from '../errors';
import type { AiCompleteRequest, AiRequest, Dialect, DialectContext } from '../dialect';

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
  const text = `${ctx.descriptor.shortName} stream error: ${safeText(msg, ctx)}`;
  const opts = { provider: ctx.descriptor.id, status: Number.isFinite(code) ? code : undefined };
  if (code === 402) return new QuotaExhaustedError(text, opts);
  if (code === 429) return new RateLimitError(text, new Headers(), opts);
  if ([502, 503, 529, 408].includes(code)) return new OverloadedError(text, opts);
  return new AiProviderError(text, opts);
}

interface Buf { id: string; name: string; args: string }

async function* parseStream(res: Response, ctx: DialectContext, signal?: AbortSignal): AsyncGenerator<AiStreamEvent> {
  const shortName = ctx.descriptor.shortName;
  if (!res.body) throw new AiProviderError(`${shortName} response has no body`);

  const bufs = new Map<number, Buf>();
  /** Wire `index` -> key of the buffer now receiving that index's fragments (re-pointed when a server reuses an index for a new call). */
  const keyByIndex = new Map<number, number>();
  let nextSynthetic = 1_000_000;
  let newest: number | undefined;
  let finish: string | null = null;
  let done = false;
  let sawContent = false;
  let usage: { input: number; output: number } | undefined;

  function* flush(): Generator<AiStreamEvent> {
    for (const key of [...bufs.keys()].sort((a, b) => a - b)) {
      const b = bufs.get(key)!;
      if (!b.name) continue;
      let input: Record<string, any> = {};
      if (b.args.trim() !== '') {
        try { input = JSON.parse(b.args); }
        catch {
          if (finish === 'length') {
            throw new OutputLimitError(`${shortName} response reached its output token limit in the middle of a tool call`, { provider: ctx.descriptor.id });
          }
        }
      }
      sawContent = true;
      yield { type: 'tool_use', id: b.id, name: b.name, input };
    }
    bufs.clear();
    keyByIndex.clear();
    newest = undefined;
  }

  for await (const sse of parseSSEStream(res.body, signal)) {
    // The caller cancelled: events still buffered from the last read are not acted on.
    if (signal?.aborted) return;
    if (sse.data === '[DONE]') { done = true; break; }
    let p: any;
    try { p = JSON.parse(sse.data); } catch { continue; }
    if (p?.error) throw classifyStreamError(p, ctx);
    if (p?.usage) usage = { input: p.usage.prompt_tokens ?? 0, output: p.usage.completion_tokens ?? 0 };
    const choice = p?.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason === 'error') throw classifyStreamError({ error: choice.error ?? p.error ?? { message: 'upstream error' } }, ctx);

    const d = choice.delta;
    if (d?.content) { sawContent = true; yield { type: 'text', text: d.content }; }

    for (const call of d?.tool_calls ?? []) {
      let key: number;
      if (typeof call.index === 'number') {
        const mapped = keyByIndex.get(call.index) ?? call.index;
        const existing = bufs.get(mapped);
        key = existing && call.id && existing.id !== call.id ? nextSynthetic++ : mapped;
        keyByIndex.set(call.index, key);
      } else if (call.id && (newest === undefined || bufs.get(newest)?.id !== call.id)) {
        key = nextSynthetic++;
      } else {
        key = newest ?? nextSynthetic++;
      }
      let b = bufs.get(key);
      if (!b) { b = { id: call.id || ctx.newId(), name: '', args: '' }; bufs.set(key, b); }
      newest = key;
      if (call.function?.name) b.name = call.function.name;
      if (call.function?.arguments) b.args += call.function.arguments;
    }

    if (choice.finish_reason) {
      finish = choice.finish_reason;
      yield* flush(); // keep reading afterwards: the usage chunk follows finish_reason
    }
  }

  // Aborted between reads: the stream is incomplete because the caller cancelled it, not because the server
  // misbehaved. Never flush a half-built tool call as `input: {}`, never emit usage, never report "empty response".
  if (signal?.aborted) return;

  if (finish === null && !done) {
    if (bufs.size === 0 && !sawContent) throw new AiProviderError(`${shortName} returned an empty response`, { provider: ctx.descriptor.id });
    log(`${shortName} stream ended without finish_reason or [DONE]; flushing what arrived`);
  }
  yield* flush();
  if (usage) yield { type: 'usage', inputTokens: usage.input, outputTokens: usage.output };
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
