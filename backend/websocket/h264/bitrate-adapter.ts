export const BITRATE_TIERS = [
  8_000_000, // tier 0 — 8 Mbps (LAN)
  4_000_000, // tier 1 — 4 Mbps (default)
  2_000_000, // tier 2 — 2 Mbps
  1_000_000, // tier 3 — 1 Mbps
    500_000, // tier 4 — 500 kbps (floor)
] as const;

export const DEFAULT_TIER = 1;
export const POST_RESTART_LOCKOUT_MS = 30_000;
export const HEALTHY_FOR_UPSTEP_MS = 60_000;

export interface AdapterState {
  tier: number;
  lastRestartAtMs: number;
  healthySinceMs: number | null;
}

export function newAdapterState(): AdapterState {
  return { tier: DEFAULT_TIER, lastRestartAtMs: 0, healthySinceMs: null };
}

export function bitrateForTier(tier: number): number {
  const clamped = Math.max(0, Math.min(tier, BITRATE_TIERS.length - 1));
  return BITRATE_TIERS[clamped];
}

/**
 * Step down one tier (down to the floor) and record the restart time.
 * Caller invokes when a stream-level reset happens.
 */
export function onReset(s: AdapterState, nowMs: number): AdapterState {
  const tier = Math.min(s.tier + 1, BITRATE_TIERS.length - 1);
  return { tier, lastRestartAtMs: nowMs, healthySinceMs: null };
}

/**
 * Advance state given current health. When both lockout and healthy
 * windows have elapsed, step up one tier (up to the ceiling).
 */
export function onTick(s: AdapterState, nowMs: number, healthy: boolean): AdapterState {
  if (!healthy) {
    return { ...s, healthySinceMs: null };
  }
  const healthySinceMs = s.healthySinceMs ?? nowMs;
  const sinceRestart = nowMs - s.lastRestartAtMs;
  const healthyDuration = nowMs - healthySinceMs;
  if (sinceRestart >= POST_RESTART_LOCKOUT_MS &&
      healthyDuration >= HEALTHY_FOR_UPSTEP_MS &&
      s.tier > 0) {
    return { tier: s.tier - 1, lastRestartAtMs: s.lastRestartAtMs, healthySinceMs: nowMs };
  }
  return { ...s, healthySinceMs };
}
