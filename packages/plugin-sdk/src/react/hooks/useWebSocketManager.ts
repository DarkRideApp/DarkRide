// packages/plugin-sdk/src/react/hooks/useWebSocketManager.ts
//
// ClientMessage and ServerMessage are inlined here to avoid cross-package
// type plumbing. Source of truth remains shared/types/websocket.ts in the
// host; these mirror its shape. Future work could promote these to a
// dedicated /types subpath once the SDK exposes one.

import { useRef, useEffect, useCallback, useState } from 'react';
import type { RestApiResponse } from '../contexts/WebSocketContext';

// ---------------------------------------------------------------------------
// Inlined client-side message types (mirrored from shared/types/websocket.ts)
// ---------------------------------------------------------------------------

interface RestApiRequest {
  action: 'restapi';
  method: string;
  path: string;
  body?: any;
  id: string;
}

interface WebSocketRequest {
  action: string;
  [key: string]: any;
}

// ClientMessage is a union of all client → server message shapes.
// We type it loosely here; the manager only needs to JSON-serialize it.
type ClientMessage = RestApiRequest | WebSocketRequest;

// ServerMessage is a union of all server → client message shapes.
// The manager only reads .type from it, so we type it structurally.
interface ServerMessageBase {
  type: string;
  [key: string]: any;
}
type ServerMessage = ServerMessageBase;

// ---------------------------------------------------------------------------
// Manager factory
// ---------------------------------------------------------------------------

export function createWebSocketManager() {
  let onApiError: ((message: string) => void) | null = null;

  let ws: WebSocket | null = null;
  let connected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const MAX_RECONNECT_DELAY = 30000;
  const BASE_RECONNECT_DELAY = 1000;

  let serverReady = false;
  let startupMessage = 'Connecting...';

  const binaryListeners = new Set<(data: ArrayBuffer) => void>();
  const listeners = new Map<string, Set<(msg: any) => void>>();
  const channelRefcounts = new Map<string, number>();

  function sendControlMessage(action: string, channels: string[]): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action, channels }));
  }
  const pendingRequests = new Map<string, {
    resolve: (value: RestApiResponse) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  const startupListeners = new Set<(ready: boolean, message: string) => void>();

  function getWsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      ws = new WebSocket(getWsUrl());
    } catch {
      scheduleReconnect();
      return;
    }

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      connected = true;
      reconnectAttempt = 0;
      connectionListeners.forEach(cb => cb(true));
      // Re-send all active channel subscriptions in a single batch. Backend
      // handler is idempotent on the per-client subscription set.
      const active = Array.from(channelRefcounts.keys()).filter((k) => k !== '*');
      if (active.length > 0) {
        sendControlMessage('__ws:subscribe', active);
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        binaryListeners.forEach(cb => cb(event.data as ArrayBuffer));
        return;
      }

      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      // Handle startup progress
      if (msg.type === 'startup-progress') {
        serverReady = msg.phase === 'ready';
        startupMessage = msg.message;
        startupListeners.forEach(cb => cb(serverReady, startupMessage));
        if (!serverReady) return; // Don't dispatch to other subscribers during startup
      }

      // Handle REST API responses
      if (msg.type === 'restapi') {
        const resp = msg as RestApiResponse;
        const pending = pendingRequests.get(resp.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(resp.id);
          pending.resolve(resp);
        }
        // Auto-toast policy for failed API calls. 404 means "this resource
        // doesn't exist" — settings keys often unset, sessions/plugins/etc.
        // that may have been deleted. The caller knows what it asked for and
        // is expected to render an inline empty/not-found state, so a global
        // toast is just noise. Other failure statuses (400/403/422/5xx) still
        // toast because they almost always indicate a problem the user needs
        // to see (bad input, missing scope, server error). Status is always
        // logged either way.
        if (resp.body && resp.body.success === false && resp.body.error) {
          console.error('[API Error]', resp.status, resp.body.error);
          if (resp.status !== 404) {
            onApiError?.(resp.body.error);
          }
        }
        return;
      }

      // Dispatch to subscribers
      const typeListeners = listeners.get(msg.type);
      if (typeListeners) {
        typeListeners.forEach(cb => cb(msg));
      }
      // Also dispatch to wildcard subscribers
      const wildcardListeners = listeners.get('*');
      if (wildcardListeners) {
        wildcardListeners.forEach(cb => cb(msg));
      }
    };

    ws.onclose = () => {
      connected = false;
      serverReady = false;
      startupMessage = 'Connecting...';
      connectionListeners.forEach(cb => cb(false));
      startupListeners.forEach(cb => cb(false, startupMessage));
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function sendMessage(action: string, data?: Record<string, any>) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: ClientMessage = { action, ...data } as any;
    ws.send(JSON.stringify(msg));
  }

  function sendRestApi(method: string, path: string, body?: any): Promise<RestApiResponse> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, 30000);

      pendingRequests.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ action: 'restapi', method, path, body, id }));
    });
  }

  function subscribe(type: string, callback: (msg: any) => void): () => void {
    if (!listeners.has(type)) {
      listeners.set(type, new Set());
    }
    listeners.get(type)!.add(callback);

    const cur = channelRefcounts.get(type) ?? 0;
    channelRefcounts.set(type, cur + 1);
    if (cur === 0 && type !== '*') {
      sendControlMessage('__ws:subscribe', [type]);
    }

    return () => {
      listeners.get(type)?.delete(callback);
      const next = (channelRefcounts.get(type) ?? 1) - 1;
      if (next <= 0) {
        channelRefcounts.delete(type);
        if (type !== '*') sendControlMessage('__ws:unsubscribe', [type]);
      } else {
        channelRefcounts.set(type, next);
      }
    };
  }

  function subscribeBinary(callback: (data: ArrayBuffer) => void): () => void {
    binaryListeners.add(callback);
    return () => { binaryListeners.delete(callback); };
  }

  function onConnectionChange(callback: (connected: boolean) => void): () => void {
    connectionListeners.add(callback);
    return () => { connectionListeners.delete(callback); };
  }

  function onStartupChange(callback: (ready: boolean, message: string) => void): () => void {
    startupListeners.add(callback);
    return () => { startupListeners.delete(callback); };
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    connected = false;
    pendingRequests.forEach(p => {
      clearTimeout(p.timer);
      p.reject(new Error('Disconnected'));
    });
    pendingRequests.clear();
  }

  return {
    connect,
    disconnect,
    sendMessage,
    sendRestApi,
    subscribe,
    subscribeBinary,
    onConnectionChange,
    onStartupChange,
    isConnected: () => connected,
    isServerReady: () => serverReady,
    getStartupMessage: () => startupMessage,
    setOnApiError: (cb: ((message: string) => void) | null) => { onApiError = cb; },
  };
}

