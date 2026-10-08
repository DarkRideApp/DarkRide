// backend/services/ai/dialects/anthropic-messages.ts
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';
import { parseSSEStream, safeText } from '../http';
import { AiProviderError, OutputLimitError, OverloadedError, RateLimitError } from '../errors';
import type { AiRequest, Dialect, DialectContext } from '../dialect';

const SUPPORTS_EFFORT = /^claude-(fable|mythos|opus|sonnet|haiku)-5/;
const CYBER_NOTE = " If this is legitimate security work, see Anthropic's Cyber Verification Program.";

function formatTools(tools: AiToolDefinition[]): any[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: 'object', ...t.inputSchema } }));
}

function formatMessages(messages: AiMessage[]): any[] {
  const result: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const content: any[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') { if (block.text) content.push({ type: 'text', text: block.text }); }
        else content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
      result.push({ role: 'assistant', content });
    } else {
      const block = { type: 'tool_result', tool_use_id: msg.toolUseId, content: msg.content };
      const last = result[result.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.length > 0 && last.content[0].type === 'tool_result') last.content.push(block);
      else result.push({ role: 'user', content: [block] });
    }
  }
  return result;
}

function headers(ctx: DialectContext): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': ctx.apiKey || '', ...(ctx.descriptor.extraHeaders ?? {}) };
}

function classifyStreamError(payload: any, ctx: DialectContext): AiProviderError {
  const e = payload?.error ?? payload ?? {};
  const msg = e.message || e.type || 'Unknown Anthropic stream error';
  const text = `${ctx.descriptor.shortName} stream error: ${safeText(msg, ctx)}`;
  const opts = { provider: ctx.descriptor.id };
  if (e.type === 'overloaded_error') return new OverloadedError(text, opts);
  if (e.type === 'rate_limit_error') return new RateLimitError(text, new Headers(), opts);
  return new AiProviderError(text, opts);
}

async function* parseStream(res: Response, ctx: DialectContext, signal?: AbortSignal): AsyncGenerator<AiStreamEvent> {
  const shortName = ctx.descriptor.shortName;
  if (!res.body) throw new AiProviderError(`${shortName} response has no body`);

  let toolId = '', toolName = '', toolJson = '';
  let messageStopped = false;
  let stopReason: string | undefined;
  let refusalCategory: string | null | undefined;
  let emittedOut = 0;

  for await (const sse of parseSSEStream(res.body, signal)) {
    if (!sse.data || sse.data === '[DONE]') continue;
    let p: any;
    try { p = JSON.parse(sse.data); } catch { continue; }

    if (p.type === 'error') throw classifyStreamError(p, ctx);

    switch (p.type) {
      case 'message_start': {
        const u = p.message?.usage;
        if (u) {
          const cacheRead = u.cache_read_input_tokens ?? 0;
          const total = (u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0);
          yield { type: 'usage', inputTokens: total, outputTokens: 0, ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}) };
        }
        break;
      }
      case 'content_block_start':
        if (p.content_block?.type === 'tool_use') { toolId = p.content_block.id; toolName = p.content_block.name; toolJson = ''; }
        break;
      case 'content_block_delta': {
        const d = p.delta;
        if (d?.type === 'text_delta') yield { type: 'text', text: d.text };
        else if (d?.type === 'input_json_delta') toolJson += d.partial_json;
        break;
      }
      case 'content_block_stop':
        if (toolId && toolName) {
          let input: Record<string, any> = {};
          try { input = JSON.parse(toolJson); } catch { /* keep {} */ }
          yield { type: 'tool_use', id: toolId, name: toolName, input };
          toolId = toolName = toolJson = '';
        }
        break;
      case 'message_delta': {
        if (typeof p.delta?.stop_reason === 'string') stopReason = p.delta.stop_reason;
        if (stopReason === 'refusal') {
          const details = p.delta?.stop_details ?? p.stop_details;
          refusalCategory = details?.category ?? null;
        }
        const out = p.usage?.output_tokens;
        if (typeof out === 'number') {
          const delta = Math.max(0, out - emittedOut);
          emittedOut = Math.max(emittedOut, out);
          yield { type: 'usage', inputTokens: 0, outputTokens: delta };
        }
        break;
      }
      case 'message_stop':
        messageStopped = true;
        break;
    }
  }

  // message_stop is sent only after a complete response; a proxy can close cleanly mid-way.
  if (!messageStopped && !signal?.aborted) throw new AiProviderError(`${shortName} stream ended before message_stop`, { provider: ctx.descriptor.id });
  if (stopReason === 'max_tokens') throw new OutputLimitError(`${shortName} response reached its output token limit`, { provider: ctx.descriptor.id });
  if (stopReason === 'model_context_window_exceeded') throw new OutputLimitError(`${shortName} response reached its context window limit`, { provider: ctx.descriptor.id });
  if (stopReason === 'refusal') {
    const cat = refusalCategory ? ` (category: ${refusalCategory})` : '';
    yield { type: 'text', text: `Claude declined this request${cat}.${refusalCategory === 'cyber' ? CYBER_NOTE : ''}` };
  }
}

export const anthropicDialect: Dialect = {
  id: 'anthropic-messages',

  buildChat(ctx: DialectContext, req: AiRequest, opts: { stream: boolean }) {
    const d = ctx.descriptor;
    const body: any = {
      model: ctx.model,
      max_tokens: req.maxOutputTokens ?? d.defaultMaxOutputTokens ?? 16000,
      messages: formatMessages(req.messages),
      stream: opts.stream,
    };
    if (req.systemPrompt) body.system = req.systemPrompt;
    if (req.tools.length > 0) body.tools = formatTools(req.tools);
    if (req.stopSequences?.length) body.stop_sequences = req.stopSequences;
    if (req.cache !== false) body.cache_control = { type: 'ephemeral' };
    if (req.effort === 'low' && SUPPORTS_EFFORT.test(ctx.model)) body.output_config = { effort: 'low' };
    // Deliberately absent: temperature, top_p, top_k, thinking, tool_choice. Current models
    // reject non-default sampling and forced tool choice; omitting thinking keeps each model's default.
    return { url: `${ctx.baseUrl}/v1/messages`, headers: headers(ctx), body };
  },

  parseStream,
  classifyStreamError,

  buildListModels(ctx: DialectContext, page?: string) {
    return { url: `${ctx.baseUrl}/v1/models?limit=1000${page ? `&after_id=${encodeURIComponent(page)}` : ''}`, headers: headers(ctx) };
  },
  parseModels(json: any) {
    const models = (json?.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name || m.id }));
    return { models, next: json?.has_more && json?.last_id ? json.last_id : undefined };
  },
};
