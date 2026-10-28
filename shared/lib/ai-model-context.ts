/**
 * Context window (prompt tokens) of a model, used to decide when a conversation is too long and to show how full
 * it is.
 *
 * The models below have a 1M-token window, per Anthropic's model list (checked 2026-10-17). A model that is not
 * listed, or a request that does not say which model served it, is taken to have 200K tokens. That is the
 * safe side: a smaller assumed window compacts earlier, never later, so the prompt cannot outgrow the model.
 */

import { normalizeModelId } from './ai-model-pricing';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** Keyed by normalised model id (see `normalizeModelId`). */
const LARGE_CONTEXT_MODELS = new Set([
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
]);

export function contextWindowFor(modelId: string | null | undefined): number {
  if (!modelId || !modelId.trim()) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  return LARGE_CONTEXT_MODELS.has(normalizeModelId(modelId)) ? LARGE_CONTEXT_WINDOW_TOKENS : DEFAULT_CONTEXT_WINDOW_TOKENS;
}
