import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as schema from '../db/schema';
import { TrafficHookRegistry } from './traffic-hook-registry';
import { SavedTrafficStore } from './saved-traffic-store';
import type { InterceptRequest } from './traffic-hook-registry';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

function makeRequest(overrides?: Partial<InterceptRequest>): InterceptRequest {
  return {
    deviceId: 'device-1',
    phase: 'request',
    guid: 'flow-123',
    method: 'GET',
    url: 'https://api.disney.com/v1/data',
    hostname: 'api.disney.com',
    path: '/v1/data',
    headers: { 'Accept': 'application/json' },
    body: null,
    ...overrides,
  };
}

describe('TrafficHookRegistry', () => {
  let registry: TrafficHookRegistry;

  beforeEach(() => {
    registry = new TrafficHookRegistry();
  });

  describe('registerHook / hasHooks', () => {
    it('returns unique hookId and hasHooks returns true', () => {
      const id = registry.registerHook('device-1', { hostname: /disney/ });
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(registry.hasHooks('device-1')).toBe(true);
    });

    it('hasHooks returns false for unknown device', () => {
      expect(registry.hasHooks('nonexistent')).toBe(false);
    });
  });

  describe('removeHook', () => {
    it('removes a specific hook', () => {
      const id = registry.registerHook('device-1', { hostname: /disney/ });
      expect(registry.removeHook('device-1', id)).toBe(true);
      expect(registry.hasHooks('device-1')).toBe(false);
    });

    it('returns false for unknown hookId', () => {
      registry.registerHook('device-1', { hostname: /disney/ });
      expect(registry.removeHook('device-1', 'nonexistent')).toBe(false);
    });

    it('returns false for unknown device', () => {
      expect(registry.removeHook('nonexistent', 'any-id')).toBe(false);
    });
  });

  describe('clearHooks', () => {
    it('removes all hooks for a device', () => {
      registry.registerHook('device-1', { hostname: /a/ });
      registry.registerHook('device-1', { hostname: /b/ });
      registry.clearHooks('device-1');
      expect(registry.hasHooks('device-1')).toBe(false);
    });

    it('does not affect other devices', () => {
      registry.registerHook('device-1', { hostname: /a/ });
      registry.registerHook('device-2', { hostname: /b/ });
      registry.clearHooks('device-1');
      expect(registry.hasHooks('device-1')).toBe(false);
      expect(registry.hasHooks('device-2')).toBe(true);
    });
  });

  describe('processIntercept — request phase', () => {
    it('returns pass when no hooks registered', async () => {
      const result = await registry.processIntercept(makeRequest());
      expect(result.action).toBe('pass');
    });

    it('returns pass when no hooks match', async () => {
      registry.registerHook('device-1', { hostname: /google/ }, async (req) => null);
      const result = await registry.processIntercept(makeRequest());
      expect(result.action).toBe('pass');
    });

    it('returns block when callback returns null', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, async () => null);
      const result = await registry.processIntercept(makeRequest());
      expect(result.action).toBe('block');
    });

    it('returns modify when callback returns modified request', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, async (req) => {
        return { ...req, headers: { ...req.headers, 'X-Custom': 'val' } };
      });
      const result = await registry.processIntercept(makeRequest());
      expect(result.action).toBe('modify');
      expect(result.headers!['X-Custom']).toBe('val');
    });

    it('returns pass when callback returns undefined', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, async () => {
        // void return
      });
      const result = await registry.processIntercept(makeRequest());
      expect(result.action).toBe('pass');
    });

    it('accumulates modifications from multiple hooks', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, async (req) => {
        return { ...req, headers: { ...req.headers, 'X-First': '1' } };
      });
      registry.registerHook('device-1', { hostname: /disney/ }, async (req) => {
        return { ...req, headers: { ...req.headers, 'X-Second': '2' } };
      });
      const result = await registry.processIntercept(makeRequest());
      expect(result.action).toBe('modify');
      expect(result.headers!['X-First']).toBe('1');
      expect(result.headers!['X-Second']).toBe('2');
    });

    it('fails open on callback error', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, async () => {
        throw new Error('callback crash');
      });
      const result = await registry.processIntercept(makeRequest());
      expect(result.action).toBe('pass');
    });
  });

  describe('processIntercept — response phase', () => {
    it('returns block when response callback returns null', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, undefined, async () => null);
      const result = await registry.processIntercept(makeRequest({
        phase: 'response',
        status: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: '{"ok":true}',
      }));
      expect(result.action).toBe('block');
    });

    it('returns modify when response callback returns modified response', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, undefined, async (resp) => {
        return { ...resp, status: 403, body: 'forbidden' };
      });
      const result = await registry.processIntercept(makeRequest({
        phase: 'response',
        status: 200,
        responseHeaders: {},
        responseBody: 'ok',
      }));
      expect(result.action).toBe('modify');
      expect(result.status).toBe(403);
      expect(result.responseBody).toBe('forbidden');
    });

    it('returns pass when response callback returns undefined', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, undefined, async () => {
        // void
      });
      const result = await registry.processIntercept(makeRequest({
        phase: 'response',
        status: 200,
        responseHeaders: {},
        responseBody: 'ok',
      }));
      expect(result.action).toBe('pass');
    });
  });

  describe('filter matching', () => {
    it('matches hostname regex', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { hostname: /disney/ }, cb);

      await registry.processIntercept(makeRequest({ hostname: 'api.disney.com' }));
      expect(cb).toHaveBeenCalled();

      cb.mockClear();
      await registry.processIntercept(makeRequest({ hostname: 'api.google.com' }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('matches path regex', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { path: /\/v1\/data/ }, cb);

      await registry.processIntercept(makeRequest({ path: '/v1/data' }));
      expect(cb).toHaveBeenCalled();

      cb.mockClear();
      await registry.processIntercept(makeRequest({ path: '/v2/other' }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('matches method regex', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { method: /POST/ }, cb);

      await registry.processIntercept(makeRequest({ method: 'POST' }));
      expect(cb).toHaveBeenCalled();

      cb.mockClear();
      await registry.processIntercept(makeRequest({ method: 'GET' }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('matches hostname string as substring', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { hostname: 'disney' }, cb);

      await registry.processIntercept(makeRequest({ hostname: 'api.disney.com' }));
      expect(cb).toHaveBeenCalled();

      cb.mockClear();
      await registry.processIntercept(makeRequest({ hostname: 'disney.go.com' }));
      expect(cb).toHaveBeenCalled();

      cb.mockClear();
      await registry.processIntercept(makeRequest({ hostname: 'api.google.com' }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('matches path string as substring', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { path: '/v1/' }, cb);

      await registry.processIntercept(makeRequest({ path: '/v1/data' }));
      expect(cb).toHaveBeenCalled();

      cb.mockClear();
      await registry.processIntercept(makeRequest({ path: '/v2/other' }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('matches method string as substring', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { method: 'POST' }, cb);

      await registry.processIntercept(makeRequest({ method: 'POST' }));
      expect(cb).toHaveBeenCalled();

      cb.mockClear();
      await registry.processIntercept(makeRequest({ method: 'GET' }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('matches url string as substring', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { url: 'disney.com' }, cb);

      await registry.processIntercept(makeRequest({ url: 'https://api.disney.com/v1/data' }));
      expect(cb).toHaveBeenCalled();

      cb.mockClear();
      await registry.processIntercept(makeRequest({ url: 'https://google.com/' }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('mixes string and regex filters', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { hostname: 'disney', method: /^POST$/ }, cb);

      await registry.processIntercept(makeRequest({ hostname: 'api.disney.com', method: 'POST' }));
      expect(cb).toHaveBeenCalled();

      cb.mockClear();
      await registry.processIntercept(makeRequest({ hostname: 'api.disney.com', method: 'GET' }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('requires all specified fields to match', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { hostname: /disney/, method: /POST/ }, cb);

      // hostname matches but method doesn't
      await registry.processIntercept(makeRequest({ hostname: 'api.disney.com', method: 'GET' }));
      expect(cb).not.toHaveBeenCalled();

      // both match
      await registry.processIntercept(makeRequest({ hostname: 'api.disney.com', method: 'POST' }));
      expect(cb).toHaveBeenCalled();
    });
  });

  describe('device isolation', () => {
    it('hooks for different devices do not interfere', async () => {
      const cb1 = vi.fn().mockResolvedValue(undefined);
      const cb2 = vi.fn().mockResolvedValue(undefined);
      registry.registerHook('device-1', { hostname: /disney/ }, cb1);
      registry.registerHook('device-2', { hostname: /disney/ }, cb2);

      await registry.processIntercept(makeRequest({ deviceId: 'device-1' }));
      expect(cb1).toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });
  });

  describe('save() on hook objects', () => {
    let store: SavedTrafficStore;

    beforeEach(() => {
      const db = createTestDb();
      store = new SavedTrafficStore(db);
      registry.setSavedTrafficStore(store);
    });

    it('req.save() defers save until response arrives', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, async (req) => {
        expect(typeof req.save).toBe('function');
        await req.save!();
      });

      // Request phase — nothing saved yet, just pending
      await registry.processIntercept(makeRequest());
      expect(store.list()).toHaveLength(0);

      // Response phase — auto-saves with full request+response
      await registry.processIntercept(makeRequest({
        phase: 'response',
        status: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: '{"deferred":true}',
      }));

      const saved = store.list();
      expect(saved).toHaveLength(1);
      expect(saved[0].url).toBe('https://api.disney.com/v1/data');
      expect(saved[0].method).toBe('GET');
      expect(saved[0].responseStatus).toBe(200);
      expect(saved[0].responseBody).toBe('{"deferred":true}');
    });

    it('response hook object has save() method', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, undefined, async (resp) => {
        expect(typeof resp.save).toBe('function');
        await resp.save!();
      });

      await registry.processIntercept(makeRequest({
        phase: 'response',
        status: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: '{"data":"test"}',
      }));

      const saved = store.list();
      expect(saved).toHaveLength(1);
      expect(saved[0].url).toBe('https://api.disney.com/v1/data');
      expect(saved[0].method).toBe('GET');
      expect(saved[0].responseStatus).toBe(200);
      expect(saved[0].responseBody).toBe('{"data":"test"}');
    });

    it('save() includes deviceId', async () => {
      registry.registerHook('my-device', { hostname: /disney/ }, undefined, async (resp) => {
        await resp.save!();
      });

      await registry.processIntercept(makeRequest({
        phase: 'response',
        deviceId: 'my-device',
        status: 200,
        responseHeaders: {},
        responseBody: 'ok',
      }));

      const saved = store.list();
      expect(saved).toHaveLength(1);
      expect(saved[0].deviceId).toBe('my-device');
    });

    it('req.save() works even when no response hooks are registered', async () => {
      // Only a request hook, no response hook
      registry.registerHook('device-1', { hostname: /disney/ }, async (req) => {
        await req.save!();
      });

      await registry.processIntercept(makeRequest({ guid: 'flow-abc' }));
      expect(store.list()).toHaveLength(0);

      // Response arrives — auto-saves even though no response hook matched
      await registry.processIntercept(makeRequest({
        guid: 'flow-abc',
        phase: 'response',
        status: 201,
        responseHeaders: {},
        responseBody: '{"ok":true}',
      }));

      const saved = store.list();
      expect(saved).toHaveLength(1);
      expect(saved[0].responseStatus).toBe(201);
    });

    it('save() is a no-op when no store is set', async () => {
      const plainRegistry = new TrafficHookRegistry();
      plainRegistry.registerHook('device-1', { hostname: /disney/ }, async (req) => {
        await req.save!(); // Should not throw
      });

      // Should not throw even without a store
      await plainRegistry.processIntercept(makeRequest());
    });

    it('save() on response upserts by URL+method', async () => {
      registry.registerHook('device-1', { hostname: /disney/ }, undefined, async (resp) => {
        await resp.save!();
      });

      await registry.processIntercept(makeRequest({
        phase: 'response',
        status: 200,
        responseHeaders: {},
        responseBody: 'first',
      }));

      await registry.processIntercept(makeRequest({
        phase: 'response',
        status: 200,
        responseHeaders: {},
        responseBody: 'second',
      }));

      const saved = store.list();
      expect(saved).toHaveLength(1);
      expect(saved[0].responseBody).toBe('second');
    });
  });
});
