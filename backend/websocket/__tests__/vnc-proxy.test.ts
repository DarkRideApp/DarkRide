import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as net from 'net';
import { createVncBridge, type VncBridgeDeps } from '../vnc-proxy';

// A WebSocket stand-in that records sends and exposes message/close emits.
class MockSocket extends EventEmitter {
  sent: Buffer[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: Buffer | string) {
    this.sent.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.emit('close', code, reason);
  }
}

function makeDeps(overrides: Partial<VncBridgeDeps> = {}): VncBridgeDeps {
  return {
    resolveEndpoint: async (serial: string) => {
      if (serial === 'localhost:32770') return { host: '127.0.0.1', port: 5900 };
      return null;
    },
    connectTcp: vi.fn().mockImplementation(() => {
      // Return an EventEmitter that mimics a net.Socket: emits 'data', has write/destroy.
      const sock = new EventEmitter() as any;
      sock.write = vi.fn();
      sock.destroy = vi.fn(() => sock.emit('close'));
      return sock as net.Socket;
    }),
    ...overrides,
  };
}

describe('VNC bridge', () => {
  let ws: MockSocket;

  beforeEach(() => { ws = new MockSocket(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('opens a TCP connection to the resolved endpoint when the bridge starts', async () => {
    const deps = makeDeps();
    await createVncBridge(ws as any, 'localhost:32770', deps);
    expect(deps.connectTcp).toHaveBeenCalledWith('127.0.0.1', 5900);
  });

  it('closes the WS with code 1008 when serial does not resolve', async () => {
    const deps = makeDeps({ resolveEndpoint: async () => null });
    await createVncBridge(ws as any, 'bogus-serial', deps);
    expect(ws.closed).toEqual({ code: 1008, reason: expect.stringMatching(/unknown serial/i) });
  });

  it('closes the WS with code 1011 when resolveEndpoint throws', async () => {
    const deps = makeDeps({ resolveEndpoint: async () => { throw new Error('container not running'); } });
    await createVncBridge(ws as any, 'localhost:32770', deps);
    expect(ws.closed?.code).toBe(1011);
    expect(ws.closed?.reason).toMatch(/container not running/);
  });

  it('forwards bytes from WS to TCP', async () => {
    const tcp = new EventEmitter() as any;
    tcp.write = vi.fn();
    tcp.destroy = vi.fn();
    const deps = makeDeps({ connectTcp: () => tcp });
    await createVncBridge(ws as any, 'localhost:32770', deps);
    ws.emit('message', Buffer.from([0x52, 0x46, 0x42])); // "RFB" — RFB protocol greeting bytes
    expect(tcp.write).toHaveBeenCalledWith(Buffer.from([0x52, 0x46, 0x42]));
  });

  it('forwards bytes from TCP to WS', async () => {
    const tcp = new EventEmitter() as any;
    tcp.write = vi.fn();
    tcp.destroy = vi.fn();
    const deps = makeDeps({ connectTcp: () => tcp });
    await createVncBridge(ws as any, 'localhost:32770', deps);
    tcp.emit('data', Buffer.from([0x01, 0x02, 0x03]));
    expect(ws.sent).toEqual([Buffer.from([0x01, 0x02, 0x03])]);
  });

  it('destroys the TCP socket when the WS closes', async () => {
    const tcp = new EventEmitter() as any;
    tcp.write = vi.fn();
    tcp.destroy = vi.fn();
    const deps = makeDeps({ connectTcp: () => tcp });
    await createVncBridge(ws as any, 'localhost:32770', deps);
    ws.emit('close');
    expect(tcp.destroy).toHaveBeenCalled();
  });

  it('closes the WS when the TCP socket closes', async () => {
    const tcp = new EventEmitter() as any;
    tcp.write = vi.fn();
    tcp.destroy = vi.fn();
    const deps = makeDeps({ connectTcp: () => tcp });
    await createVncBridge(ws as any, 'localhost:32770', deps);
    tcp.emit('close');
    expect(ws.closed?.code).toBe(1001);
  });
});
