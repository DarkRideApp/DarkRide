import type {
  AiStreamEvent,
  AiToolDefinition,
  AiMessage,
} from '../../shared/types/ai-chat';

// ── RateLimitError ───────────────────────────────────────────────────

export class RateLimitError extends Error {
  readonly headers: Headers;
  constructor(message: string, headers: Headers) {
    super(message);
    this.name = 'RateLimitError';
    this.headers = headers;
  }
}

// ── Rate limit header parsing ────────────────────────────────────────

export interface ParsedRateLimitHeaders {
  requestsLimit: number | null;
  requestsRemaining: number | null;
  requestsReset: string | null;
  tokensLimit: number | null;
  tokensRemaining: number | null;
  tokensReset: string | null;
}

export function parseRateLimitHeaders(provider: string, headers: Headers): ParsedRateLimitHeaders {
  const nullResult: ParsedRateLimitHeaders = {
    requestsLimit: null, requestsRemaining: null, requestsReset: null,
    tokensLimit: null, tokensRemaining: null, tokensReset: null,
  };

  switch (provider) {
    case 'anthropic': {
      const rl = (key: string) => headers.get(`anthropic-ratelimit-${key}`);
      return {
        requestsLimit: rl('requests-limit') ? Number(rl('requests-limit')) : null,
        requestsRemaining: rl('requests-remaining') ? Number(rl('requests-remaining')) : null,
        requestsReset: rl('requests-reset'),
        tokensLimit: rl('tokens-limit') ? Number(rl('tokens-limit')) : null,
        tokensRemaining: rl('tokens-remaining') ? Number(rl('tokens-remaining')) : null,
        tokensReset: rl('tokens-reset'),
      };
    }
    case 'openrouter':
    case 'codestral': {
      const rl = (key: string) => headers.get(`x-ratelimit-${key}`);
      return {
        requestsLimit: rl('limit-requests') ? Number(rl('limit-requests')) : null,
        requestsRemaining: rl('remaining-requests') ? Number(rl('remaining-requests')) : null,
        requestsReset: rl('reset-requests'),
        tokensLimit: rl('limit-tokens') ? Number(rl('limit-tokens')) : null,
        tokensRemaining: rl('remaining-tokens') ? Number(rl('remaining-tokens')) : null,
        tokensReset: rl('reset-tokens'),
      };
    }
    case 'gemini':
    case 'ollama':
    default:
      return nullResult;
  }
}

// ── Configuration ────────────────────────────────────────────────────

export interface AiProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

// ── Provider interface ───────────────────────────────────────────────

export interface AiProvider {
  readonly name: string;
  lastResponseHeaders?: Headers;
  buildHeaders(): Record<string, string>;
  formatTools(tools: AiToolDefinition[]): any[];
  createStreamingRequest(
    messages: AiMessage[],
    systemPrompt: string,
    tools: AiToolDefinition[],
    options?: { signal?: AbortSignal; tier?: string },
  ): AsyncIterable<AiStreamEvent>;
}

