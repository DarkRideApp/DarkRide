import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { setupWebSocket, setupVncProxy, getWebSocketServer } from '../index';
import type { ProviderRegistry } from '../../services/providers';
import type { DeviceInstancesRepo } from '../../services/device-instances-repo';

function pickPort(server: HttpServer): number {
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('expected AddressInfo');
  return addr.port;
}

describe('setupVncProxy', () => {
  let server: HttpServer;
  let vncWss: WebSocketServer | undefined;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, r));
    // setupWebSocket installs the shared upgrade router that setupVncProxy
    // attaches to. Pass undefined session/db so the existing /ws handler
    // accepts any connection (no users → no auth required).
    setupWebSocket(server, undefined, undefined);
  });

  afterEach(async () => {
    if (vncWss) vncWss.close();
    vncWss = undefined;
    const mainWss = getWebSocketServer();
    if (mainWss) mainWss.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('rejects /ws/vnc without ?serial=', async () => {
    const repo = { getBySerial: vi.fn().mockReturnValue(null) } as unknown as DeviceInstancesRepo;
    const registry = { get: vi.fn() } as unknown as ProviderRegistry;
    vncWss = setupVncProxy(server, { repo, registry });

    const port = pickPort(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vnc`);
    const closeInfo = await new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code: number) => resolve({ code }));
      ws.on('error', () => { /* close follows */ });
    });
    expect(closeInfo.code).toBe(1008);
  });

  it('closes with 1008 when serial does not resolve to an instance', async () => {
    const repo = { getBySerial: vi.fn().mockReturnValue(null) } as unknown as DeviceInstancesRepo;
    const registry = { get: vi.fn() } as unknown as ProviderRegistry;
    vncWss = setupVncProxy(server, { repo, registry });

    const port = pickPort(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vnc?serial=ghost`);
    const closeInfo = await new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code: number) => resolve({ code }));
      ws.on('error', () => { /* close follows */ });
    });
    expect(closeInfo.code).toBe(1008);
  });

  it('closes with 1008 when the provider does not implement getVncEndpoint', async () => {
    const repo = {
      getBySerial: vi.fn().mockReturnValue({ id: 1, providerId: 'adb-device', runtimeId: 'abc' }),
    } as unknown as DeviceInstancesRepo;
    const registry = {
      get: vi.fn().mockReturnValue({ id: 'adb-device' /* no getVncEndpoint */ }),
    } as unknown as ProviderRegistry;
    vncWss = setupVncProxy(server, { repo, registry });

    const port = pickPort(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vnc?serial=x`);
    const closeInfo = await new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code: number) => resolve({ code }));
      ws.on('error', () => { /* close follows */ });
    });
    expect(closeInfo.code).toBe(1008);
  });

  it('routes /ws/vnc to the bridge alongside the main /ws WSS (both run concurrently)', async () => {
    // Regression for the two-WSS-share-upgrade bug: with both setupWebSocket
    // and setupVncProxy active, a /ws/vnc upgrade must reach the vnc bridge,
    // not be aborted by the main /ws WSS's shouldHandle path mismatch.
    const fakeProvider = {
      id: 'docker-android',
      getVncEndpoint: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 65535 /* nothing listens here; bridge will attempt connect */ }),
    };
    const repo = {
      getBySerial: vi.fn().mockReturnValue({ id: 7, providerId: 'docker-android', runtimeId: 'container-abc' }),
    } as unknown as DeviceInstancesRepo;
    const registry = {
      get: vi.fn().mockReturnValue(fakeProvider),
    } as unknown as ProviderRegistry;

    vncWss = setupVncProxy(server, { repo, registry });

    const port = pickPort(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/vnc?serial=localhost:32770`);

    // Bridge should accept the WS upgrade and try (and fail) to connect to
    // the dead port — but the WS itself must have OPENED before the TCP
    // failure tears it down. If the routing is broken, we'd get a 400/1006
    // close immediately with no open event.
    const opened = await new Promise<boolean>((resolve) => {
      let openedFlag = false;
      client.on('open', () => { openedFlag = true; });
      client.on('close', () => resolve(openedFlag));
      client.on('error', () => { /* close follows */ });
    });
    expect(opened).toBe(true);
    expect(repo.getBySerial).toHaveBeenCalledWith('localhost:32770');
    expect(fakeProvider.getVncEndpoint).toHaveBeenCalledWith('container-abc');
  });
});
