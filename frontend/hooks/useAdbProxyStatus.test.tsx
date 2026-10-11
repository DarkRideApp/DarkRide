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

  it('unsubscribes on unmount', async () => {
    const { unsubscribe, wrapper } = makeWs({ success: true, data: SNAP });
    const { unmount, result } = renderHook(() => useAdbProxyStatus(), { wrapper });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
