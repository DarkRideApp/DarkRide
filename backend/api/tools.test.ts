import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerToolEndpoints } from './tools';
import type { ToolManager } from '../services/tool-manager';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const STATUS = {
  tools: [{ name: 'jadx', installed: true, version: '1.5.1', path: '/opt/example/tools/jadx/bin/jadx' }],
  java: true,
};

function createManager() {
  return {
    getStatus: vi.fn().mockResolvedValue(STATUS),
    downloadTool: vi.fn().mockResolvedValue(undefined),
    ensureTools: vi.fn().mockResolvedValue({ jadx: null, apktool: null, mobsfscan: null, java: null, blutter: null }),
  };
}

/** `scopes` are the caller's effective scopes; null sends the request with no identity, as if auth had not run. */
function createApp(manager: ReturnType<typeof createManager>, scopes: string[] | null): express.Express {
  clearEndpoints();
  registerToolEndpoints(manager as unknown as ToolManager);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (scopes) {
      req.authUser = { userId: 1, username: 'u', via: 'apikey', effectiveScopes: new Set(scopes) };
    }
    next();
  });
  app.use(getApiRouter());
  return app;
}

describe('analysis tool routes', () => {
  let manager: ReturnType<typeof createManager>;

  beforeEach(() => {
    manager = createManager();
  });

  describe('GET /v1/tools/status', () => {
    it('returns the status to a caller with core.apk:read', async () => {
      const res = await request(createApp(manager, ['core.apk:read'])).get('/v1/tools/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: STATUS });
    });

    it('accepts a wildcard grant that covers the scope', async () => {
      const res = await request(createApp(manager, ['core.apk:*'])).get('/v1/tools/status');
      expect(res.status).toBe(200);
    });

    it('refuses with 403 and reveals no tool paths when the scope is missing', async () => {
      const res = await request(createApp(manager, ['core.devices:read'])).get('/v1/tools/status');
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('/opt/example');
      expect(manager.getStatus).not.toHaveBeenCalled();
    });

    it('refuses a caller with no scopes at all', async () => {
      const res = await request(createApp(manager, [])).get('/v1/tools/status');
      expect(res.status).toBe(403);
      expect(manager.getStatus).not.toHaveBeenCalled();
    });

    it('answers 401 and reveals nothing when the request carries no identity', async () => {
      const res = await request(createApp(manager, null)).get('/v1/tools/status');
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain('/opt/example');
      expect(manager.getStatus).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/tools/install/:toolName', () => {
    it('installs the named tool for a caller with core.apk:manage and returns the new status', async () => {
      const res = await request(createApp(manager, ['core.apk:manage'])).post('/v1/tools/install/jadx');
      expect(res.status).toBe(200);
      expect(manager.downloadTool).toHaveBeenCalledExactlyOnceWith('jadx');
      expect(res.body).toEqual({ success: true, data: STATUS });
    });

    it('refuses core.apk:read alone with 403 and installs nothing', async () => {
      const res = await request(createApp(manager, ['core.apk:read'])).post('/v1/tools/install/jadx');
      expect(res.status).toBe(403);
      expect(manager.downloadTool).not.toHaveBeenCalled();
    });

    it('refuses a caller with no scopes at all, installing nothing', async () => {
      const res = await request(createApp(manager, [])).post('/v1/tools/install/mobsfscan');
      expect(res.status).toBe(403);
      expect(manager.downloadTool).not.toHaveBeenCalled();
    });

    it('answers 401 and installs nothing when the request carries no identity', async () => {
      const res = await request(createApp(manager, null)).post('/v1/tools/install/apktool');
      expect(res.status).toBe(401);
      expect(manager.downloadTool).not.toHaveBeenCalled();
    });

    it('checks the scope before it looks at the tool name', async () => {
      const res = await request(createApp(manager, [])).post('/v1/tools/install/not-a-tool');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient scope');
    });

    it('rejects an unknown tool name with 400 for an authorised caller', async () => {
      const res = await request(createApp(manager, ['core.apk:manage'])).post('/v1/tools/install/not-a-tool');
      expect(res.status).toBe(400);
      expect(manager.downloadTool).not.toHaveBeenCalled();
    });

    it('reports an install failure as 500', async () => {
      manager.downloadTool.mockRejectedValue(new Error('download failed'));
      const res = await request(createApp(manager, ['core.apk:manage'])).post('/v1/tools/install/jadx');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'download failed' });
    });
  });

  describe('POST /v1/tools/install-all', () => {
    it('installs every missing tool for a caller with core.apk:manage', async () => {
      const res = await request(createApp(manager, ['core.apk:manage'])).post('/v1/tools/install-all');
      expect(res.status).toBe(200);
      expect(manager.ensureTools).toHaveBeenCalledTimes(1);
    });

    it('refuses core.apk:read alone with 403 and installs nothing', async () => {
      const res = await request(createApp(manager, ['core.apk:read'])).post('/v1/tools/install-all');
      expect(res.status).toBe(403);
      expect(manager.ensureTools).not.toHaveBeenCalled();
    });

    it('answers 401 and installs nothing when the request carries no identity', async () => {
      const res = await request(createApp(manager, null)).post('/v1/tools/install-all');
      expect(res.status).toBe(401);
      expect(manager.ensureTools).not.toHaveBeenCalled();
    });
  });
});
