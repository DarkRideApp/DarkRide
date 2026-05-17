import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminUsersPage } from './AdminUsersPage';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { AuthContext } from '@darkrideapp/plugin-sdk/react';
import type { AuthState } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';

// ── Mock data ────────────────────────────────────────────────────────────────

const humanOnly = [
  {
    id: 1,
    username: 'alice',
    displayName: 'Alice Smith',
    email: 'alice@example.com',
    providerId: 'local',
    scopes: ['core.admin:*'],
    kind: 'human' as const,
    serviceOwner: null,
    enabled: true,
    createdAt: '2025-01-01T00:00:00Z',
    lastLoginAt: null,
  },
];

const withServices = [
  ...humanOnly,
  {
    id: 2,
    username: 'plugin:demo-plugin:ai',
    displayName: null,
    email: null,
    providerId: 'service',
    scopes: ['mcp'],
    kind: 'plugin-service' as const,
    serviceOwner: 'demo-plugin',
    enabled: true,
    createdAt: '2025-01-02T00:00:00Z',
    lastLoginAt: null,
  },
  {
    id: 3,
    username: 'service:apk-analyzer:ai',
    displayName: null,
    email: null,
    providerId: 'service',
    scopes: ['core.apk:read'],
    kind: 'core-service' as const,
    serviceOwner: 'apk-analyzer',
    enabled: true,
    createdAt: '2025-01-03T00:00:00Z',
    lastLoginAt: null,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockWs(opts: { includeServices?: boolean } = {}): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path.includes('kind=all')) {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: withServices },
        });
      }
      if (method === 'GET' && path === '/v1/admin/users') {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: humanOnly },
        });
      }
      return Promise.resolve({
        type: 'restapi', id: '2', status: 200,
        body: { success: true },
      });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

const mockAuth: AuthState = {
  status: 'authenticated',
  user: { id: 99, username: 'admin', displayName: 'Admin', email: null, scopes: ['core.admin:*'], providerId: 'local' },
  csrfToken: null,
  hasScope: () => true,
  logout: vi.fn().mockResolvedValue(undefined),
  refreshAuth: vi.fn().mockResolvedValue(undefined),
};

function renderPage(ws?: WebSocketContextValue, auth: AuthState = mockAuth) {
  const mockWs = ws || createMockWs();
  return {
    ws: mockWs,
    ...render(
      <AuthContext.Provider value={auth}>
        <WebSocketContext.Provider value={mockWs}>
          <ToastProvider>
            <MemoryRouter>
              <AdminUsersPage />
            </MemoryRouter>
          </ToastProvider>
        </WebSocketContext.Provider>
      </AuthContext.Provider>,
    ),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AdminUsersPage — service account toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to hiding service accounts (calls /v1/admin/users without kind=all)', async () => {
    const { ws } = renderPage();
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());

    expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/admin/users');
    expect(ws.sendRestApi).not.toHaveBeenCalledWith('GET', expect.stringContaining('kind=all'));
    expect(screen.queryByText('plugin:demo-plugin:ai')).toBeNull();
  });

  it('toggle reveals service accounts with badges', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/show service accounts/i));
    await waitFor(() => expect(screen.getByText('plugin:demo-plugin:ai')).toBeInTheDocument());

    expect(screen.getByText('Plugin service')).toBeInTheDocument();
    expect(screen.getByText('Core service')).toBeInTheDocument();
  });

  it('re-fetches with kind=all when toggle is turned on', async () => {
    const { ws } = renderPage();
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/show service accounts/i));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/admin/users?kind=all');
    });
  });

  it('re-fetches without kind=all when toggle is turned back off', async () => {
    const { ws } = renderPage();
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());

    // Toggle on
    fireEvent.click(screen.getByLabelText(/show service accounts/i));
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/admin/users?kind=all'));

    vi.clearAllMocks();

    // Toggle off
    fireEvent.click(screen.getByLabelText(/show service accounts/i));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/admin/users');
    });
    expect(ws.sendRestApi).not.toHaveBeenCalledWith('GET', expect.stringContaining('kind=all'));
  });
});

describe('AdminUsersPage — service account protected actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderWithServices() {
    const result = renderPage();
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/show service accounts/i));
    await waitFor(() => expect(screen.getByText('plugin:demo-plugin:ai')).toBeInTheDocument());
    return result;
  }

  it('delete button is disabled with tooltip on plugin service account', async () => {
    await renderWithServices();
    const deleteBtn = screen.getByLabelText(/delete plugin:demo-plugin:ai/i);
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn.getAttribute('title')).toMatch(/uninstall.*demo-plugin/i);
  });

  it('delete button is disabled with tooltip on core service account', async () => {
    await renderWithServices();
    const deleteBtn = screen.getByLabelText(/delete service:apk-analyzer:ai/i);
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn.getAttribute('title')).toMatch(/managed in-code/i);
  });

  it('reset url button is disabled on plugin service account', async () => {
    await renderWithServices();
    const resetBtns = screen.getAllByLabelText(/reset url for/i);
    // Find the one for plugin:demo-plugin:ai
    const pluginResetBtn = resetBtns.find(b => b.getAttribute('aria-label')?.includes('plugin:demo-plugin:ai'));
    expect(pluginResetBtn).toBeDefined();
    expect(pluginResetBtn).toBeDisabled();
    expect(pluginResetBtn!.getAttribute('title')).toMatch(/uninstall.*demo-plugin/i);
  });

  it('revoke sessions button is disabled on plugin service account', async () => {
    await renderWithServices();
    const revokeBtns = screen.getAllByLabelText(/revoke sessions for/i);
    const pluginRevokeBtn = revokeBtns.find(b => b.getAttribute('aria-label')?.includes('plugin:demo-plugin:ai'));
    expect(pluginRevokeBtn).toBeDefined();
    expect(pluginRevokeBtn).toBeDisabled();
  });

  it('delete button is NOT disabled on human accounts', async () => {
    await renderWithServices();
    const deleteBtn = screen.getByLabelText(/delete alice/i);
    expect(deleteBtn).not.toBeDisabled();
  });

  it('reset url button is NOT disabled on human accounts', async () => {
    await renderWithServices();
    const resetBtn = screen.getByLabelText(/reset url for alice/i);
    expect(resetBtn).not.toBeDisabled();
  });
});

describe('AdminUsersPage — access control', () => {
  it('shows permission denied when user lacks core.users:admin scope', () => {
    const restrictedAuth: AuthState = {
      ...mockAuth,
      user: { ...mockAuth.user!, scopes: ['core.devices:read'] },
      hasScope: () => false,
    };
    renderPage(undefined, restrictedAuth);
    expect(screen.getByText(/you do not have permission/i)).toBeInTheDocument();
  });
});
