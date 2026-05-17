import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { WebSocketContext } from '../../contexts/WebSocketContext';
import type { WebSocketContextValue } from '../../contexts/WebSocketContext';
import { useWebSocket } from '../useWebSocket';
import { createWebSocketManager } from '../useWebSocketManager';

// Shared mock WebSocket state — used by all manager tests
let originalWebSocket: typeof WebSocket;
let mockInstances: any[];

beforeEach(() => {
  mockInstances = [];
  originalWebSocket = global.WebSocket;

  (global as any).WebSocket = class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

    readyState = 0;
    binaryType = '';
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((evt: any) => void) | null = null;
    onerror: (() => void) | null = null;
    url: string;

    constructor(url: string) {
      this.url = url;
      mockInstances.push(this);
    }

    send = vi.fn();
    close = vi.fn();

    simulateOpen() {
      this.readyState = 1;
      this.onopen?.();
    }

    simulateMessage(data: any) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }

    simulateBinary(buf: ArrayBuffer) {
      this.onmessage?.({ data: buf });
    }

    simulateClose() {
      this.readyState = 3;
      this.onclose?.();
    }
  };
});

afterEach(() => {
  global.WebSocket = originalWebSocket;
});

describe('useWebSocket hook', () => {
  it('throws when used outside provider', () => {
    // Suppress console.error for expected error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      renderHook(() => useWebSocket());
    }).toThrow('useWebSocket must be used within a WebSocketProvider');
    spy.mockRestore();
  });

  it('returns context value when inside provider', () => {
    const mockValue: WebSocketContextValue = {
      connected: true,
      serverReady: false,
      startupMessage: 'Connecting...',
      sendMessage: vi.fn(),
      sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: {} }),
      subscribe: vi.fn().mockReturnValue(() => {}),
      subscribeBinary: vi.fn().mockReturnValue(() => {}),
    };

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WebSocketContext.Provider value={mockValue}>{children}</WebSocketContext.Provider>
    );

    const { result } = renderHook(() => useWebSocket(), { wrapper });
    expect(result.current.connected).toBe(true);
    expect(result.current.sendMessage).toBe(mockValue.sendMessage);
    expect(result.current.sendRestApi).toBe(mockValue.sendRestApi);
    expect(result.current.subscribe).toBe(mockValue.subscribe);
  });
});

