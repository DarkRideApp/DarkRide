import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { SettingsSidebar } from '../SettingsSidebar';

afterEach(cleanup);

function renderSidebar(scopes: string[], pending: number) {
  const ws: WebSocketContextValue = {
    connected: true, serverReady: true, startupMessage: '', sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { success: true, data: { pending: new Array(pending).fill({}) } } }),
    subscribe: vi.fn(() => () => {}),
    subscribeBinary: vi.fn(() => () => {}),
  };
  render(
    <MemoryRouter initialEntries={['/ui/settings/notifications']}>
      <AuthContext.Provider value={{ hasScope: (s: string) => scopes.includes(s) } as any}>
        <WebSocketContext.Provider value={ws}>
          <SettingsSidebar />
        </WebSocketContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return ws;
}

describe('SettingsSidebar ADB Proxy entry', () => {
  it('links to the ADB Proxy page', () => {
    renderSidebar([], 0);
    expect(screen.getByRole('link', { name: /ADB Proxy/ })).toHaveAttribute('href', '/ui/settings/adb-proxy');
  });

  it('shows the pending request count for users who can read the proxy', async () => {
    renderSidebar(['core.adb-proxy:read'], 2);
    expect(await screen.findByTestId('adb-proxy-pending-badge')).toHaveTextContent('2');
  });

  it('puts the count inside the ADB Proxy link', async () => {
    renderSidebar(['core.adb-proxy:read'], 3);
    const link = screen.getByRole('link', { name: /ADB Proxy/ });
    expect(await within(link).findByTestId('adb-proxy-pending-badge')).toHaveTextContent('3');
  });

  it('shows no badge at zero pending requests', async () => {
    const ws = renderSidebar(['core.adb-proxy:read'], 0);
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalled());
    expect(screen.queryByTestId('adb-proxy-pending-badge')).toBeNull();
  });

  it('does not contact the proxy API for users without the read scope', () => {
    const ws = renderSidebar([], 3);
    expect(ws.sendRestApi).not.toHaveBeenCalled();
    expect(screen.queryByTestId('adb-proxy-pending-badge')).toBeNull();
  });

  it('does not contact the proxy API for a manage-only user', () => {
    const ws = renderSidebar(['core.adb-proxy:manage'], 3);
    expect(ws.sendRestApi).not.toHaveBeenCalled();
    expect(screen.queryByTestId('adb-proxy-pending-badge')).toBeNull();
  });
});
