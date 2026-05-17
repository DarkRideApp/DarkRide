import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerCaptureEndpoints } from './capture';

function createMockCaptureManager() {
  return {
    startCapture: vi.fn().mockResolvedValue({ sessionId: 42 }),
    stopCapture: vi.fn().mockResolvedValue(undefined),
    isCapturing: vi.fn().mockReturnValue(false),
    getSessionId: vi.fn().mockReturnValue(undefined),
    getSubsystems: vi.fn().mockReturnValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
  };
}

function createApp(captureManager: ReturnType<typeof createMockCaptureManager>) {
  clearEndpoints();
  registerCaptureEndpoints(captureManager as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Capture API Endpoints', () => {
  let mockManager: ReturnType<typeof createMockCaptureManager>;
  let app: express.Express;

  beforeEach(() => {
    mockManager = createMockCaptureManager();
    app = createApp(mockManager);
  });

  describe('POST /v1/capture/start', () => {
    it('should start capture and return sessionId', async () => {
      const res = await request(app)
        .post('/v1/capture/start')
        .send({ deviceId: 'DEV001' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sessionId).toBe(42);
      expect(mockManager.startCapture).toHaveBeenCalledWith('DEV001', undefined, undefined);
    });

    it('should pass proxy options to startCapture', async () => {
      const res = await request(app)
        .post('/v1/capture/start')
        .send({ deviceId: 'DEV001', proxyMode: 'nordvpn', proxyCountry: 'de' });

      expect(res.status).toBe(200);
      expect(mockManager.startCapture).toHaveBeenCalledWith('DEV001', { mode: 'nordvpn', country: 'de' }, undefined);
    });

    it('should pass normal proxy mode', async () => {
      const res = await request(app)
        .post('/v1/capture/start')
        .send({ deviceId: 'DEV001', proxyMode: 'normal' });

      expect(res.status).toBe(200);
      expect(mockManager.startCapture).toHaveBeenCalledWith('DEV001', { mode: 'normal', country: undefined }, undefined);
    });

    it('should return 400 without deviceId', async () => {
      const res = await request(app)
        .post('/v1/capture/start')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('deviceId is required');
    });

    it('should return 500 on manager error', async () => {
      mockManager.startCapture.mockRejectedValue(new Error('tunnel setup failed'));

      const res = await request(app)
        .post('/v1/capture/start')
        .send({ deviceId: 'DEV001' });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('tunnel setup failed');
    });
  });

  describe('POST /v1/capture/stop', () => {
    it('should stop capture', async () => {
      const res = await request(app)
        .post('/v1/capture/stop')
        .send({ deviceId: 'DEV001' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockManager.stopCapture).toHaveBeenCalledWith('DEV001');
    });

    it('should return 400 without deviceId', async () => {
      const res = await request(app)
        .post('/v1/capture/stop')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 500 on manager error', async () => {
      mockManager.stopCapture.mockRejectedValue(new Error('stop failed'));

      const res = await request(app)
        .post('/v1/capture/stop')
        .send({ deviceId: 'DEV001' });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /v1/capture/status/:deviceId', () => {
    it('should return not capturing when no active capture', async () => {
      const res = await request(app)
        .get('/v1/capture/status/DEV001');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.capturing).toBe(false);
      expect(res.body.data.sessionId).toBeNull();
    });

    it('should return capturing with sessionId when active', async () => {
      mockManager.isCapturing.mockReturnValue(true);
      mockManager.getSessionId.mockReturnValue(42);

      const res = await request(app)
        .get('/v1/capture/status/DEV001');

      expect(res.status).toBe(200);
      expect(res.body.data.capturing).toBe(true);
      expect(res.body.data.sessionId).toBe(42);
    });
  });
});
