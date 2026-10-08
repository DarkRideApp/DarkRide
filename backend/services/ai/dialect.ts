import type { AiMessage, AiStreamEvent, AiToolDefinition } from '../../../shared/types/ai-chat';
import type { AiProviderDescriptor, DialectId } from '../../../shared/lib/ai-provider-catalog';
import type { AiProviderError } from './errors';

export interface AiProviderConfig { apiKey?: string; baseUrl?: string; model?: string }

export interface AiRequest {
  messages: AiMessage[];
  systemPrompt: string;
  tools: AiToolDefinition[];
  maxOutputTokens?: number;
  stopSequences?: string[];
  temperature?: number;
  effort?: 'low';
  cache?: boolean;           // default true
  signal?: AbortSignal;
}

export interface AiCompleteRequest {
  prefix: string;
  suffix: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
  stopSequences?: string[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface AiStreamOptions {
  signal?: AbortSignal;
  tier?: string;
  maxOutputTokens?: number;
  stopSequences?: string[];
  temperature?: number;
  effort?: 'low';
  cache?: boolean;
}

export interface DialectContext {
  descriptor: AiProviderDescriptor;
  baseUrl: string;                 // normalised, never empty
  apiKey?: string;
  model: string;
  newId: () => string;
  flags: { noStreamUsage?: boolean };
}

export interface BuiltRequest { url: string; headers: Record<string, string>; body: unknown }

export interface Dialect {
  id: DialectId;
  buildChat(ctx: DialectContext, req: AiRequest, opts: { stream: boolean }): BuiltRequest;
  parseStream(res: Response, ctx: DialectContext, signal?: AbortSignal): AsyncIterable<AiStreamEvent>;
  buildFim?(ctx: DialectContext, req: AiCompleteRequest): BuiltRequest;
  parseFim?(json: unknown): string;
  buildListModels?(ctx: DialectContext, page?: string): { url: string; headers: Record<string, string> };
  parseModels?(json: unknown): { models: { id: string; name: string }[]; next?: string };
  classifyError?(status: number, headers: Headers, bodyText: string): AiProviderError | undefined;
  classifyStreamError?(payload: unknown, ctx: DialectContext): AiProviderError;   // ctx supplies shortName and the key for redaction
  retryWith?(status: number, bodyText: string, ctx: DialectContext): DialectContext | undefined;
}

export interface AiProvider {
  readonly name: string;
  lastResponseHeaders?: Headers;
  createStreamingRequest(
    messages: AiMessage[],
    systemPrompt: string,
    tools: AiToolDefinition[],
    options?: AiStreamOptions,
  ): AsyncIterable<AiStreamEvent>;
  complete(req: AiCompleteRequest): Promise<string>;
}

/** What ai-agent.ts, TierConfig, and the index.ts facade need. */
export type AiStreamingProvider = Pick<AiProvider, 'name' | 'lastResponseHeaders' | 'createStreamingRequest'>;