/** React hook to use the WS manager in a component that creates the provider */
export function useWebSocketManager() {
  const managerRef = useRef(createWebSocketManager());
  const [connected, setConnected] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [startupMessage, setStartupMessage] = useState('Connecting...');

  useEffect(() => {
    const mgr = managerRef.current;
    mgr.connect();
    const unsubConn = mgr.onConnectionChange(setConnected);
    const unsubStartup = mgr.onStartupChange((ready, msg) => {
      setServerReady(ready);
      setStartupMessage(msg);
    });
    return () => {
      unsubConn();
      unsubStartup();
      mgr.disconnect();
    };
  }, []);

  const sendMessage = useCallback((action: string, data?: Record<string, any>) => {
    managerRef.current.sendMessage(action, data);
  }, []);

  const sendRestApi = useCallback((method: string, path: string, body?: any) => {
    return managerRef.current.sendRestApi(method, path, body);
  }, []);

  const subscribe = useCallback((type: string, callback: (msg: any) => void) => {
    return managerRef.current.subscribe(type, callback);
  }, []);

  const subscribeBinary = useCallback((cb: (data: ArrayBuffer) => void) => {
    return managerRef.current.subscribeBinary(cb);
  }, []);

  const setOnApiError = useCallback((cb: ((message: string) => void) | null) => {
    managerRef.current.setOnApiError(cb);
  }, []);

  return { connected, serverReady, startupMessage, sendMessage, sendRestApi, subscribe, subscribeBinary, setOnApiError };
}