// ── SSE / NDJSON line parsing helpers ────────────────────────────────

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n');
      buffer = parts.pop()!;

      let currentEvent: string | undefined;
      let currentData = '';

      for (const line of parts) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData += (currentData ? '\n' : '') + line.slice(6);
        } else if (line === '') {
          if (currentData) {
            yield { event: currentEvent, data: currentData };
            currentEvent = undefined;
            currentData = '';
          }
        }
      }

      // If there's leftover data without trailing blank line, keep it in buffer
      if (currentData) {
        // Reconstruct as SSE lines for next iteration
        const reconstruct: string[] = [];
        if (currentEvent) reconstruct.push(`event: ${currentEvent}`);
        reconstruct.push(`data: ${currentData}`);
        buffer = reconstruct.join('\n') + '\n' + buffer;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* parseNDJSONStream(
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

// ── Anthropic ───────────────────────────────────────────────────────

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  lastResponseHeaders?: Headers;
  private config: AiProviderConfig;

  constructor(config: AiProviderConfig) {
    this.config = config;
  }

  buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey || '',
      'anthropic-version': '2023-06-01',
    };
  }

  formatTools(tools: AiToolDefinition[]): any[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object', ...t.inputSchema },
    }));
  }

  private formatMessages(messages: AiMessage[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const content: any[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text) {
              content.push({ type: 'text', text: block.text });
            }
          } else {
            content.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        result.push({ role: 'assistant', content });
      } else {
        // tool_result — merge consecutive tool_results into a single user message
        const lastMsg = result[result.length - 1];
        const toolResultBlock = {
          type: 'tool_result',
          tool_use_id: msg.toolUseId,
          content: msg.content,
        };
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content) &&
            lastMsg.content.length > 0 && lastMsg.content[0].type === 'tool_result') {
          lastMsg.content.push(toolResultBlock);
        } else {
          result.push({
            role: 'user',
            content: [toolResultBlock],
          });
        }
      }
    }

    return result;
  }

  async *createStreamingRequest(
    messages: AiMessage[],
    systemPrompt: string,
    tools: AiToolDefinition[],
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AiStreamEvent> {
    const model = this.config.model || 'claude-sonnet-4-20250514';
    const baseUrl = this.config.baseUrl || 'https://api.anthropic.com';

    const body: any = {
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: this.formatMessages(messages),
      stream: true,
    };

    const formattedTools = this.formatTools(tools);
    if (formattedTools.length > 0) {
      body.tools = formattedTools;
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (response.status === 429) {
      throw new RateLimitError(`Anthropic rate limited (429)`, response.headers);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    this.lastResponseHeaders = response.headers;

    if (!response.body) throw new Error('Anthropic response has no body');

    let currentToolId = '';
    let currentToolName = '';
    let currentToolJson = '';
    let messageStopped = false;
    let stopReason: string | undefined;

    for await (const sse of parseSSEStream(response.body, options?.signal)) {
      if (!sse.data || sse.data === '[DONE]') continue;

      let parsed: any;
      try {
        parsed = JSON.parse(sse.data);
      } catch {
        continue;
      }

      switch (parsed.type) {
        case 'content_block_start': {
          const block = parsed.content_block;
          if (block?.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolJson = '';
          }
          break;
        }
        case 'content_block_delta': {
          const delta = parsed.delta;
          if (delta?.type === 'text_delta') {
            yield { type: 'text', text: delta.text };
          } else if (delta?.type === 'input_json_delta') {
            currentToolJson += delta.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          if (currentToolId && currentToolName) {
            let input: Record<string, any> = {};
            try {
              input = JSON.parse(currentToolJson);
            } catch {
              // skip
            }
            yield {
              type: 'tool_use',
              id: currentToolId,
              name: currentToolName,
              input,
            };
            currentToolId = '';
            currentToolName = '';
            currentToolJson = '';
          }
          break;
        }
        case 'message_delta': {
          if (typeof parsed.delta?.stop_reason === 'string') {
            stopReason = parsed.delta.stop_reason;
          }
          if (parsed.usage) {
            yield {
              type: 'usage',
              inputTokens: 0,
              outputTokens: parsed.usage.output_tokens ?? 0,
            };
          }
          break;
        }
        case 'message_start': {
          if (parsed.message?.usage) {
            yield {
              type: 'usage',
              inputTokens: parsed.message.usage.input_tokens ?? 0,
              outputTokens: 0,
            };
          }
          break;
        }
        case 'message_stop': {
          messageStopped = true;
          break;
        }
      }
    }

    // Anthropic sends message_stop only after a complete response. A tunnel or
    // proxy can close a streaming connection cleanly from fetch's perspective;
    // without this check that partial response would be presented as complete.
    if (!messageStopped && !options?.signal?.aborted) {
      throw new Error('Anthropic stream ended before message_stop');
    }
    if (stopReason === 'max_tokens') {
      throw new Error('Anthropic response reached its output token limit');
    }
  }
}

// ── Gemini ───────────────────────────────────────────────────────────

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  lastResponseHeaders?: Headers;
  private config: AiProviderConfig;

  constructor(config: AiProviderConfig) {
    this.config = config;
  }

  buildHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  formatTools(tools: AiToolDefinition[]): any[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  private formatMessages(messages: AiMessage[]): any[] {
    const contents: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        const parts: any[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else {
            parts.push({
              functionCall: { name: block.name, args: block.input },
            });
          }
        }
        contents.push({ role: 'model', parts });
      } else {
        // tool_result
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool_result',
                response: { result: msg.content },
              },
            },
          ],
        });
      }
    }

    return contents;
  }

  async *createStreamingRequest(
    messages: AiMessage[],
    systemPrompt: string,
    tools: AiToolDefinition[],
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AiStreamEvent> {
    const model = this.config.model || 'gemini-2.0-flash';
    const apiKey = this.config.apiKey;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const body: any = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: this.formatMessages(messages),
    };

    const formattedTools = this.formatTools(tools);
    if (formattedTools.length > 0) {
      body.tools = [{ functionDeclarations: formattedTools }];
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (response.status === 429) {
      throw new RateLimitError(`Gemini rate limited (429)`, response.headers);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
    }

    this.lastResponseHeaders = response.headers;

    if (!response.body) throw new Error('Gemini response has no body');

    for await (const sse of parseSSEStream(response.body, options?.signal)) {
      if (sse.data === '[DONE]') return;

      let parsed: any;
      try {
        parsed = JSON.parse(sse.data);
      } catch {
        continue;
      }

      const candidates = parsed.candidates;
      if (!candidates?.length) continue;

      const parts = candidates[0].content?.parts;
      if (!parts) continue;

      for (const part of parts) {
        if (part.text) {
          yield { type: 'text', text: part.text };
        } else if (part.functionCall) {
          yield {
            type: 'tool_use',
            id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          };
        }
      }

      // Usage from Gemini
      if (parsed.usageMetadata) {
        yield {
          type: 'usage',
          inputTokens: parsed.usageMetadata.promptTokenCount ?? 0,
          outputTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
    }
  }
}

// ── Ollama ───────────────────────────────────────────────────────────

export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';
  lastResponseHeaders?: Headers;
  private config: AiProviderConfig;

  constructor(config: AiProviderConfig) {
    this.config = config;
  }

  buildHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  formatTools(tools: AiToolDefinition[]): any[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  private formatMessages(messages: AiMessage[], systemPrompt: string): any[] {
    const result: any[] = [{ role: 'system', content: systemPrompt }];

    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        let textContent = '';
        const toolCalls: any[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text;
          } else {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            });
          }
        }
        const entry: any = { role: 'assistant', content: textContent };
        if (toolCalls.length > 0) entry.tool_calls = toolCalls;
        result.push(entry);
      } else {
        // tool_result
        result.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolUseId,
        });
      }
    }

    return result;
  }

  async *createStreamingRequest(
    messages: AiMessage[],
    systemPrompt: string,
    tools: AiToolDefinition[],
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AiStreamEvent> {
    const baseUrl = this.config.baseUrl || 'http://localhost:11434';
    const model = this.config.model || 'llama3.1';
    const url = `${baseUrl}/api/chat`;

    const body: any = {
      model,
      messages: this.formatMessages(messages, systemPrompt),
      stream: true,
    };

    const formattedTools = this.formatTools(tools);
    if (formattedTools.length > 0) {
      body.tools = formattedTools;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (response.status === 429) {
      throw new RateLimitError(`Ollama rate limited (429)`, response.headers);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorBody}`);
    }

    this.lastResponseHeaders = response.headers;

    if (!response.body) throw new Error('Ollama response has no body');

    for await (const chunk of parseNDJSONStream(response.body, options?.signal)) {
      if (chunk.message?.content) {
        yield { type: 'text', text: chunk.message.content };
      }

      if (chunk.message?.tool_calls) {
        for (const tc of chunk.message.tool_calls) {
          if (tc.function) {
            let input: Record<string, any> = {};
            if (typeof tc.function.arguments === 'string') {
              try {
                input = JSON.parse(tc.function.arguments);
              } catch {
                // skip
              }
            } else if (tc.function.arguments) {
              input = tc.function.arguments;
            }
            yield {
              type: 'tool_use',
              id: tc.id || `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: tc.function.name,
              input,
            };
          }
        }
      }

      // Ollama includes token counts in the final chunk
      if (chunk.done && (chunk.prompt_eval_count || chunk.eval_count)) {
        yield {
          type: 'usage',
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
        };
      }
    }
  }
}

