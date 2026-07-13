import { describe, it, expect, beforeEach } from 'vitest';
import {
  hold,
  resolveHold,
  listHeld,
  dropAllHeld,
  getArmed,
  setArmed,
  holdMatches,
  resetHoldStore,
  DEFAULT_HOLD_TIMEOUT_MS,
} from './intercept-hold-store';
import type { HeldFlow } from '../../shared/types/websocket';

function makeFlow(over: Partial<HeldFlow> = {}): HeldFlow {
  return {
    flowId: 'flow-1',
    phase: 'request',
    deviceId: 'dev-1',
    sessionId: null,
    method: 'GET',
    url: 'https://api.example.com/v1/thing',
    headers: { 'content-type': 'application/json' },
    body: null,
    createdAt: Date.now(),
    ...over,
  };
}

describe('intercept-hold-store', () => {
  beforeEach(() => resetHoldStore());

  describe('hold + resolveHold', () => {
    it('resolves the pending promise with the resolution passed to resolveHold', async () => {
      const flow = makeFlow();
      const p = hold(flow);
      // Flow is now tracked as held
      expect(listHeld().map(f => f.flowId)).toEqual(['flow-1']);

      const ok = resolveHold('flow-1', { action: 'forward', modified: { url: 'https://x' } });
      expect(ok).toBe(true);

      const resolution = await p;
      expect(resolution).toEqual({ action: 'forward', modified: { url: 'https://x' } });
      // No longer held after resolve
      expect(listHeld()).toEqual([]);
    });

    it('supports a drop resolution', async () => {
      const p = hold(makeFlow());
      resolveHold('flow-1', { action: 'drop' });
      await expect(p).resolves.toEqual({ action: 'drop' });
    });

    it('fails open to forward on timeout', async () => {
      const p = hold(makeFlow(), { timeoutMs: 20 });
      const resolution = await p;
      expect(resolution).toEqual({ action: 'forward' });
      expect(listHeld()).toEqual([]);
    });

    it('exposes a sane default timeout shorter than the addon 300s ceiling', () => {
      expect(DEFAULT_HOLD_TIMEOUT_MS).toBeLessThan(300_000);
      expect(DEFAULT_HOLD_TIMEOUT_MS).toBeGreaterThan(60_000);
    });

    it('resolveHold returns false for an unknown / already-resolved flow (two UIs racing)', async () => {
      const p = hold(makeFlow());
      expect(resolveHold('flow-1', { action: 'forward' })).toBe(true);
      // Second resolve loses the race
      expect(resolveHold('flow-1', { action: 'drop' })).toBe(false);
      await p;
      expect(resolveHold('nope', { action: 'forward' })).toBe(false);
    });

    it('does not leave a dangling timer after an explicit resolve (no late double-resolve)', async () => {
      const p = hold(makeFlow(), { timeoutMs: 20 });
      resolveHold('flow-1', { action: 'drop' });
      const first = await p;
      expect(first).toEqual({ action: 'drop' });
      // Wait past the timeout window; the flow must stay resolved-as-drop, not re-forward
      await new Promise(r => setTimeout(r, 40));
      expect(listHeld()).toEqual([]);
    });
  });

  describe('listHeld', () => {
    it('lists all currently-held flows with their phase', () => {
      hold(makeFlow({ flowId: 'a', phase: 'request' }));
      hold(makeFlow({ flowId: 'b', phase: 'response', statusCode: 200 }));
      const held = listHeld();
      expect(held).toHaveLength(2);
      expect(held.find(f => f.flowId === 'a')?.phase).toBe('request');
      expect(held.find(f => f.flowId === 'b')?.phase).toBe('response');
    });
  });

  describe('dropAllHeld', () => {
    it('forwards every pending flow and clears the store (capture-stop fail-open)', async () => {
      const p1 = hold(makeFlow({ flowId: 'a' }));
      const p2 = hold(makeFlow({ flowId: 'b' }));
      dropAllHeld();
      await expect(p1).resolves.toEqual({ action: 'forward' });
      await expect(p2).resolves.toEqual({ action: 'forward' });
      expect(listHeld()).toEqual([]);
    });
  });

  describe('armed config', () => {
    it('defaults to disabled with both phases', () => {
      const armed = getArmed();
      expect(armed.enabled).toBe(false);
      expect(armed.phases).toEqual(['request', 'response']);
    });

    it('setArmed merges and normalizes phases', () => {
      const next = setArmed({ enabled: true, matchHostname: '*.example.com', phases: ['request'] });
      expect(next.enabled).toBe(true);
      expect(next.matchHostname).toBe('*.example.com');
      expect(next.phases).toEqual(['request']);
      expect(getArmed()).toEqual(next);
    });

    it('setArmed defaults phases to both when none supplied', () => {
      const next = setArmed({ enabled: true });
      expect(next.phases).toEqual(['request', 'response']);
    });
  });

  describe('holdMatches', () => {
    it('never matches when disabled', () => {
      setArmed({ enabled: false });
      expect(holdMatches(makeFlow(), 'request')).toBe(false);
    });

    it('matches any flow when enabled with no filters', () => {
      setArmed({ enabled: true });
      expect(holdMatches(makeFlow(), 'request')).toBe(true);
    });

    it('respects the phase filter', () => {
      setArmed({ enabled: true, phases: ['response'] });
      expect(holdMatches(makeFlow({ phase: 'request' }), 'request')).toBe(false);
      expect(holdMatches(makeFlow({ phase: 'response' }), 'response')).toBe(true);
    });

    it('matches hostname globs', () => {
      setArmed({ enabled: true, matchHostname: '*.example.com' });
      expect(holdMatches(makeFlow({ url: 'https://api.example.com/x' }), 'request')).toBe(true);
      expect(holdMatches(makeFlow({ url: 'https://other.com/x' }), 'request')).toBe(false);
    });

    it('matches path globs', () => {
      setArmed({ enabled: true, matchPath: '/v1/*' });
      expect(holdMatches(makeFlow({ url: 'https://a.com/v1/thing' }), 'request')).toBe(true);
      expect(holdMatches(makeFlow({ url: 'https://a.com/v2/thing' }), 'request')).toBe(false);
    });

    it('matches method case-insensitively', () => {
      setArmed({ enabled: true, matchMethod: 'post' });
      expect(holdMatches(makeFlow({ method: 'POST' }), 'request')).toBe(true);
      expect(holdMatches(makeFlow({ method: 'GET' }), 'request')).toBe(false);
    });
  });
});
