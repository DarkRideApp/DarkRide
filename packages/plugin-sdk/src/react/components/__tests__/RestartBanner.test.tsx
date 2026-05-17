import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { RestartBanner } from '../RestartBanner';
import { WebSocketContext } from '../../contexts/WebSocketContext';
import { AuthContext } from '../../contexts/AuthContext';
import { __resetRestartRequiredStore } from '../../hooks/useRestartRequired';

function makeWsContext(opts: any = {}) {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: opts.sendRestApi ?? (async () => ({ body: { success: true, restartRequired: { reason: 'plugin foo installed', since: 1 } } })),
    subscribe: opts.subscribe ?? (() => () => {}),
    subscribeBinary: vi.fn(),
    setOnApiError: vi.fn(),
  } as any;
}

function makeAuthContext(scopes: string[]) {
  return { hasScope: (s: string) => scopes.includes(s) } as any;
}

describe('RestartBanner', () => {
  beforeEach(() => __resetRestartRequiredStore());

  it('renders nothing when restart is not required', async () => {
    const ws = makeWsContext({
      sendRestApi: async () => ({ body: { success: true, restartRequired: null } }),
    });
    const { container } = render(
      <WebSocketContext.Provider value={ws}>
        <AuthContext.Provider value={makeAuthContext(['core.plugins:manage'])}>
          <RestartBanner />
        </AuthContext.Provider>
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders banner with reason when restart is required and user has scope', async () => {
    const ws = makeWsContext();
    render(
      <WebSocketContext.Provider value={ws}>
        <AuthContext.Provider value={makeAuthContext(['core.plugins:manage'])}>
          <RestartBanner />
        </AuthContext.Provider>
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText(/Server restart required/i)).toBeInTheDocument());
    expect(screen.getByText('plugin foo installed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /restart server/i })).toBeInTheDocument();
  });

  it('hides button and shows admin-message when user lacks scope', async () => {
    const ws = makeWsContext();
    render(
      <WebSocketContext.Provider value={ws}>
        <AuthContext.Provider value={makeAuthContext([])}>
          <RestartBanner />
        </AuthContext.Provider>
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText(/Server restart required/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /restart server/i })).toBeNull();
    expect(screen.getByText(/administrator needs to restart/i)).toBeInTheDocument();
  });

  it('clicking the button calls POST /v1/system/restart', async () => {
    const sendRestApi = vi.fn(async (method: string, path: string) => {
      if (method === 'GET') return { body: { success: true, restartRequired: { reason: 'r', since: 1 } } };
      return { body: { success: true } };
    });
    const ws = makeWsContext({ sendRestApi });
    render(
      <WebSocketContext.Provider value={ws}>
        <AuthContext.Provider value={makeAuthContext(['core.plugins:manage'])}>
          <RestartBanner />
        </AuthContext.Provider>
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /restart server/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /restart server/i }));
    await waitFor(() => expect(sendRestApi).toHaveBeenCalledWith('POST', '/v1/system/restart'));
  });
});
