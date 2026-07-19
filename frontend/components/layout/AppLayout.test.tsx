import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { AuthContext } from '@darkrideapp/plugin-sdk/react';
import type { AuthState } from '@darkrideapp/plugin-sdk/react';

const mockWs: WebSocketContextValue = {
  connected: true,
  serverReady: true,
  startupMessage: 'Server ready',
  sendMessage: vi.fn(),
  sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { data: [] } }),
  subscribe: vi.fn().mockReturnValue(() => {}),
  subscribeBinary: vi.fn().mockReturnValue(() => {}),
};

const mockAuth: AuthState = {
  status: 'authenticated',
  user: { id: 1, username: 'testuser', displayName: 'Test User', email: null, scopes: [], providerId: 'local' },
  csrfToken: null,
  hasScope: () => false,
  logout: vi.fn().mockResolvedValue(undefined),
  refreshAuth: vi.fn().mockResolvedValue(undefined),
};

function renderWithRouter(initialEntry = '/ui/', { auth }: { auth?: AuthState | null } = {}) {
  const tree = (
    <WebSocketContext.Provider value={mockWs}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AppLayout />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );
  if (auth !== undefined && auth !== null) {
    return render(
      <AuthContext.Provider value={auth}>
        {tree}
      </AuthContext.Provider>
    );
  }
  return render(tree);
}

describe('AppLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders sidebar with navigation links', () => {
    renderWithRouter();
    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar).toBeInTheDocument();

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Devices')).toBeInTheDocument();
    expect(screen.getByText('Automations')).toBeInTheDocument();
    // "Network" is both the nav group label and the unified workspace item.
    expect(screen.getAllByText('Network').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Network' })).toHaveAttribute('href', '/ui/network');
    expect(screen.getByText('Selector Debugger')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders DarkRide branding', () => {
    renderWithRouter();
    const brandingElements = screen.getAllByText('DarkRide');
    expect(brandingElements.length).toBeGreaterThanOrEqual(1);
  });

  it('highlights active route', () => {
    renderWithRouter('/ui/');
    const dashboardLink = screen.getByText('Dashboard').closest('a');
    expect(dashboardLink).toHaveClass('active');
  });

  it('can collapse sidebar', () => {
    renderWithRouter();
    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar).not.toHaveClass('collapsed');

    const toggleBtn = screen.getByLabelText('Toggle sidebar');
    fireEvent.click(toggleBtn);
    expect(sidebar).toHaveClass('collapsed');

    fireEvent.click(toggleBtn);
    expect(sidebar).not.toHaveClass('collapsed');
  });

  it('renders live log toggle', () => {
    renderWithRouter();
    expect(screen.getByTestId('live-log-toggle')).toBeInTheDocument();
  });

  it('renders theme toggle button', () => {
    renderWithRouter();
    const themeBtn = screen.getByLabelText(/Switch to (light|dark) theme/);
    expect(themeBtn).toBeInTheDocument();
  });

  it('renders profile link when authenticated', () => {
    renderWithRouter('/ui/', { auth: mockAuth });
    const profileLink = screen.getByLabelText('My profile');
    expect(profileLink).toBeInTheDocument();
    expect(profileLink).toHaveAttribute('href', '/ui/profile');
  });

  it('renders logout button when authenticated', () => {
    renderWithRouter('/ui/', { auth: mockAuth });
    const logoutBtn = screen.getByLabelText(/Sign out/);
    expect(logoutBtn).toBeInTheDocument();
  });

  // ── Session timeline nav highlight ─────────────────────────────────────────
  //
  // The session timeline route lives at /ui/automations/session/:id (under the
  // Automations prefix for historical reasons). By default that made the
  // "Automations" nav highlight when a user opened a recorded session, which
  // is wrong — they're viewing a session, not an automation. The fix is in
  // AppLayout: when the path is /ui/automations/session/*, treat it as the
  // Sessions nav, not Automations.
  describe('Sessions vs Automations nav highlight on session timeline', () => {
    const authWithAutomations: AuthState = {
      ...mockAuth,
      hasScope: (s: string) => s === 'core.automations:read',
    };

    it('highlights Sessions (not Automations) when viewing a session timeline', () => {
      renderWithRouter('/ui/automations/session/42', { auth: authWithAutomations });
      const sessionsLink = screen.getByText('Sessions').closest('a');
      const automationsLink = screen.getByText('Automations').closest('a');
      expect(sessionsLink).toHaveClass('active');
      expect(automationsLink).not.toHaveClass('active');
    });

    it('still highlights Automations on a regular automation page', () => {
      renderWithRouter('/ui/automations', { auth: authWithAutomations });
      const automationsLink = screen.getByText('Automations').closest('a');
      const sessionsLink = screen.getByText('Sessions').closest('a');
      expect(automationsLink).toHaveClass('active');
      expect(sessionsLink).not.toHaveClass('active');
    });

    it('highlights Automations on automation edit pages', () => {
      renderWithRouter('/ui/automations/42/edit', { auth: authWithAutomations });
      const automationsLink = screen.getByText('Automations').closest('a');
      expect(automationsLink).toHaveClass('active');
    });
  });
});
