import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerFridaGadgetEndpoints } from './frida';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

function createApp(mockInjector: any) {
  clearEndpoints();
  registerFridaGadgetEndpoints(mockInjector);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Frida Gadget API', () => {
  let app: express.Express;
  let mockInjector: any;

  beforeEach(() => {
    mockInjector = {
      inject: vi.fn().mockResolvedValue({
        id: 1, packageName: 'com.test', versionCode: 100,
        fridaVersion: '16.0.0', filename: 'test.apk',
      }),
      listInjected: vi.fn().mockReturnValue([]),
      deleteInjected: vi.fn(),
    };

    app = createApp(mockInjector);
  });

  it('POST /v1/frida/gadget/inject calls injector', async () => {
    const res = await request(app)
      .post('/v1/frida/gadget/inject')
      .send({ packageName: 'com.test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.packageName).toBe('com.test');
    expect(mockInjector.inject).toHaveBeenCalledWith('com.test', undefined, undefined);
  });

  it('POST /v1/frida/gadget/inject requires packageName', async () => {
    const res = await request(app)
      .post('/v1/frida/gadget/inject')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('packageName');
  });

  it('POST /v1/frida/gadget/inject passes versionCode and fridaVersion', async () => {
    const res = await request(app)
      .post('/v1/frida/gadget/inject')
      .send({ packageName: 'com.test', versionCode: 200, fridaVersion: '16.1.0' });

    expect(res.status).toBe(200);
    expect(mockInjector.inject).toHaveBeenCalledWith('com.test', 200, '16.1.0');
  });

  it('POST /v1/frida/gadget/inject returns 500 on error', async () => {
    mockInjector.inject.mockRejectedValue(new Error('injection failed'));
    const res = await request(app)
      .post('/v1/frida/gadget/inject')
      .send({ packageName: 'com.test' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('injection failed');
  });

  it('GET /v1/frida/gadget/injected lists cached', async () => {
    mockInjector.listInjected.mockReturnValue([
      { id: 1, packageName: 'com.test', fridaVersion: '16.0.0' },
    ]);
    const res = await request(app).get('/v1/frida/gadget/injected');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });

  it('DELETE /v1/frida/gadget/injected/:id deletes', async () => {
    const res = await request(app).delete('/v1/frida/gadget/injected/1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockInjector.deleteInjected).toHaveBeenCalledWith(1);
  });

  it('POST /v1/frida/gadget/install/:deviceId requires injectedApkId', async () => {
    const res = await request(app)
      .post('/v1/frida/gadget/install/device123')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('injectedApkId');
  });

  it('POST /v1/frida/gadget/install/:deviceId returns 404 for unknown APK', async () => {
    const res = await request(app)
      .post('/v1/frida/gadget/install/device123')
      .send({ injectedApkId: 999 });

    expect(res.status).toBe(404);
  });
});
