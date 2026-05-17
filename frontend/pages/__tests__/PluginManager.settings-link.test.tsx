import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PluginManager } from '../PluginManager';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';
import { pluginRegistry, __resetPluginRegistry } from '@darkrideapp/plugin-sdk/react';

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockScopeStatus = {
  success: true,
  state: 'no-scopes',
  manifestScopes: [],
  approvedScopes: null,
  added: [],
  removed: [],
};

function createMockWs(plugins: object[]): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === '/v1/plugins/installed') {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { plugins, darkrideVersion: '1.0.0' } },
        });
      }
      if (method === 'GET' && path.includes('/scope-status')) {
        return Promise.resolve({
          type: 'restapi', id: 'ss', status: 200,
          body: mockScopeStatus,
        });
      }
      return Promise.resolve({
        type: 'restapi', id: 'x', status: 200,
        body: { success: true },
      });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderPluginManager(ws: WebSocketContextValue) {
  return render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <MemoryRouter>
          <PluginManager />
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PluginManager — Settings link per row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPluginRegistry();
  });

  it('shows Settings link for plugins that registered settings', async () => {
    const FakeSettings = () => <div>Settings</div>;
    pluginRegistry.registerSettings('demo-plugin', {
      label: 'GitHub Monitor',
      component: FakeSettings,
    });

    const ws = createMockWs([
      {
        name: 'demo-plugin',
        version: '1.0.0',
        description: 'Monitors GitHub repos',
        author: 'DarkRide',
        enabled: true,
        installedVia: 'npm',
        loaded: true,
      },
    ]);
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('demo-plugin')).toBeInTheDocument();
    });

    const pluginSettingsLink = screen
      .getAllByRole('link', { name: 'Settings' })
      .find(el => el.getAttribute('href') === '/ui/settings/plugins/demo-plugin/settings');
    expect(pluginSettingsLink).toBeTruthy();
  });

  it('does not show Settings link for plugins that did not register settings', async () => {
    // No call to pluginRegistry.registerSettings — no registration

    const ws = createMockWs([
      {
        name: 'plugin-maps',
        version: '1.2.0',
        description: 'Map overlay plugin',
        author: 'DarkRide',
        enabled: true,
        installedVia: 'npm',
        loaded: true,
      },
    ]);
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('plugin-maps')).toBeInTheDocument();
    });

    const pluginSettingsLink = screen
      .queryAllByRole('link', { name: 'Settings' })
      .find(el => el.getAttribute('href')?.includes('/plugins/'));
    expect(pluginSettingsLink).toBeUndefined();
  });
});
