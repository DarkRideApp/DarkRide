import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { clearEndpoints, getApiRouter, handleWebSocketRestApi } from './api-service';
import { initAuth } from '../auth/init';
import { createTestDb } from '../test-utils/create-test-db';
import { __resetChannelRegistryForTest, getRequiredScopes, isFilteredChannel } from '../websocket/channel-registry';
import { SettingsError } from '../services/adb-proxy/settings';
import type { AdbProxyService } from '../services/adb-proxy/adb-proxy-service';
import { ADB_PROXY_CHANNEL, registerAdbProxyEndpoints } from './adb-proxy';

const SNAPSHOT = { enabled: true, devices: [], pending: [], keys: [], connections: [], counters: {} };

function makeService(over: Record<string, unknown> = {}) {
  return {
    snapshot: vi.fn().mockReturnValue(SNAPSHOT),
    listKeys: vi.fn().mockReturnValue([{ id: 1 }]),
    updateSettings: vi.fn().mockResolvedValue(SNAPSHOT),
    setDevice: vi.fn().mockResolvedValue({ ok: true }),
    approveRequest: vi.fn().mockReturnValue({ ok: true }),
    denyRequest: vi.fn().mockReturnValue({ ok: true }),
    revokeKey: vi.fn().mockReturnValue({ ok: true }),
    forgetKey: vi.fn().mockReturnValue({ ok: true }),
    setKeyDevices: vi.fn().mockReturnValue({ ok: true }),
    ...over,
  };
}

function appFor(service: ReturnType<typeof makeService>, scopes?: string[]) {
  clearEndpoints();
  __resetChannelRegistryForTest();
  registerAdbProxyEndpoints(service as unknown as AdbProxyService);
  const app = express();
  app.use(express.json());
  if (scopes) {
    app.use((req, _res, next) => {
      (req as any).authUser = { userId: 7, effectiveScopes: new Set(scopes) };
      next();
    });
  }
  app.use(getApiRouter());
  return app;
}

function appBehindAuth(service: ReturnType<typeof makeService>) {
  clearEndpoints();
  __resetChannelRegistryForTest();
  registerAdbProxyEndpoints(service as unknown as AdbProxyService);
  const app = express();
  app.use(express.json());
  initAuth(app, createTestDb());
  app.use(getApiRouter());
  return app;
}

const READ = ['core.adb-proxy:read'];
const MANAGE = ['core.adb-proxy:read', 'core.adb-proxy:manage'];

type Method = 'get' | 'put' | 'post' | 'patch' | 'delete';
const READS: Array<[Method, string]> = [
  ['get', '/v1/adb-proxy/status'], ['get', '/v1/adb-proxy/keys'],
];
const WRITES: Array<[Method, string]> = [
  ['put', '/v1/adb-proxy/settings'], ['patch', '/v1/adb-proxy/devices/DEV1'],
  ['post', '/v1/adb-proxy/requests/r1/approve'], ['post', '/v1/adb-proxy/requests/r1/deny'],
  ['post', '/v1/adb-proxy/keys/1/revoke'], ['patch', '/v1/adb-proxy/keys/1'], ['delete', '/v1/adb-proxy/keys/1'],
];

const send = (app: express.Express, method: Method, path: string, body: object = {}) =>
  (request(app) as any)[method](path).send(body);

const expectServiceUntouched = (service: ReturnType<typeof makeService>) => {
  for (const [name, fn] of Object.entries(service)) {
    expect((fn as ReturnType<typeof vi.fn>).mock.calls, name).toHaveLength(0);
  }
};

