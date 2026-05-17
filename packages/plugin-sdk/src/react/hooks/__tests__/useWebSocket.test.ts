import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWebSocketManager } from '../useWebSocketManager';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  binaryType = 'arraybuffer';
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (global as any).WebSocket = FakeWebSocket;
  (global as any).window = { location: { protocol: 'http:', host: 'localhost' } };
});

function parseSent(ws: FakeWebSocket): any[] {
  return ws.sent.map((s) => JSON.parse(s));
}

describe('useWebSocket — channel refcount', () => {
  it('first subscribe to a channel sends an upstream __ws:subscribe', () => {
    const m = createWebSocketManager();
    m.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    m.subscribe('demo-plugin:change', () => {});

    const sent = parseSent(ws);
    const sub = sent.find((s) => s.action === '__ws:subscribe');
    expect(sub).toBeDefined();
    expect(sub.channels).toEqual(['demo-plugin:change']);
  });

  it('second subscribe to the same channel does NOT send a duplicate upstream message', () => {
    const m = createWebSocketManager();
    m.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    m.subscribe('demo-plugin:change', () => {});
    m.subscribe('demo-plugin:change', () => {});

    const subs = parseSent(ws).filter((s) => s.action === '__ws:subscribe');
    expect(subs).toHaveLength(1);
  });

  it('first unsubscribe with multiple subscribers does NOT send upstream unsubscribe', () => {
    const m = createWebSocketManager();
    m.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const u1 = m.subscribe('demo-plugin:change', () => {});
    m.subscribe('demo-plugin:change', () => {});
    u1();

    const unsubs = parseSent(ws).filter((s) => s.action === '__ws:unsubscribe');
    expect(unsubs).toHaveLength(0);
  });

  it('last unsubscribe sends upstream __ws:unsubscribe', () => {
    const m = createWebSocketManager();
    m.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const u1 = m.subscribe('demo-plugin:change', () => {});
    const u2 = m.subscribe('demo-plugin:change', () => {});
    u1();
    u2();

    const unsubs = parseSent(ws).filter((s) => s.action === '__ws:unsubscribe');
    expect(unsubs).toHaveLength(1);
    expect(unsubs[0].channels).toEqual(['demo-plugin:change']);
  });

  it('on-open re-sends the active set after a reconnect', () => {
    const m = createWebSocketManager();
    m.connect();
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    m.subscribe('demo-plugin:change', () => {});
    m.subscribe('maps:tile-update', () => {});

    // simulate reconnect: close + reopen via a new instance
    ws1.close();
    m.connect();
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();

    const subs = parseSent(ws2).filter((s) => s.action === '__ws:subscribe');
    expect(subs).toHaveLength(1);
    expect(subs[0].channels.sort()).toEqual(['demo-plugin:change', 'maps:tile-update'].sort());
  });
});
