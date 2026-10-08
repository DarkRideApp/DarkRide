// backend/services/ai/dialects/ollama-chat.ts
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../../shared/types/ai-chat';
import { parseNDJSONStream, safeText } from '../http';
import { AiProviderError } from '../errors';
import { toolInput } from '../tool-input';
import type { AiRequest, Dialect, DialectContext } from '../dialect';

function formatMessages(messages: AiMessage[], systemPrompt: string): any[] {
  const names = new Map<string, string>();
  for (const m of messages) if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);

  const out: any[] = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === 'user') out.push({ role: 'user', content: msg.content });
    else if (msg.role === 'assistant') {
      let text = '';
      const toolCalls: any[] = [];
      for (const b of msg.content) {
        if (b.type === 'text') text += b.text;
        // Ollama's native API documents tool-call arguments as an object; they used to be sent as a JSON string
        else toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: b.input } });
      }
      const entry: any = { role: 'assistant', content: text };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
    } else {
      const name = names.get(msg.toolUseId);
      out.push({ role: 'tool', content: msg.content, tool_call_id: msg.toolUseId, ...(name ? { tool_name: name } : {}) });
    }
  }
  return out;
}

function formatTools(tools: AiToolDefinition[]): any[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

function classifyStreamError(payload: any, ctx: DialectContext): AiProviderError {
  const msg = typeof payload?.error === 'string' ? payload.error : payload?.error?.message ?? 'Unknown error';
  return new AiProviderError(`${ctx.descriptor.shortName} stream error: ${safeText(msg, ctx)}`, { provider: ctx.descriptor.id });
}

/** Ollama sends arguments as an object or as a JSON string: a string is parsed first, then shaped like any other. */
function argumentsInput(args: unknown): Record<string, any> {
  let value = args;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return toolInput(value);
}

async function* parseStream(res: Response, ctx: DialectContext, signal?: AbortSignal): AsyncGenerator<AiStreamEvent> {
  const shortName = ctx.descriptor.shortName;
  if (!res.body) throw new AiProviderError(`${shortName} response has no body`);
  let sawLine = false;
  let finished = false;
  for await (const chunk of parseNDJSONStream(res.body, signal)) {
    // A line can be valid JSON without being an object (null, 7, "text"); there is nothing to read from it.
    if (!chunk || typeof chunk !== 'object') continue;
    sawLine = true;
    if (chunk.done === true) finished = true;
    if (chunk.error) throw classifyStreamError(chunk, ctx);
    if (chunk.message?.content) yield { type: 'text', text: chunk.message.content };
    for (const tc of chunk.message?.tool_calls ?? []) {
      if (!tc.function) continue;
      yield { type: 'tool_use', id: tc.id || ctx.newId(), name: tc.function.name, input: argumentsInput(tc.function.arguments) };
    }
    if (chunk.done && (chunk.prompt_eval_count || chunk.eval_count)) {
      yield { type: 'usage', inputTokens: chunk.prompt_eval_count ?? 0, outputTokens: chunk.eval_count ?? 0 };
    }
  }
  // Ollama always ends a reply with a `done: true` line. Without it the reply was cut off, unless the caller cancelled.
  if (signal?.aborted || finished) return;
  if (!sawLine) throw new AiProviderError(`${shortName} returned an empty response`, { provider: ctx.descriptor.id });
  throw new AiProviderError(`${shortName} stream ended before done`, { provider: ctx.descriptor.id });
}

export const ollamaDialect: Dialect = {
  id: 'ollama-chat',

  buildChat(ctx: DialectContext, req: AiRequest, opts: { stream: boolean }) {
    const body: any = { model: ctx.model, messages: formatMessages(req.messages, req.systemPrompt), stream: opts.stream };
    if (req.tools.length > 0) body.tools = formatTools(req.tools);
    const options: any = {};
    if (req.maxOutputTokens) options.num_predict = req.maxOutputTokens;
    if (req.stopSequences?.length) options.stop = req.stopSequences;
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (Object.keys(options).length > 0) body.options = options;
    return { url: `${ctx.baseUrl}/api/chat`, headers: { 'Content-Type': 'application/json' }, body };
  },
  parseStream,
  classifyStreamError,
  buildListModels(ctx: DialectContext) {
    return { url: `${ctx.baseUrl}/api/tags`, headers: { 'Content-Type': 'application/json' } };
  },
  parseModels(json: any) {
    return {
      models: (json?.models ?? []).map((m: any) => {
        const id = m.model || m.name;
        return { id, name: m.name ?? id };
      }),
    };
  },
};