describe('ADB proxy API', () => {
  let service: ReturnType<typeof makeService>;
  beforeEach(() => { service = makeService(); });

  it('registers the live channel behind the read scope', () => {
    appFor(service);
    expect(isFilteredChannel(ADB_PROXY_CHANNEL)).toBe(true);
    expect(getRequiredScopes(ADB_PROXY_CHANNEL)).toEqual(['core.adb-proxy:read']);
  });

  describe('scope enforcement', () => {
    it('lets a read-only user read and refuses every write with 403', async () => {
      const app = appFor(service, READ);
      expect((await request(app).get('/v1/adb-proxy/status')).status).toBe(200);
      expect((await request(app).get('/v1/adb-proxy/keys')).status).toBe(200);
      for (const [method, path] of WRITES) {
        const res = await send(app, method, path);
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      expect(service.approveRequest).not.toHaveBeenCalled();
    });

    it('refuses a user with no ADB proxy scope', async () => {
      const app = appFor(service, ['core.devices:read']);
      expect((await request(app).get('/v1/adb-proxy/status')).status).toBe(403);
    });
  });

  describe('a request with no authenticated user', () => {
    it.each([...READS, ...WRITES])('answers 401 to %s %s and never reaches the service', async (method, path) => {
      const res = await send(appFor(service), method, path);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expectServiceUntouched(service);
    });

    it.each([...READS, ...WRITES])('is also refused by the server auth stack for %s %s', async (method, path) => {
      const app = appBehindAuth(service);
      expect((await send(app, method, path)).status).toBe(401);
      expect((await (send(app, method, path) as any).set('Cookie', 'darkride_sid=unknown')).status).toBe(401);
      expectServiceUntouched(service);
    });

    it('is refused over the WebSocket REST path as well, and a read-only user still gets 403 there', async () => {
      appFor(service);
      const socket = { send: vi.fn() };
      const ask = async (path: string, authUser?: object) => {
        socket.send.mockClear();
        await handleWebSocketRestApi('POST', path, {}, 'req-1', socket as any, authUser as any);
        return JSON.parse(socket.send.mock.calls[0][0]);
      };
      expect((await ask('/v1/adb-proxy/requests/r1/approve')).status).toBe(401);
      expect((await ask('/v1/adb-proxy/requests/r1/deny')).status).toBe(401);
      expect((await ask('/v1/adb-proxy/requests/r1/approve', { userId: 7, effectiveScopes: new Set(READ) })).status).toBe(403);
      expectServiceUntouched(service);
    });
  });

  it('GET /status returns the snapshot', async () => {
    const res = await request(appFor(service, READ)).get('/v1/adb-proxy/status');
    expect(res.body).toEqual({ success: true, data: SNAPSHOT });
  });

  it('GET /keys returns the key list', async () => {
    const res = await request(appFor(service, READ)).get('/v1/adb-proxy/keys');
    expect(res.body).toEqual({ success: true, data: [{ id: 1 }] });
  });

  describe('PUT /settings', () => {
    it('passes only the known, correctly typed fields to the service', async () => {
      const res = await request(appFor(service, MANAGE)).put('/v1/adb-proxy/settings')
        .send({ enabled: true, bindHost: '10.0.0.2', portStart: 7000, portEnd: 7010, other: 'x' });
      expect(res.status).toBe(200);
      expect(service.updateSettings).toHaveBeenCalledWith({ enabled: true, bindHost: '10.0.0.2', portStart: 7000, portEnd: 7010 });
    });

    it.each([[{ enabled: 'yes' }], [{ bindHost: 5 }], [{ portStart: '7000' }], [{}]])('rejects %j with 400', async (body) => {
      const res = await request(appFor(service, MANAGE)).put('/v1/adb-proxy/settings').send(body);
      expect(res.status).toBe(400);
      expect(service.updateSettings).not.toHaveBeenCalled();
    });

    it.each([
      ['a fractional portStart', '{"portStart":7000.5}'],
      ['a fractional portEnd', '{"portEnd":7010.5}'],
      ['a negative portStart', '{"portStart":-1}'],
      ['a negative portEnd', '{"portEnd":-7010}'],
      ['a non-finite portEnd', '{"portEnd":1e999}'],
    ])('rejects %s with 400 before the service is called', async (_name, raw) => {
      const res = await request(appFor(service, MANAGE)).put('/v1/adb-proxy/settings')
        .set('Content-Type', 'application/json').send(raw);
      expect(res.status).toBe(400);
      expect(service.updateSettings).not.toHaveBeenCalled();
    });

    it('maps a settings validation error to 400 with its message', async () => {
      service = makeService({ updateSettings: vi.fn().mockRejectedValue(new SettingsError('bind host must be an IP address')) });
      const res = await request(appFor(service, MANAGE)).put('/v1/adb-proxy/settings').send({ bindHost: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bind host must be an IP address');
    });

    it('answers an unexpected failure with 500, not a validation 400', async () => {
      service = makeService({ updateSettings: vi.fn().mockRejectedValue(new Error('database is locked')) });
      const res = await request(appFor(service, MANAGE)).put('/v1/adb-proxy/settings').send({ enabled: true });
      expect(res.status).toBe(500);
    });
  });

  describe('PATCH /devices/:id', () => {
    it('forwards enabled and port', async () => {
      const res = await request(appFor(service, MANAGE)).patch('/v1/adb-proxy/devices/DEV1').send({ enabled: false, port: 6501 });
      expect(res.status).toBe(200);
      expect(service.setDevice).toHaveBeenCalledWith('DEV1', { enabled: false, port: 6501 });
    });

    it.each([
      ['unknown-device', 404], ['out-of-range', 400], ['in-use', 409], ['range-full', 409],
    ])('maps %s to %i', async (error, status) => {
      service = makeService({ setDevice: vi.fn().mockResolvedValue({ ok: false, error }) });
      const res = await request(appFor(service, MANAGE)).patch('/v1/adb-proxy/devices/DEV1').send({ port: 1 });
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ success: false, error });
    });

    it('rejects a body of the wrong shape', async () => {
      const res = await request(appFor(service, MANAGE)).patch('/v1/adb-proxy/devices/DEV1').send({ port: 'x' });
      expect(res.status).toBe(400);
    });

    it.each([
      ['a fractional port', '{"port":6501.5}'],
      ['a negative port', '{"port":-6501}'],
      ['a non-finite port', '{"port":1e999}'],
      ['a null port', '{"port":null}'],
      ['an empty body', '{}'],
      ['a body with neither enabled nor port', '{"other":true}'],
    ])('rejects %s with 400 before the service is called', async (_name, raw) => {
      const res = await request(appFor(service, MANAGE)).patch('/v1/adb-proxy/devices/DEV1')
        .set('Content-Type', 'application/json').send(raw);
      expect(res.status).toBe(400);
      expect(service.setDevice).not.toHaveBeenCalled();
    });
  });

  describe('requests and keys', () => {
    it('approve and deny pass the request id and the acting user', async () => {
      const app = appFor(service, MANAGE);
      expect((await request(app).post('/v1/adb-proxy/requests/r1/approve')).status).toBe(200);
      expect(service.approveRequest).toHaveBeenCalledWith('r1', 7);
      expect((await request(app).post('/v1/adb-proxy/requests/r2/deny')).status).toBe(200);
      expect(service.denyRequest).toHaveBeenCalledWith('r2', 7);
    });

    it('answers 404 when the request is gone', async () => {
      service = makeService({ approveRequest: vi.fn().mockReturnValue({ ok: false, error: 'not-found' }) });
      const res = await request(appFor(service, MANAGE)).post('/v1/adb-proxy/requests/r1/approve');
      expect(res.status).toBe(404);
    });

    it('revoke maps not-found to 404 and not-approved to 409', async () => {
      service = makeService({ revokeKey: vi.fn().mockReturnValueOnce({ ok: false, error: 'not-found' }).mockReturnValueOnce({ ok: false, error: 'not-approved' }) });
      const app = appFor(service, MANAGE);
      expect((await request(app).post('/v1/adb-proxy/keys/1/revoke')).status).toBe(404);
      expect((await request(app).post('/v1/adb-proxy/keys/1/revoke')).status).toBe(409);
    });

    it('PATCH /keys/:id sets the device list, and DELETE forgets the key', async () => {
      const app = appFor(service, MANAGE);
      expect((await request(app).patch('/v1/adb-proxy/keys/3').send({ deviceIds: ['A'] })).status).toBe(200);
      expect(service.setKeyDevices).toHaveBeenCalledWith(3, ['A']);
      expect((await request(app).patch('/v1/adb-proxy/keys/3').send({ deviceIds: null })).status).toBe(200);
      expect(service.setKeyDevices).toHaveBeenLastCalledWith(3, null);
      expect((await request(app).delete('/v1/adb-proxy/keys/3')).status).toBe(200);
      expect(service.forgetKey).toHaveBeenCalledWith(3);
    });

    it('PATCH /keys/:id rejects a missing or malformed deviceIds', async () => {
      const app = appFor(service, MANAGE);
      expect((await request(app).patch('/v1/adb-proxy/keys/3').send({})).status).toBe(400);
      service = makeService({ setKeyDevices: vi.fn().mockReturnValue({ ok: false, error: 'invalid' }) });
      expect((await request(appFor(service, MANAGE)).patch('/v1/adb-proxy/keys/3').send({ deviceIds: [1] })).status).toBe(400);
    });

    it('PATCH /keys/:id rejects a deviceIds array of more than 1000 entries before the service is called, and takes exactly 1000', async () => {
      const app = appFor(service, MANAGE);
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `D${i}`);
      expect((await request(app).patch('/v1/adb-proxy/keys/3').send({ deviceIds: ids(1001) })).status).toBe(400);
      expect(service.setKeyDevices).not.toHaveBeenCalled();
      expect((await request(app).patch('/v1/adb-proxy/keys/3').send({ deviceIds: ids(1000) })).status).toBe(200);
      expect(service.setKeyDevices).toHaveBeenCalledTimes(1);
    });

    it.each(['abc', '1.5', '-2'])('rejects the key id %s with 400', async (id) => {
      const app = appFor(service, MANAGE);
      expect((await request(app).post(`/v1/adb-proxy/keys/${id}/revoke`)).status).toBe(400);
      expect((await request(app).delete(`/v1/adb-proxy/keys/${id}`)).status).toBe(400);
    });
  });

  describe('path parameter length', () => {
    const at = (n: number) => 'x'.repeat(n);

    it.each([
      ['approve', 'post', (id: string) => `/v1/adb-proxy/requests/${id}/approve`, 'approveRequest'],
      ['deny', 'post', (id: string) => `/v1/adb-proxy/requests/${id}/deny`, 'denyRequest'],
    ] as const)('refuses a %s request id over 128 characters with 400 and takes 128', async (_name, method, pathOf, call) => {
      const app = appFor(service, MANAGE);
      expect((await send(app, method, pathOf(at(129)))).status).toBe(400);
      expect(service[call]).not.toHaveBeenCalled();
      expect((await send(app, method, pathOf(at(128)))).status).toBe(200);
      expect(service[call]).toHaveBeenCalledTimes(1);
    });

    it('refuses a device id over 128 characters with 400 and takes 128', async () => {
      const app = appFor(service, MANAGE);
      expect((await send(app, 'patch', `/v1/adb-proxy/devices/${at(129)}`, { enabled: true })).status).toBe(400);
      expect(service.setDevice).not.toHaveBeenCalled();
      expect((await send(app, 'patch', `/v1/adb-proxy/devices/${at(128)}`, { enabled: true })).status).toBe(200);
      expect(service.setDevice).toHaveBeenCalledTimes(1);
    });
  });
});
