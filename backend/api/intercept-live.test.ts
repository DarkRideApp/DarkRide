import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerInterceptLiveEndpoints } from './intercept-live';
import { resetHoldStore, listHeld } from '../services/intercept-hold-store';

const mockBroadcast = vi.fn();
const mockSyncHoldConfig = vi.fn();

function createApp() {
  clearEndpoints();
  registerInterceptLiveEndpoints(mockBroadcast, mockSyncHoldConfig);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

function holdBody(over: Record<string, any> = {}) {
  return {
    flowId: 'flow-1',
    phase: 'request',
    deviceId: 'dev-1',
    sessionId: null,
    method: 'GET',
    url: 'https://api.example.com/v1/thing',
    headers: { 'content-type': 'application/json' },
    body: null,
    ...over,
  };
}

describe('Interactive Intercept API', () => {
  let app: express.Express;

  beforeEach(() => {
    resetHoldStore();
    mockBroadcast.mockClear();
    mockSyncHoldConfig.mockClear();
    app = createApp();
  });

  describe('GET/POST /v1/intercept/armed', () => {
    it('returns the default disarmed config', async () => {
      const res = await request(app).get('/v1/intercept/armed');
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
      expect(res.body.data.phases).toEqual(['request', 'response']);
    });

    it('arms interception, syncs the addon config file, and broadcasts', async () => {
      const res = await request(app)
        .post('/v1/intercept/armed')
        .send({ enabled: true, matchHostname: '*.example.com', phases: ['request'] });
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.matchHostname).toBe('*.example.com');
      expect(mockSyncHoldConfig).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, matchHostname: '*.example.com' }),
      );
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'intercept-armed-changed' }),
      );
    });
  });

  describe('POST /v1/intercept/hold', () => {
    it('forwards immediately when not armed (never holds)', async () => {
      const res = await request(app).post('/v1/intercept/hold').send(holdBody());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ action: 'forward' });
      expect(listHeld()).toEqual([]);
    });

    it('holds a matching flow, broadcasts intercept-held, and returns the resolution once resolved', async () => {
      await request(app).post('/v1/intercept/armed').send({ enabled: true });
      mockBroadcast.mockClear();

      // Fire the hold without awaiting — it blocks until resolved.
      const holdPromise = request(app).post('/v1/intercept/hold').send(holdBody()).then(r => r);

      // Wait for the flow to register as held.
      await vi.waitFor(() => expect(listHeld()).toHaveLength(1));
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'intercept-held', flowId: 'flow-1', phase: 'request' }),
      );

      // Resolve it with an edit.
      const resolveRes = await request(app)
        .post('/v1/intercept/resolve')
        .send({ flowId: 'flow-1', action: 'forward', modified: { url: 'https://x.test/' } });
      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.success).toBe(true);

      const held = await holdPromise;
      expect(held.body).toEqual({ action: 'forward', modified: { url: 'https://x.test/' } });
      // A resolved broadcast lands so every UI drops it from the queue.
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'intercept-resolved', flowId: 'flow-1', action: 'forward' }),
      );
    });

    it('rejects a hold missing flowId', async () => {
      await request(app).post('/v1/intercept/armed').send({ enabled: true });
      const res = await request(app).post('/v1/intercept/hold').send(holdBody({ flowId: undefined }));
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/intercept/resolve', () => {
    it('returns 404 when the flow is not held (second UI loses the race)', async () => {
      const res = await request(app)
        .post('/v1/intercept/resolve')
        .send({ flowId: 'ghost', action: 'forward' });
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('validates the action', async () => {
      const res = await request(app)
        .post('/v1/intercept/resolve')
        .send({ flowId: 'x', action: 'banana' });
      expect(res.status).toBe(400);
    });

    it('a second resolve of the same flow returns 404', async () => {
      await request(app).post('/v1/intercept/armed').send({ enabled: true });
      const holdPromise = request(app).post('/v1/intercept/hold').send(holdBody()).then(r => r);
      await vi.waitFor(() => expect(listHeld()).toHaveLength(1));

      const first = await request(app)
        .post('/v1/intercept/resolve')
        .send({ flowId: 'flow-1', action: 'drop' });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/v1/intercept/resolve')
        .send({ flowId: 'flow-1', action: 'forward' });
      expect(second.status).toBe(404);

      await holdPromise;
    });
  });

  describe('GET /v1/intercept/held', () => {
    it('lists currently-held flows for a client that just connected', async () => {
      await request(app).post('/v1/intercept/armed').send({ enabled: true });
      const holdPromise = request(app).post('/v1/intercept/hold').send(holdBody({ flowId: 'held-1' })).then(r => r);
      await vi.waitFor(() => expect(listHeld()).toHaveLength(1));

      const res = await request(app).get('/v1/intercept/held');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].flowId).toBe('held-1');

      await request(app).post('/v1/intercept/resolve').send({ flowId: 'held-1', action: 'forward' });
      await holdPromise;
    });
  });
});
