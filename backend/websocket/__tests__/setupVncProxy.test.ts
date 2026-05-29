import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { setupVncProxy } from '../index';
import type { ProviderRegistry } from '../../services/providers';
import type { DeviceInstancesRepo } from '../../services/device-instances-repo';

function pickPort(server: HttpServer): number {
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('expected AddressInfo');
  return addr.port;
}

describe('setupVncProxy', () => {
  let server: HttpServer;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, r));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('rejects /ws/vnc without ?serial=', async () => {
    const repo = { getBySerial: vi.fn().mockReturnValue(null) } as unknown as DeviceInstancesRepo;
    const registry = { get: vi.fn() } as unknown as ProviderRegistry;
    setupVncProxy(server, { repo, registry });

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
    setupVncProxy(server, { repo, registry });

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
    setupVncProxy(server, { repo, registry });

    const port = pickPort(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vnc?serial=x`);
    const closeInfo = await new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code: number) => resolve({ code }));
      ws.on('error', () => { /* close follows */ });
    });
    expect(closeInfo.code).toBe(1008);
  });
});