// ── OpenAI-compatible SSE helpers (shared by OpenRouter & Codestral) ─

interface ToolCallBuffer {
  id: string;
  name: string;
  arguments: string;
}

async function* parseOpenAICompatibleSSE(
  body: ReadableStream<Uint8Array>,
  providerName: string,
  signal?: AbortSignal,
): AsyncGenerator<AiStreamEvent> {
  const toolCallBuffers: Map<number, ToolCallBuffer> = new Map();

  for await (const sse of parseSSEStream(body, signal)) {
    if (sse.data === '[DONE]') {
      // Flush any remaining tool calls
      for (const [, tc] of toolCallBuffers) {
        let input: Record<string, any> = {};
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          // skip
        }
        yield { type: 'tool_use', id: tc.id, name: tc.name, input };
      }
      toolCallBuffers.clear();
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(sse.data);
    } catch {
      continue;
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      // Check for top-level usage
      if (parsed.usage) {
        yield {
          type: 'usage',
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
        };
      }
      continue;
    }

    const delta = choice.delta;

    // Text content
    if (delta?.content) {
      yield { type: 'text', text: delta.content };
    }

    // Tool calls with index-based buffering
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;

        if (tc.id) {
          // Start of a new tool call
          toolCallBuffers.set(idx, {
            id: tc.id,
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '',
          });
        } else {
          // Continuation
          const buf = toolCallBuffers.get(idx);
          if (buf) {
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) buf.arguments += tc.function.arguments;
          }
        }
      }
    }

    // Flush tool calls on finish_reason
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
      for (const [, tc] of toolCallBuffers) {
        let input: Record<string, any> = {};
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          // skip
        }
        yield { type: 'tool_use', id: tc.id, name: tc.name, input };
      }
      toolCallBuffers.clear();
    }

    // Usage info
    if (parsed.usage) {
      yield {
        type: 'usage',
        inputTokens: parsed.usage.prompt_tokens ?? 0,
        outputTokens: parsed.usage.completion_tokens ?? 0,
      };
    }
  }
}

