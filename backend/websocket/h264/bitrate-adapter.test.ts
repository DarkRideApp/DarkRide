import { describe, it, expect } from 'vitest';
import {
  newAdapterState,
  onReset,
  onTick,
  bitrateForTier,
  BITRATE_TIERS,
  AdapterState,
} from './bitrate-adapter';

describe('bitrate-adapter', () => {
  describe('bitrateForTier', () => {
    it('maps tier 0 → 8 Mbps', () => {
      expect(bitrateForTier(0)).toBe(8_000_000);
    });
    it('maps tier 1 → 4 Mbps (default)', () => {
      expect(bitrateForTier(1)).toBe(4_000_000);
    });
    it('maps tier 4 → 500 kbps (floor)', () => {
      expect(bitrateForTier(4)).toBe(500_000);
    });
    it('clamps tiers above floor to floor', () => {
      expect(bitrateForTier(99)).toBe(500_000);
    });
  });

  describe('onReset', () => {
    it('starts at tier 1 and steps down to tier 2 on first reset', () => {
      const s = onReset(newAdapterState(), 5_000);
      expect(s.tier).toBe(2);
      expect(s.lastRestartAtMs).toBe(5_000);
    });
    it('floor is tier 4 — does not go further', () => {
      let s: AdapterState = { tier: 4, lastRestartAtMs: 0, healthySinceMs: null };
      s = onReset(s, 1_000);
      expect(s.tier).toBe(4);
    });
  });

  describe('onTick', () => {
    it('does not upstep before 30s post-restart lockout', () => {
      const s: AdapterState = { tier: 2, lastRestartAtMs: 1_000, healthySinceMs: 1_000 };
      const next = onTick(s, 25_000, true);
      expect(next.tier).toBe(2);
    });
    it('does not upstep before 60s of healthy stream after lockout', () => {
      const s: AdapterState = { tier: 2, lastRestartAtMs: 0, healthySinceMs: 35_000 };
      const next = onTick(s, 90_000, true); // healthy for 55s
      expect(next.tier).toBe(2);
    });
    it('upsteps when both 30s lockout and 60s healthy are satisfied', () => {
      const s: AdapterState = { tier: 2, lastRestartAtMs: 0, healthySinceMs: 30_000 };
      const next = onTick(s, 91_000, true); // healthy for 61s, lockout passed
      expect(next.tier).toBe(1);
      expect(next.healthySinceMs).toBe(91_000); // restart healthy timer at new tier
    });
    it('resets healthySinceMs when stream is unhealthy', () => {
      const s: AdapterState = { tier: 2, lastRestartAtMs: 0, healthySinceMs: 30_000 };
      const next = onTick(s, 50_000, false);
      expect(next.healthySinceMs).toBeNull();
    });
    it('starts healthySinceMs when stream becomes healthy', () => {
      const s: AdapterState = { tier: 2, lastRestartAtMs: 0, healthySinceMs: null };
      const next = onTick(s, 50_000, true);
      expect(next.healthySinceMs).toBe(50_000);
    });
    it('does not upstep above tier 0 (ceiling)', () => {
      const s: AdapterState = { tier: 0, lastRestartAtMs: 0, healthySinceMs: 0 };
      const next = onTick(s, 100_000, true);
      expect(next.tier).toBe(0);
    });
  });
});
