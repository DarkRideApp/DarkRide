import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { broadcastToAll, getConnectedClients } from './index';
import { getWebsocketHandler } from './handlers';
import { __resetChannelRegistryForTest } from './channel-registry';
import { clearEndpoints } from '../api/api-service';
import { ADB_PROXY_CHANNEL, registerAdbProxyEndpoints } from '../api/adb-proxy';
import { AdbProxyService } from '../services/adb-proxy/adb-proxy-service';
import { KeyStore } from '../services/adb-proxy/key-store';
import { StubDirectory } from '../services/adb-proxy/testing/stub-directory';
import { makeTestAdbKey } from '../services/adb-proxy/testing/test-keys';
import { createTestDb } from '../test-utils/create-test-db';
import { adbProxyDevices, adbProxyKeys, deviceInstances, devices, settings, users } from '../db/schema';
import type { AdbProxyServiceDeps } from '../services/adb-proxy/adb-proxy-service';

// The websocket logger is destructured at import, so its functions are swapped at module level.
const { wsLogSpy } = vi.hoisted(() => ({ wsLogSpy: vi.fn() }));
vi.mock('../logs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logs')>();
  return {
    ...actual,
    createLoggers: (id: string, options?: { colour?: string }) => {
      const logger = actual.createLoggers(id, options);
      return id === 'websocket' ? { ...logger, log: wsLogSpy } : logger;
    },
  };
});

interface FakeClient {
  readyState: number;
  sent: string[];
  subscriptions: Set<string>;
  authUser?: { username: string; effectiveScopes: Set<string> };
  send: (data: string) => void;
}

function connect(scopes?: string[]): FakeClient {
  const client: FakeClient = {
    readyState: 1,
    sent: [],
    subscriptions: new Set(),
    authUser: scopes ? { username: 'tester', effectiveScopes: new Set(scopes) } : undefined,
    send: (data) => { client.sent.push(data); },
  };
  getConnectedClients().add(client as any);
  return client;
}

function subscribe(client: FakeClient): void {
  const entry = getWebsocketHandler('__ws:subscribe');
  if (!entry) throw new Error('the subscribe handler is not registered');
  void entry.handler({ channels: [ADB_PROXY_CHANNEL] }, client as any);
}

const received = (client: FakeClient) => client.sent.map((raw) => JSON.parse(raw));

describe('ADB proxy live channel', () => {
  const stubService = { snapshot: vi.fn() } as unknown as AdbProxyService;

  beforeEach(() => {
    wsLogSpy.mockClear();
    getConnectedClients().clear();
    clearEndpoints();
    __resetChannelRegistryForTest();
    registerAdbProxyEndpoints(stubService);
  });

  afterEach(() => {
    getConnectedClients().clear();
  });

  it('delivers an adb-proxy message to a client that subscribed with the read scope and to nobody else', () => {
    const reader = connect(['core.adb-proxy:read']);
    const bystander = connect(['core.adb-proxy:read']);
    const unauthenticated = connect();
    subscribe(reader);

    broadcastToAll({ type: ADB_PROXY_CHANNEL, pending: [{ peerIp: '10.0.0.5' }] });

    expect(received(reader)).toEqual([{ type: 'adb-proxy', pending: [{ peerIp: '10.0.0.5' }] }]);
    expect(bystander.sent).toEqual([]);
    expect(unauthenticated.sent).toEqual([]);
  });

  it.each([
    ['holds no ADB proxy scope', ['core.devices:read']],
    ['holds only the manage scope', ['core.adb-proxy:manage']],
    ['holds no scope at all', []],
  ])('denies the subscription of a user who %s, and that client then receives nothing', (_name, scopes) => {
    const intruder = connect(scopes);
    subscribe(intruder);
    expect(intruder.subscriptions.has(ADB_PROXY_CHANNEL)).toBe(false);
    expect(wsLogSpy).toHaveBeenCalledWith(expect.stringContaining('ws subscribe denied'));

    broadcastToAll({ type: ADB_PROXY_CHANNEL, pending: [{ peerIp: '10.0.0.5' }] });

    expect(intruder.sent).toEqual([]);
  });

  it('denies the subscription of a socket with no authenticated user', () => {
    const anonymous = connect();
    subscribe(anonymous);
    expect(anonymous.subscriptions.has(ADB_PROXY_CHANNEL)).toBe(false);
    expect(wsLogSpy).toHaveBeenCalledWith(expect.stringContaining('no auth'));

    broadcastToAll({ type: ADB_PROXY_CHANNEL, pending: [] });

    expect(anonymous.sent).toEqual([]);
  });

  it('keeps a denied client out even when other clients are subscribed and receiving', () => {
    const reader = connect(['core.adb-proxy:read']);
    const intruder = connect(['core.devices:read']);
    subscribe(reader);
    subscribe(intruder);

    broadcastToAll({ type: ADB_PROXY_CHANNEL, n: 1 });
    broadcastToAll({ type: ADB_PROXY_CHANNEL, n: 2 });

    expect(received(reader).map((m) => m.n)).toEqual([1, 2]);
    expect(intruder.sent).toEqual([]);
  });

  describe('with the real service as the sender', () => {
    const cleanups: Array<() => unknown> = [];
    afterEach(async () => {
      for (const c of cleanups.splice(0).reverse()) await c();
    });

    async function startService() {
      const db = createTestDb([users, deviceInstances, devices, settings, adbProxyKeys, adbProxyDevices], { foreignKeys: true });
      const key = makeTestAdbKey('laptop@home');
      new KeyStore(db).upsertDecision({
        keyId: key.keyId, publicKey: key.blob.toString('base64'), comment: 'laptop@home',
        status: 'approved', ip: '10.0.0.5', deviceId: 'DEV1', userId: null,
      });
      const service = new AdbProxyService({
        db,
        directory: new StubDirectory([]),
        backend: { openService: vi.fn(), deviceBanner: vi.fn() } as unknown as AdbProxyServiceDeps['backend'],
        broadcast: broadcastToAll,
        advertisedHost: () => '192.168.1.10',
      });
      clearEndpoints();
      __resetChannelRegistryForTest();
      registerAdbProxyEndpoints(service);
      await service.start();
      cleanups.push(() => service.stop());
      return service;
    }

    it('reaches only the subscribed reader, and what it carries is what a reader must not leak', async () => {
      const service = await startService();
      const reader = connect(['core.adb-proxy:read']);
      const intruder = connect(['core.devices:read']);
      const bystander = connect(['core.adb-proxy:read']);
      subscribe(reader);
      subscribe(intruder);

      await service.updateSettings({});

      await vi.waitFor(() => expect(reader.sent.length).toBeGreaterThan(0));
      const message = received(reader)[0];
      expect(message.type).toBe(ADB_PROXY_CHANNEL);
      expect(message.keys.map((k: { comment: string }) => k.comment)).toEqual(['laptop@home']);
      expect(intruder.sent).toEqual([]);
      expect(bystander.sent).toEqual([]);
    });
  });
});