function formatOpenAICompatibleMessages(messages: AiMessage[], systemPrompt: string): any[] {
  const result: any[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      let textContent = '';
      const toolCalls: any[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }
      const entry: any = { role: 'assistant', content: textContent };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      result.push(entry);
    } else {
      // tool_result
      result.push({
        role: 'tool',
        content: msg.content,
        tool_call_id: msg.toolUseId,
      });
    }
  }

  return result;
}

function formatOpenAICompatibleTools(tools: AiToolDefinition[]): any[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ── OpenRouter ───────────────────────────────────────────────────────

export class OpenRouterProvider implements AiProvider {
  readonly name = 'openrouter';
  lastResponseHeaders?: Headers;
  private config: AiProviderConfig;

  constructor(config: AiProviderConfig) {
    this.config = config;
  }

  buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };
  }

  formatTools(tools: AiToolDefinition[]): any[] {
    return formatOpenAICompatibleTools(tools);
  }

  async *createStreamingRequest(
    messages: AiMessage[],
    systemPrompt: string,
    tools: AiToolDefinition[],
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AiStreamEvent> {
    const model = this.config.model || 'google/gemini-2.0-flash-001';

    const body: any = {
      model,
      messages: formatOpenAICompatibleMessages(messages, systemPrompt),
      stream: true,
    };

    const formattedTools = this.formatTools(tools);
    if (formattedTools.length > 0) {
      body.tools = formattedTools;
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (response.status === 429) {
      throw new RateLimitError(`OpenRouter rate limited (429)`, response.headers);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`);
    }

    this.lastResponseHeaders = response.headers;

    if (!response.body) throw new Error('OpenRouter response has no body');

    yield* parseOpenAICompatibleSSE(response.body, 'openrouter', options?.signal);
  }
}

// ── Codestral (Mistral) ──────────────────────────────────────────────

export class CodestralProvider implements AiProvider {
  readonly name = 'codestral';
  lastResponseHeaders?: Headers;
  private config: AiProviderConfig;

  constructor(config: AiProviderConfig) {
    this.config = config;
  }

  buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };
  }

  formatTools(tools: AiToolDefinition[]): any[] {
    return formatOpenAICompatibleTools(tools);
  }

  async *createStreamingRequest(
    messages: AiMessage[],
    systemPrompt: string,
    tools: AiToolDefinition[],
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AiStreamEvent> {
    const model = this.config.model || 'mistral-large-latest';

    const body: any = {
      model,
      messages: formatOpenAICompatibleMessages(messages, systemPrompt),
      stream: true,
    };

    const formattedTools = this.formatTools(tools);
    if (formattedTools.length > 0) {
      body.tools = formattedTools;
    }

    const baseUrl = this.config.baseUrl || 'https://api.mistral.ai';
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (response.status === 429) {
      throw new RateLimitError(`Codestral rate limited (429)`, response.headers);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Codestral API error (${response.status}): ${errorBody}`);
    }

    this.lastResponseHeaders = response.headers;

    if (!response.body) throw new Error('Codestral response has no body');

    yield* parseOpenAICompatibleSSE(response.body, 'codestral', options?.signal);
  }
}

// ── Factory ──────────────────────────────────────────────────────────

export function createProvider(name: string, config: AiProviderConfig): AiProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'openrouter':
      return new OpenRouterProvider(config);
    case 'codestral':
      return new CodestralProvider(config);
    default:
      throw new Error(`Unknown AI provider: ${name}`);
  }
}
