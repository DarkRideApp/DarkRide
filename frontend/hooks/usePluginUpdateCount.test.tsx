import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { AuthContext, WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { usePluginUpdateCount } from './usePluginUpdateCount';

const PLUGINS = [{ updateAvailable: true }, { updateAvailable: false }, { updateAvailable: true }];

function setup(scopes: string[] | null) {
  const sendRestApi = vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { success: true, data: { plugins: PLUGINS } } });
  const ws = { connected: true, sendRestApi, sendMessage: vi.fn(), subscribe: vi.fn(() => () => {}) } as unknown as WebSocketContextValue;
  const auth = scopes ? ({ hasScope: (s: string) => scopes.includes(s) } as any) : null;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AuthContext.Provider value={auth}>
      <WebSocketContext.Provider value={ws}>{children}</WebSocketContext.Provider>
    </AuthContext.Provider>
  );
  return { sendRestApi, wrapper };
}

describe('usePluginUpdateCount', () => {
  it('counts the installed plugins that have an update', async () => {
    const { sendRestApi, wrapper } = setup(['core.plugins:manage']);
    const { result } = renderHook(() => usePluginUpdateCount(), { wrapper });
    await waitFor(() => expect(result.current).toBe(2));
    expect(sendRestApi).toHaveBeenCalledWith('GET', '/v1/plugins/installed');
  });

  it('does not call the API for a user without core.plugins:manage, so no scope error toast appears', async () => {
    const { sendRestApi, wrapper } = setup(['core.devices:read']);
    const { result } = renderHook(() => usePluginUpdateCount(), { wrapper });
    await Promise.resolve();
    expect(sendRestApi).not.toHaveBeenCalled();
    expect(result.current).toBe(0);
  });

  it('still counts when there is no auth context', async () => {
    const { sendRestApi, wrapper } = setup(null);
    const { result } = renderHook(() => usePluginUpdateCount(), { wrapper });
    await waitFor(() => expect(result.current).toBe(2));
    expect(sendRestApi).toHaveBeenCalledTimes(1);
  });
});
