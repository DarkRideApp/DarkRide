import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerDevicesProvidersEndpoints } from '../devices-providers';
import { clearEndpoints, getApiRouter } from '../api-service';

function createApp(registry: any, repo: any) {
  clearEndpoints();
  registerDevicesProvidersEndpoints(registry, repo);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('/v1/devices/providers endpoints', () => {
  beforeEach(() => clearEndpoints());

  it('GET /v1/devices/providers returns all registered providers + availability', async () => {
    const reg = {
      list: () => [
        { id: 'docker-android', displayName: 'Docker Android', isAvailable: vi.fn().mockResolvedValue({ available: true }), createInstance: () => {}, getCreateFormSchema: () => Promise.resolve({ fields: [] }) },
        { id: 'avd', displayName: 'AVD', isAvailable: vi.fn().mockResolvedValue({ available: false, installHint: 'install android-sdk' }) },
      ],
    };
    const app = createApp(reg, {});
    const res = await request(app).get('/v1/devices/providers');
    expect(res.status).toBe(200);
    expect(res.body.data.providers).toEqual([
      { id: 'docker-android', displayName: 'Docker Android', available: true, installHint: undefined, capabilities: { canCreate: true } },
      { id: 'avd', displayName: 'AVD', available: false, installHint: 'install android-sdk', capabilities: { canCreate: false } },
    ]);
  });

  it('GET /v1/devices/providers/:id/create-form returns the schema', async () => {
    const schema = { fields: [{ key: 'androidVersion', label: 'Android version', type: 'string' }] };
    const reg = {
      get: () => ({ getCreateFormSchema: vi.fn().mockResolvedValue(schema) }),
    };
    const app = createApp(reg, {});
    const res = await request(app).get('/v1/devices/providers/docker-android/create-form');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(schema);
  });

  it('GET on an unknown provider id returns 404', async () => {
    const reg = { get: () => undefined };
    const app = createApp(reg, {});
    const res = await request(app).get('/v1/devices/providers/nope/create-form');
    expect(res.status).toBe(404);
  });

  it('POST /v1/devices/providers/:id/instances creates + returns the instance', async () => {
    const reg = {
      get: () => ({
        createInstance: vi.fn().mockResolvedValue({ id: 'inst-1', displayName: 'test', state: 'created', spawnedByDarkride: true }),
      }),
    };
    const repo = {
      insert: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1', state: 'created' }),
    };
    const app = createApp(reg, repo);
    const res = await request(app)
      .post('/v1/devices/providers/docker-android/instances')
      .send({ displayName: 'test', config: { androidVersion: '14' } });
    expect(res.status).toBe(200);
    expect(res.body.data.instance).toMatchObject({ id: 99, state: 'created' });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'docker-android',
      runtimeId: 'inst-1',
    }));
  });

  it('POST .../start delegates to provider.startInstance + updates state', async () => {
    const start = vi.fn().mockResolvedValue({ id: 'inst-1', serial: 'localhost:6001' });
    const reg = { get: () => ({ startInstance: start }) };
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1' }),
      updateState: vi.fn(),
    };
    const app = createApp(reg, repo);
    const res = await request(app).post('/v1/devices/providers/docker-android/instances/99/start');
    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalledWith('inst-1');
    expect(repo.updateState).toHaveBeenCalledWith(99, 'running');
  });

  it('POST .../start records last_error when provider throws', async () => {
    const start = vi.fn().mockRejectedValue(new Error('boot timeout'));
    const reg = { get: () => ({ startInstance: start }) };
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1' }),
      updateState: vi.fn(),
    };
    const app = createApp(reg, repo);
    const res = await request(app).post('/v1/devices/providers/docker-android/instances/99/start');
    expect(res.status).toBe(500);
    expect(repo.updateState).toHaveBeenCalledWith(99, 'error', expect.stringContaining('boot timeout'));
  });

  it('DELETE removes the instance', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const reg = { get: () => ({ deleteInstance: remove }) };
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1', state: 'stopped' }),
      delete: vi.fn(),
    };
    const app = createApp(reg, repo);
    const res = await request(app).delete('/v1/devices/providers/docker-android/instances/99');
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith('inst-1');
    expect(repo.delete).toHaveBeenCalledWith(99);
  });
});
