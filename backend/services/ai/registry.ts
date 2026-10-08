import { getProviderDescriptor, type DialectId } from '../../../shared/lib/ai-provider-catalog';
import { UnknownProviderError } from './errors';
import type { AiProvider, AiProviderConfig, Dialect } from './dialect';
import { DialectProvider } from './provider';
import { openAiChatDialect } from './dialects/openai-chat';
import { anthropicDialect } from './dialects/anthropic-messages';
import { geminiDialect } from './dialects/gemini-generate';
import { ollamaDialect } from './dialects/ollama-chat';

const DIALECTS: Record<DialectId, Dialect> = {
  'openai-chat': openAiChatDialect,
  'anthropic-messages': anthropicDialect,
  'gemini-generate': geminiDialect,
  'ollama-chat': ollamaDialect,
};

export function getDialect(id: DialectId): Dialect {
  return DIALECTS[id];
}

/**
 * Build the provider for a stored type id (from `ai_providers.type`). Unknown ids, and the CLI provider, which has
 * no HTTP transport, throw UnknownProviderError with the message callers have always seen.
 */
export function createProvider(typeId: string, config: AiProviderConfig, deps: { newId?: () => string } = {}): AiProvider {
  const descriptor = getProviderDescriptor(typeId);
  if (!descriptor || descriptor.kind !== 'http' || !descriptor.dialect) {
    throw new UnknownProviderError(`Unknown AI provider: ${typeId}`);
  }
  return new DialectProvider(descriptor, DIALECTS[descriptor.dialect], config, deps.newId);
}
