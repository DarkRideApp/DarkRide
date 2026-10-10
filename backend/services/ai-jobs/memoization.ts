import { createHash } from 'crypto';
import type { NodeConfig } from './types';

/** Deterministic stringify: sorts object keys at every level so key order never affects the hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hashes `{config, input}` together, not `input` alone. Since `(nodeId, pipelineVersionId)`
 * already pins `config` for the cache key, hashing `input` alone would be equivalent in
 * practice — but hashing both is strictly safer (covers a future case where the same `nodeId`
 * legitimately gets different config across a hand-edited draft/published split) and costs
 * nothing.
 */
export function computeInputHash(config: NodeConfig, input: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify({ config, input })).digest('hex');
}

/**
 * Node kinds eligible for memoization. `Trigger` is excluded because hashing a Trigger's raw
 * input isn't meaningful (it's the thing that produces the canonical shape everything else
 * hashes against). `Report`/`ForEach` are excluded because they have their own
 * fault-tolerance/per-item semantics that memoization would complicate (Report assembles a mix
 * of per-section outcomes; ForEach has per-item fault tolerance) — enforced structurally here,
 * not by convention, so a future node kind added to NodeConfig without updating this set stays
 * un-memoized by default rather than silently becoming memoizable.
 */
export const MEMOIZABLE_KINDS = new Set(['AgentCall', 'Sink']);
