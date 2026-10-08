import { randomUUID } from 'crypto';
import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../shared/types/ai-chat';
import { normalizeBaseUrl, type AiProviderDescriptor } from '../../../shared/lib/ai-provider-catalog';
import { AiProviderError, OutputLimitError } from './errors';
import { readJson, sendChat, sendChecked } from './http';
import type {
  AiCompleteRequest, AiProvider, AiProviderConfig, AiRequest, AiStreamOptions, Dialect, DialectContext,
} from './dialect';

const TRIPLE_NEWLINE = /\n\n\n[\s\S]*$/;

/** Completion output stops at the first blank-blank line, whether or not the server honoured `stop`. */
export const trimCompletion = (s: string): string => s.replace(TRIPLE_NEWLINE, '');

const defaultNewId = (): string => `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

/**
 * Resolve everything a request needs from a descriptor and stored configuration, or throw a clear
 * AiProviderError before anything is sent: no model and no default, an invalid stored Base URL, or a
 * provider that needs a Base URL and has none. The key is trimmed (a pasted key often ends in a newline,
 * which fetch rejects as a header value); a key that is only whitespace counts as no key.
 */
export function resolveContext(
  d: AiProviderDescriptor,
  config: { apiKey?: string | null; baseUrl?: string | null; model?: string | null },
  newId: () => string,
): DialectContext {
  const model = config.model?.trim() || d.defaultModel;
  if (!model) throw new AiProviderError(`No model selected for ${d.label}. Choose a model in the model settings.`, { provider: d.id });
  const norm = normalizeBaseUrl(d, config.baseUrl);
  if (!norm.ok) throw new AiProviderError(`${d.label}: invalid Base URL. ${norm.error}`, { provider: d.id });
  const baseUrl = norm.url ?? d.defaultBaseUrl;
  if (!baseUrl) throw new AiProviderError(`${d.label}: Base URL is required`, { provider: d.id });
  return { descriptor: d, baseUrl, apiKey: config.apiKey?.trim() || undefined, model, newId, flags: {} };
}

export class DialectProvider implements AiProvider {
  lastResponseHeaders?: Headers;
  private readonly newId: () => string;

  constructor(
    private readonly descriptor: AiProviderDescriptor,
    private readonly dialect: Dialect,
    private readonly config: AiProviderConfig,
    newId?: () => string,
  ) {
    this.newId = newId ?? defaultNewId;
  }

  get name(): string { return this.descriptor.id; }

  private ctx(): DialectContext {
    return resolveContext(this.descriptor, this.config, this.newId);
  }

  async *createStreamingRequest(
    messages: AiMessage[], systemPrompt: string, tools: AiToolDefinition[], options?: AiStreamOptions,
  ): AsyncIterable<AiStreamEvent> {
    yield* this.stream(this.ctx(), {
      messages, systemPrompt, tools, signal: options?.signal,
      maxOutputTokens: options?.maxOutputTokens, stopSequences: options?.stopSequences,
      temperature: options?.temperature, effort: options?.effort, cache: options?.cache,
    });
  }

  private async *stream(ctx: DialectContext, req: AiRequest): AsyncIterable<AiStreamEvent> {
    const { res, ctx: used } = await sendChat(this.dialect, ctx, req, { stream: true });
    this.lastResponseHeaders = res.headers;
    if (!res.body) throw new AiProviderError(`${this.descriptor.shortName} response has no body`, { provider: this.descriptor.id });
    yield* this.dialect.parseStream(res, used, req.signal);
  }

  /**
   * Inline code completion. Fill-in-the-middle when the descriptor declares it and the model matches its
   * pattern; otherwise a chat request with `prefix<CURSOR>suffix` and no tools, drained to text. An output
   * limit returns the text collected so far. Prompt caching is off (it would pay a write never read), and
   * Anthropic 5.x models get low effort so thinking cannot eat the small output budget.
   */
  async complete(req: AiCompleteRequest): Promise<string> {
    const ctx = this.ctx();
    const fim = this.descriptor.capabilities.fim;
    const d = this.dialect;
    if (fim && d.buildFim && d.parseFim && new RegExp(fim.modelPattern, 'i').test(ctx.model)) {
      const buildFim = d.buildFim.bind(d);
      const { res } = await sendChecked(d, ctx, (c) => buildFim(c, req), { signal: req.signal });
      this.lastResponseHeaders = res.headers;
      return trimCompletion(d.parseFim(await readJson(res, ctx, req.signal)));
    }
    let text = '';
    try {
      for await (const e of this.stream(ctx, {
        messages: [{ role: 'user', content: `${req.prefix}<CURSOR>${req.suffix}` }], systemPrompt: req.systemPrompt ?? '', tools: [],
        signal: req.signal, maxOutputTokens: req.maxOutputTokens, stopSequences: req.stopSequences,
        temperature: req.temperature, effort: 'low', cache: false,
      })) {
        if (e.type === 'text') text += e.text;
      }
    } catch (err) {
      if (!(err instanceof OutputLimitError)) throw err;
    }
    return trimCompletion(text);
  }
}
