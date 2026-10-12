import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import type { StatusSnapshot } from '../../shared/types/adb-proxy';
import { useAdbProxyStatus } from './useAdbProxyStatus';

const SNAP = { enabled: true, devices: [], pending: [], keys: [], connections: [] } as unknown as StatusSnapshot;

function makeWs(body: unknown) {
  const handlers = new Map<string, (m: any) => void>();
  const unsubscribe = vi.fn();
  const ws: WebSocketContextValue = {
    connected: true, serverReady: true, startupMessage: '', sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body }),
    subscribe: vi.fn((type: string, cb: (m: any) => void) => { handlers.set(type, cb); return unsubscribe; }),
    subscribeBinary: vi.fn(() => () => {}),
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WebSocketContext.Provider value={ws}>{children}</WebSocketContext.Provider>
  );
  return { ws, handlers, unsubscribe, wrapper };
}

describe('useAdbProxyStatus', () => {
  it('loads the status and then follows pushed snapshots', async () => {
    const { handlers, wrapper } = makeWs({ success: true, data: SNAP });
    const { result } = renderHook(() => useAdbProxyStatus(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(SNAP));
    act(() => handlers.get('adb-proxy')!({ type: 'adb-proxy', enabled: false, devices: [], pending: [], keys: [], connections: [] }));
    expect(result.current.status?.enabled).toBe(false);
    expect((result.current.status as any).type).toBeUndefined();
  });

  it('reports an error when the request fails', async () => {
    const { wrapper } = makeWs({ success: false, error: 'Insufficient scope' });
    const { result } = renderHook(() => useAdbProxyStatus(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe('Insufficient scope'));
    expect(result.current.status).toBeNull();
  });

  describe('when the host re-renders with a new context object', () => {
    // The host builds a fresh context object on every render; only the functions in it are stable.
    function makeSwappableWs(connected: boolean) {
      const { ws, wrapper: _unused, ...rest } = makeWs({ success: true, data: SNAP });
      let current: WebSocketContextValue = { ...ws, connected };
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <WebSocketContext.Provider value={current}>{children}</WebSocketContext.Provider>
      );
      return { ws, ...rest, wrapper, swap: (patch: Partial<WebSocketContextValue>) => { current = { ...current, ...patch }; } };
    }

    it('does not fetch again or resubscribe when only the object identity changes', async () => {
      const { ws, unsubscribe, wrapper, swap } = makeSwappableWs(true);
      const { result, rerender } = renderHook(() => useAdbProxyStatus(), { wrapper });
      await waitFor(() => expect(result.current.status).not.toBeNull());
      expect(ws.sendRestApi).toHaveBeenCalledTimes(1);
      expect(ws.subscribe).toHaveBeenCalledTimes(1);

      swap({});
      rerender();
      swap({});
      rerender();
      await act(async () => {});

      expect(ws.sendRestApi).toHaveBeenCalledTimes(1);
      expect(ws.subscribe).toHaveBeenCalledTimes(1);
      expect(unsubscribe).not.toHaveBeenCalled();
    });

    it('fetches once more when the connection comes back', async () => {
      const { ws, wrapper, swap } = makeSwappableWs(false);
      const { result, rerender } = renderHook(() => useAdbProxyStatus(), { wrapper });
      await waitFor(() => expect(result.current.status).not.toBeNull());
      expect(ws.sendRestApi).toHaveBeenCalledTimes(1);

      swap({ connected: true });
      rerender();
      await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(ws.sendRestApi).toHaveBeenCalledTimes(2);
    });
  });

  it('unsubscribes on unmount', async () => {
    const { unsubscribe, wrapper } = makeWs({ success: true, data: SNAP });
    const { unmount, result } = renderHook(() => useAdbProxyStatus(), { wrapper });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
