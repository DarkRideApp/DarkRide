import type { AiModelRouter } from './ai-model-router';
import type { TierConfig } from './ai-agent';
import { NoModelsConfiguredError } from './ai/errors';
import { createLoggers } from '../logs';

const { error } = createLoggers('ai-tier-config');

/**
 * The research/write providers for a tiered agent run, or null when the run should use the plain single-provider path.
 *
 * Each provider is bound to a tier and goes through the router, so a run falls back to the next model when one is rate
 * limited, down, or refuses the request. It used to be pinned to the top model of each tier, which meant a refusal (or a
 * rate limit) on that one model ended the run even with other models configured.
 *
 * Null when no model is configured at all, or when the top model of either tier runs through the CLI, which cannot do
 * the buffered two-phase streaming a tiered turn needs. An empty tier is served by the nearest tier that has models,
 * the same way the router resolves it for every other request.
 */
export function resolveTierConfig(
  router: AiModelRouter,
  tiers: { research: string; write: string },
  writeToolNames: string[],
): TierConfig | null {
  try {
    // Throws NoModelsConfiguredError when nothing is usable.
    const researchModels = router.getModelsForTier(tiers.research);
    const writeModels = router.getModelsForTier(tiers.write);
    if (router.isCliModel(researchModels[0]) || router.isCliModel(writeModels[0])) return null;
    return {
      researchProvider: router.providerForTier(tiers.research),
      writeProvider: router.providerForTier(tiers.write),
      writeToolNames,
    };
  } catch (err) {
    if (err instanceof NoModelsConfiguredError) return null;
    error(`Could not resolve tier config (${tiers.research}/${tiers.write}), using the single-provider path: ${String(err)}`);
    return null;
  }
}