describe('createWebSocketManager', () => {
  it('creates a manager with correct methods', () => {
    const mgr = createWebSocketManager();
    expect(mgr.connect).toBeDefined();
    expect(mgr.disconnect).toBeDefined();
    expect(mgr.sendMessage).toBeDefined();
    expect(mgr.sendRestApi).toBeDefined();
    expect(mgr.subscribe).toBeDefined();
    expect(mgr.isConnected()).toBe(false);
  });

  it('connects and reports connected state', () => {
    const mgr = createWebSocketManager();
    const cb = vi.fn();
    mgr.onConnectionChange(cb);
    mgr.connect();

    expect(mockInstances.length).toBe(1);
    mockInstances[0].simulateOpen();
    expect(cb).toHaveBeenCalledWith(true);
    expect(mgr.isConnected()).toBe(true);
  });

  it('sends messages when connected', () => {
    const mgr = createWebSocketManager();
    mgr.connect();
    mockInstances[0].simulateOpen();

    mgr.sendMessage('test-action', { foo: 'bar' });
    expect(mockInstances[0].send).toHaveBeenCalledWith(
      JSON.stringify({ action: 'test-action', foo: 'bar' })
    );
  });

  it('dispatches messages to subscribers', () => {
    const mgr = createWebSocketManager();
    mgr.connect();
    mockInstances[0].simulateOpen();

    const handler = vi.fn();
    mgr.subscribe('livelog', handler);

    mockInstances[0].simulateMessage({ type: 'livelog', system: 'test', message: 'hello' });
    expect(handler).toHaveBeenCalledWith({ type: 'livelog', system: 'test', message: 'hello' });
  });

  it('resolves REST API responses by id', async () => {
    const mgr = createWebSocketManager();
    mgr.connect();
    mockInstances[0].simulateOpen();

    // Mock crypto.randomUUID using vi.spyOn
    const mockUUID = 'test-uuid-123';
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(mockUUID as `${string}-${string}-${string}-${string}-${string}`);

    const promise = mgr.sendRestApi('GET', '/v1/test');

    // Verify sent message
    expect(mockInstances[0].send).toHaveBeenCalledWith(
      JSON.stringify({ action: 'restapi', method: 'GET', path: '/v1/test', body: undefined, id: mockUUID })
    );

    // Simulate response
    mockInstances[0].simulateMessage({ type: 'restapi', id: mockUUID, status: 200, body: { data: 'hello' } });

    const result = await promise;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: 'hello' });

    vi.restoreAllMocks();
  });

  it('unsubscribes correctly', () => {
    const mgr = createWebSocketManager();
    mgr.connect();
    mockInstances[0].simulateOpen();

    const handler = vi.fn();
    const unsub = mgr.subscribe('livelog', handler);

    mockInstances[0].simulateMessage({ type: 'livelog', message: 'first' });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    mockInstances[0].simulateMessage({ type: 'livelog', message: 'second' });
    expect(handler).toHaveBeenCalledTimes(1); // Still 1
  });

  it('disconnect cleans up', () => {
    const mgr = createWebSocketManager();
    mgr.connect();
    mockInstances[0].simulateOpen();
    expect(mgr.isConnected()).toBe(true);

    mgr.disconnect();
    expect(mockInstances[0].close).toHaveBeenCalled();
    expect(mgr.isConnected()).toBe(false);
  });

  // ── auto-toast policy ──────────────────────────────────────────────────────
  //
  // Settings pages and other consumers commonly poll keys that may be unset
  // (e.g. GET /v1/settings/mcp_enabled on a fresh install). The backend
  // returns 404 + {success: false, error: 'Setting not found'} for absent
  // keys, which is correct REST semantics. The auto-toast hook used to fire
  // on every {success: false} response, so loading /ui/settings/mcp flashed
  // a spurious "Setting not found" toast.
  //
  // Policy: 404s mean "this resource doesn't exist". The caller already
  // knows where it asked from and is expected to handle absence inline
  // (default values, empty states, "not found" pages). Other failure
  // statuses (400/403/422/5xx) still toast.
  describe('onApiError auto-toast policy', () => {
    it('does NOT fire onApiError for 404 + success:false responses', () => {
      const mgr = createWebSocketManager();
      const handler = vi.fn();
      mgr.setOnApiError(handler);
      mgr.connect();
      mockInstances[0].simulateOpen();

      mockInstances[0].simulateMessage({
        type: 'restapi',
        id: 'req-1',
        status: 404,
        body: { success: false, error: 'Setting not found' },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('fires onApiError for 500-class server errors', () => {
      const mgr = createWebSocketManager();
      const handler = vi.fn();
      mgr.setOnApiError(handler);
      mgr.connect();
      mockInstances[0].simulateOpen();

      mockInstances[0].simulateMessage({
        type: 'restapi',
        id: 'req-2',
        status: 500,
        body: { success: false, error: 'Database is on fire' },
      });

      expect(handler).toHaveBeenCalledWith('Database is on fire');
    });

    it('fires onApiError for 400/422-class client input errors', () => {
      const mgr = createWebSocketManager();
      const handler = vi.fn();
      mgr.setOnApiError(handler);
      mgr.connect();
      mockInstances[0].simulateOpen();

      mockInstances[0].simulateMessage({
        type: 'restapi',
        id: 'req-3',
        status: 400,
        body: { success: false, error: 'Unknown setting key: foo' },
      });

      expect(handler).toHaveBeenCalledWith('Unknown setting key: foo');
    });

    it('fires onApiError for 403 insufficient-scope responses', () => {
      const mgr = createWebSocketManager();
      const handler = vi.fn();
      mgr.setOnApiError(handler);
      mgr.connect();
      mockInstances[0].simulateOpen();

      mockInstances[0].simulateMessage({
        type: 'restapi',
        id: 'req-4',
        status: 403,
        body: { success: false, error: 'Insufficient scope' },
      });

      expect(handler).toHaveBeenCalledWith('Insufficient scope');
    });

    it('does not fire onApiError for success:true responses regardless of status', () => {
      const mgr = createWebSocketManager();
      const handler = vi.fn();
      mgr.setOnApiError(handler);
      mgr.connect();
      mockInstances[0].simulateOpen();

      mockInstances[0].simulateMessage({
        type: 'restapi',
        id: 'req-5',
        status: 200,
        body: { success: true, data: 'whatever' },
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe('binary message handling', () => {
  it('sets binaryType=arraybuffer on the underlying WebSocket', () => {
    const mgr = createWebSocketManager();
    mgr.connect();
    expect((mockInstances[0] as any).binaryType).toBe('arraybuffer');
  });

  it('dispatches ArrayBuffer messages to subscribeBinary listeners', () => {
    const mgr = createWebSocketManager();
    mgr.connect();
    mockInstances[0].simulateOpen();

    const received: ArrayBuffer[] = [];
    mgr.subscribeBinary((data: ArrayBuffer) => { received.push(data); });

    const buf = new Uint8Array([0x01, 0x02, 0x03]).buffer;
    mockInstances[0].simulateBinary(buf);

    expect(received).toHaveLength(1);
    expect(new Uint8Array(received[0])).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
  });

  it('does not invoke JSON listeners for binary messages', () => {
    const mgr = createWebSocketManager();
    mgr.connect();
    mockInstances[0].simulateOpen();

    const jsonHandler = vi.fn();
    mgr.subscribe('livelog', jsonHandler);

    const buf = new Uint8Array([0x01]).buffer;
    mockInstances[0].simulateBinary(buf);

    expect(jsonHandler).not.toHaveBeenCalled();
  });

  it('subscribeBinary returns an unsubscribe function', () => {
    const mgr = createWebSocketManager();
    mgr.connect();
    mockInstances[0].simulateOpen();

    const handler = vi.fn();
    const unsub = mgr.subscribeBinary(handler);

    mockInstances[0].simulateBinary(new ArrayBuffer(4));
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    mockInstances[0].simulateBinary(new ArrayBuffer(4));
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });
});
