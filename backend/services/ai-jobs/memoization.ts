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
  // Normalize through a JSON round-trip before hashing. Two real gaps otherwise:
  //   1. A Date hashes as '{}' via stableStringify alone (JSON.stringify never visits a Date's
  //      own fields directly — it calls toJSON() first when present on a plain object literal
  //      passed straight to our stringify, which never happens for a bare Date), so two
  //      different dates could collide into a false "unchanged" hit.
  //   2. A key explicitly set to `undefined` hashes differently from that key being absent
  //      entirely — and it matters, because a hash computed in-memory now has to match the same
  //      hash recomputed after a round-trip through a DB's JSON column in a later run (Task 19),
  //      and an `undefined`-valued key never survives that round-trip.
  // JSON.parse(JSON.stringify(...)) collapses both to the same representation up front, so the
  // hash matches what will actually be persisted and reloaded.
  const normalized = JSON.parse(JSON.stringify({ config, input }));
  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
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
export const MEMOIZABLE_KINDS: ReadonlySet<string> = new Set(['AgentCall', 'Sink']);
