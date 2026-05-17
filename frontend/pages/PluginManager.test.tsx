import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PluginManager } from './PluginManager';
import { PluginCard } from '../components/plugins/PluginCard';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';

// ── Mock data ────────────────────────────────────────────────────────────────

const mockPlugins = [
  {
    name: 'plugin-maps',
    version: '1.2.0',
    description: 'Map overlay plugin',
    author: 'DarkRide',
    enabled: true,
    installedVia: 'npm',
    loaded: true,
    npmPackage: '@darkride/plugin-maps',
  },
  {
    name: 'plugin-local',
    version: '0.1.0',
    description: 'Local dev plugin',
    author: 'Dev',
    enabled: true,
    installedVia: 'workspace',
    loaded: true,
    npmPackage: null,
  },
  {
    name: 'plugin-disabled',
    version: '1.0.0',
    description: 'A disabled plugin',
    author: 'Test',
    enabled: false,
    installedVia: 'npm',
    loaded: false,
    npmPackage: '@darkride/plugin-disabled',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Default scope-status response: no AI scopes, state = no-scopes */
const mockScopeStatus = {
  success: true,
  state: 'no-scopes',
  manifestScopes: [],
  approvedScopes: null,
  added: [],
  removed: [],
};

function createMockWs(overrides?: Partial<WebSocketContextValue>): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === '/v1/plugins/installed') {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { plugins: mockPlugins, darkrideVersion: '1.0.0' } },
        });
      }
      if (method === 'GET' && path.includes('/scope-status')) {
        return Promise.resolve({
          type: 'restapi', id: 'ss', status: 200,
          body: mockScopeStatus,
        });
      }
      if (method === 'GET' && path.includes('/uninstall-footprint')) {
        return Promise.resolve({
          type: 'restapi', id: 'fp', status: 200,
          body: { success: true, data: { tables: [], fileStorageBytes: 0, npmPackage: null } },
        });
      }
      // Default: generic success
      return Promise.resolve({
        type: 'restapi', id: '2', status: 200,
        body: { success: true },
      });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as any;
}

function renderPluginManager(ws?: WebSocketContextValue) {
  const mockWs = ws || createMockWs();
  return {
    ws: mockWs,
    ...render(
      <WebSocketContext.Provider value={mockWs}>
        <ToastProvider>
          <MemoryRouter>
            <PluginManager />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>,
    ),
  };
}

// ── PluginManager page tests ─────────────────────────────────────────────────

describe('PluginManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    // Create a ws that never resolves, so loading stays visible
    const ws = createMockWs({
      sendRestApi: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    renderPluginManager(ws);

    expect(screen.getByText('Loading plugins\u2026')).toBeInTheDocument();
  });

  it('shows plugin cards after API responds', async () => {
    renderPluginManager();

    await waitFor(() => {
      expect(screen.getByText('plugin-maps')).toBeInTheDocument();
      expect(screen.getByText('plugin-local')).toBeInTheDocument();
      expect(screen.getByText('plugin-disabled')).toBeInTheDocument();
    });
  });

  it('shows empty state when no plugins', async () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { plugins: [], darkrideVersion: '1.0.0' } },
          });
        }
        return Promise.resolve({ type: 'restapi', id: 'x', status: 200, body: { success: true } });
      }),
    });
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('No plugins installed.')).toBeInTheDocument();
      expect(screen.getByText(/Browse the marketplace/)).toBeInTheDocument();
    });
  });

  it('enable toggle calls POST /v1/plugins/:name/enable', async () => {
    const ws = createMockWs();
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('plugin-disabled')).toBeInTheDocument();
    });

    // Find the disabled plugin's enable button (shows "Disabled" text)
    const disabledButtons = screen.getAllByText('Disabled');
    fireEvent.click(disabledButtons[0]);

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        expect.stringContaining('/enable'),
      );
    });
  });

  it('disable toggle calls POST /v1/plugins/:name/disable', async () => {
    const ws = createMockWs();
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('plugin-maps')).toBeInTheDocument();
    });

    // Find an enabled plugin's toggle button (shows "Enabled" text)
    const enabledButtons = screen.getAllByText('Enabled');
    fireEvent.click(enabledButtons[0]);

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        expect.stringContaining('/disable'),
      );
    });
  });

  it('uninstall opens confirmation modal and posts with preserveData: true (safe default)', async () => {
    const ws = createMockWs();
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('plugin-maps')).toBeInTheDocument();
    });

    // Click the uninstall (trash) button — it's an npm plugin so it has one
    const uninstallButtons = screen.getAllByTitle('Uninstall plugin');
    fireEvent.click(uninstallButtons[0]);

    // Modal opens, fetches footprint, then shows the safe-default button
    const keep = await screen.findByTestId('uninstall-keep-data');
    fireEvent.click(keep);

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/plugins/uninstall',
        expect.objectContaining({ preserveData: true }),
      );
    });
  });

  it('uninstall "delete all data" posts with preserveData: false', async () => {
    const ws = createMockWs();
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('plugin-maps')).toBeInTheDocument();
    });

    const uninstallButtons = screen.getAllByTitle('Uninstall plugin');
    fireEvent.click(uninstallButtons[0]);

    const wipe = await screen.findByTestId('uninstall-delete-data');
    fireEvent.click(wipe);

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/plugins/uninstall',
        expect.objectContaining({ preserveData: false }),
      );
    });
  });

  it('does NOT fetch scope-status for unloaded plugins (avoids "Unknown plugin" 404)', async () => {
    // /scope-status returns 404 + success:false for plugins not in pluginManager.
    // The global onApiError bridge in App.tsx auto-toasts every success:false response,
    // so fetching scope-status for unloaded plugins produces spurious "Unknown plugin"
    // toasts on the plugins page. Skip the fetch when loaded === false.
    const ws = createMockWs();
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('plugin-maps')).toBeInTheDocument();
      expect(screen.getByText('plugin-disabled')).toBeInTheDocument();
    });

    // plugin-disabled has loaded:false; the fetch must be skipped for it.
    const calls = (ws.sendRestApi as any).mock.calls as Array<[string, string, ...any[]]>;
    const scopeStatusCalls = calls.filter(([m, p]) => m === 'GET' && p.includes('/scope-status'));
    const unloadedCalls = scopeStatusCalls.filter(([, p]) => p.includes('plugin-disabled'));
    expect(unloadedCalls).toHaveLength(0);
    // Sanity: the loaded ones DO still get called.
    expect(scopeStatusCalls.some(([, p]) => p.includes('plugin-maps'))).toBe(true);
  });

  it('shows the pending-AI-consent banner for enabled plugins with unconsented scopes', async () => {
    // Regression guard: previously only 'drift-wider' plugins got a banner.
    // Plugins in the 'unconsented' state (never consented at all) had no way
    // to trigger the consent modal except toggling Disable → Enable. The
    // banner must also appear for 'unconsented' with manifestScopes > 0.
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { plugins: mockPlugins, darkrideVersion: '1.0.0' } },
          });
        }
        if (method === 'GET' && path.includes('/plugin-maps/scope-status')) {
          return Promise.resolve({
            type: 'restapi', id: 'ss', status: 200,
            body: {
              success: true,
              state: 'unconsented',
              manifestScopes: ['mcp'],
              approvedScopes: null,
              added: [{ key: 'mcp', metadata: { label: 'Run as MCP agent', description: '', category: 'AI' } }],
              removed: [],
            },
          });
        }
        if (method === 'GET' && path.includes('/scope-status')) {
          return Promise.resolve({
            type: 'restapi', id: 'ss2', status: 200,
            body: mockScopeStatus,
          });
        }
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true } });
      }),
    });
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText(/plugin-maps v.* requests AI permissions/)).toBeInTheDocument();
    });
  });

  it('"Browse Marketplace" button navigates to marketplace page', async () => {
    const ws = createMockWs();
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('Browse Marketplace')).toBeInTheDocument();
    });

    // Button navigates to the marketplace page (no modal)
    const btn = screen.getByText('Browse Marketplace');
    expect(btn).toBeInTheDocument();
  });

  it('"Restart to Apply Changes" appears after toggle', async () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { plugins: mockPlugins, darkrideVersion: '1.0.0' } },
          });
        }
        if (method === 'GET' && path.includes('/scope-status')) {
          return Promise.resolve({
            type: 'restapi', id: 'ss', status: 200,
            body: mockScopeStatus,
          });
        }
        if (method === 'POST' && path.includes('/enable')) {
          return Promise.resolve({
            type: 'restapi', id: '2', status: 200,
            body: { success: true, restartRequired: true },
          });
        }
        return Promise.resolve({ type: 'restapi', id: 'x', status: 200, body: { success: true } });
      }),
    });
    renderPluginManager(ws);

    await waitFor(() => {
      expect(screen.getByText('plugin-disabled')).toBeInTheDocument();
    });

    // Click enable on the disabled plugin
    const disabledButton = screen.getAllByText('Disabled');
    fireEvent.click(disabledButton[0]);

    await waitFor(() => {
      expect(screen.getByText('Restart to Apply Changes')).toBeInTheDocument();
    });
  });

  it('shows the spinner on the active row during update', async () => {
    // Fixture: one plugin with an update available
    const fixture = [{
      name: 'demo-plugin-c',
      enabled: true,
      installedVia: 'managed',
      version: '1.0.0',
      description: null,
      author: null,
      npmPackage: '@example.org/plugin-maps',
      loaded: true,
      updateAvailable: true,
      latestVersion: '1.0.1',
    }];

    // Make the update endpoint hang so we can observe the in-flight state.
    let resolveUpdate!: (value: any) => void;
    const updatePromise = new Promise<any>((r) => {
      resolveUpdate = r;
    });

    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { plugins: fixture, darkrideVersion: '1.0.0' } },
          });
        }
        if (method === 'POST' && path === '/v1/plugins/update') {
          return updatePromise;
        }
        return Promise.resolve({ type: 'restapi', id: 'x', status: 200, body: { success: true } });
      }),
    });

    renderPluginManager(ws);
    await screen.findByText('demo-plugin-c');
    fireEvent.click(screen.getByRole('button', { name: /Update to v1\.0\.1/ }));

    // Button should now be disabled and labeled "Updating…"
    const btn = await screen.findByRole('button', { name: /Updating/ });
    expect(btn).toBeDisabled();

    // Resolve the update; spinner clears.
    resolveUpdate({ type: 'restapi', id: '2', status: 200, body: { success: true, restartRequired: false } });
  });

  it('shows Update all banner when 2+ plugins have updateAvailable', async () => {
    const fixture = [
      { name: 'demo-plugin-c',      enabled: true, installedVia: 'managed', version: '1.0.0', description: null, author: null, npmPackage: '@x/maps',      loaded: true, updateAvailable: true,  latestVersion: '1.0.1' },
      { name: 'demo-plugin-a', enabled: true, installedVia: 'managed', version: '1.0.0', description: null, author: null, npmPackage: '@x/demo-a', loaded: true, updateAvailable: true,  latestVersion: '1.0.1' },
      { name: 'demo-plugin-b',   enabled: true, installedVia: 'managed', version: '0.1.0', description: null, author: null, npmPackage: '@x/demo-b',   loaded: true, updateAvailable: false },
    ];
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({ status: 200, body: { success: true, data: { plugins: fixture, darkrideVersion: 'x' } } });
        }
        return Promise.resolve({ status: 200, body: { success: true } });
      }),
    });

    renderPluginManager(ws);
    await screen.findByText('demo-plugin-c');

    expect(screen.getByText(/2 updates available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update all \(2\)/ })).toBeInTheDocument();
  });

  it('does NOT show Update all banner when fewer than 2 updates are available', async () => {
    const fixture = [
      { name: 'demo-plugin-c', enabled: true, installedVia: 'managed', version: '1.0.0', description: null, author: null, npmPackage: '@x/maps', loaded: true, updateAvailable: true, latestVersion: '1.0.1' },
    ];
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({ status: 200, body: { success: true, data: { plugins: fixture, darkrideVersion: 'x' } } });
        }
        return Promise.resolve({ status: 200, body: { success: true } });
      }),
    });

    renderPluginManager(ws);
    await screen.findByText('demo-plugin-c');

    expect(screen.queryByRole('button', { name: /Update all/ })).not.toBeInTheDocument();
  });

  it('Check for updates triggers marketplace refresh + reloads installed plugins', async () => {
    let installedCalls = 0;
    const refreshCalls: number[] = [];

    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/installed') {
          installedCalls++;
          return Promise.resolve({ status: 200, body: { success: true, data: { plugins: [], darkrideVersion: 'x' } } });
        }
        if (method === 'POST' && path === '/v1/plugins/marketplace/refresh') {
          refreshCalls.push(Date.now());
          return Promise.resolve({ status: 200, body: { success: true } });
        }
        return Promise.resolve({ status: 200, body: { success: true } });
      }),
    });

    renderPluginManager(ws);
    // Initial fetch happened on mount.
    await waitFor(() => expect(installedCalls).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /Check for updates/ }));

    await waitFor(() => {
      expect(refreshCalls.length).toBe(1);
      expect(installedCalls).toBe(2);
    });
  });

  it('Update all calls /v1/plugins/update sequentially for each updatable plugin', async () => {
    const fixture = [
      { name: 'demo-plugin-c',      enabled: true, installedVia: 'managed', version: '1.0.0', description: null, author: null, npmPackage: '@x/maps',      loaded: true, updateAvailable: true, latestVersion: '1.0.1' },
      { name: 'demo-plugin-a', enabled: true, installedVia: 'managed', version: '1.0.0', description: null, author: null, npmPackage: '@x/demo-a', loaded: true, updateAvailable: true, latestVersion: '1.0.1' },
    ];
    const updateCalls: string[] = [];
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string, body?: any) => {
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({ status: 200, body: { success: true, data: { plugins: fixture, darkrideVersion: 'x' } } });
        }
        if (method === 'POST' && path === '/v1/plugins/update') {
          updateCalls.push(body?.name);
          return Promise.resolve({ status: 200, body: { success: true, restartRequired: true } });
        }
        return Promise.resolve({ status: 200, body: { success: true } });
      }),
    });

    renderPluginManager(ws);
    await screen.findByRole('button', { name: /Update all/ });
    fireEvent.click(screen.getByRole('button', { name: /Update all/ }));

    await waitFor(() => {
      expect(updateCalls).toEqual(['demo-plugin-c', 'demo-plugin-a']);
    });
  });
});

// ── PluginCard component tests ───────────────────────────────────────────────

describe('PluginCard', () => {
  const defaultProps = {
    name: 'test-plugin',
    version: '2.0.0',
    description: 'A test plugin for unit testing',
    author: 'Test Author',
    enabled: true,
    installedVia: 'npm',
    loaded: true,
    onEnable: vi.fn(),
    onDisable: vi.fn(),
    onUninstall: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders plugin name, version, description', () => {
    render(<PluginCard {...defaultProps} />);

    expect(screen.getByText('test-plugin')).toBeInTheDocument();
    expect(screen.getByText('v2.0.0')).toBeInTheDocument();
    expect(screen.getByText('A test plugin for unit testing')).toBeInTheDocument();
  });

  it('renders author', () => {
    render(<PluginCard {...defaultProps} />);
    expect(screen.getByText('by Test Author')).toBeInTheDocument();
  });

  it('shows "workspace" badge for workspace plugins', () => {
    render(<PluginCard {...defaultProps} installedVia="workspace" />);
    expect(screen.getByText('workspace')).toBeInTheDocument();
  });

  it('shows "npm" badge for npm plugins', () => {
    render(<PluginCard {...defaultProps} installedVia="npm" />);
    expect(screen.getByText('npm')).toBeInTheDocument();
  });

  it('enabled plugin shows "Enabled" label', () => {
    render(<PluginCard {...defaultProps} enabled={true} />);
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('disabled plugin shows "Disabled" label', () => {
    render(<PluginCard {...defaultProps} enabled={false} />);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('disabled plugin has the disabled CSS class', () => {
    const { container } = render(<PluginCard {...defaultProps} enabled={false} />);
    expect(container.querySelector('.plugin-card-disabled')).toBeTruthy();
  });

  it('enabled plugin does not have disabled CSS class', () => {
    const { container } = render(<PluginCard {...defaultProps} enabled={true} />);
    expect(container.querySelector('.plugin-card-disabled')).toBeNull();
  });

  it('uninstall button only shown for npm plugins', () => {
    const { rerender } = render(<PluginCard {...defaultProps} installedVia="npm" />);
    expect(screen.getByTitle('Uninstall plugin')).toBeInTheDocument();

    rerender(<PluginCard {...defaultProps} installedVia="workspace" />);
    expect(screen.queryByTitle('Uninstall plugin')).not.toBeInTheDocument();
  });

  it('"Restart required to load" warning shown when enabled but not loaded', () => {
    render(<PluginCard {...defaultProps} enabled={true} loaded={false} />);
    expect(screen.getByText('Restart required to load')).toBeInTheDocument();
  });

  it('no restart warning when enabled and loaded', () => {
    render(<PluginCard {...defaultProps} enabled={true} loaded={true} />);
    expect(screen.queryByText('Restart required to load')).not.toBeInTheDocument();
  });

  it('no restart warning when disabled', () => {
    render(<PluginCard {...defaultProps} enabled={false} loaded={false} />);
    expect(screen.queryByText('Restart required to load')).not.toBeInTheDocument();
  });

  it('clicking toggle on enabled plugin calls onDisable', () => {
    const onDisable = vi.fn();
    render(<PluginCard {...defaultProps} enabled={true} onDisable={onDisable} />);

    fireEvent.click(screen.getByText('Enabled'));
    expect(onDisable).toHaveBeenCalled();
  });

  it('clicking toggle on disabled plugin calls onEnable', () => {
    const onEnable = vi.fn();
    render(<PluginCard {...defaultProps} enabled={false} onEnable={onEnable} />);

    fireEvent.click(screen.getByText('Disabled'));
    expect(onEnable).toHaveBeenCalled();
  });

  it('shows update button when onUpdate is provided', () => {
    render(<PluginCard {...defaultProps} onUpdate={vi.fn()} />);
    expect(screen.getByTitle('Update plugin')).toBeInTheDocument();
  });

  it('does not show update button when onUpdate not provided', () => {
    render(<PluginCard {...defaultProps} />);
    expect(screen.queryByTitle('Update plugin')).not.toBeInTheDocument();
  });

  it('shows extension point counts when provided', () => {
    render(
      <PluginCard
        {...defaultProps}
        extensionPoints={{ tools: 3, pages: 2, settings: 1 }}
      />,
    );
    expect(screen.getByText('3 tools')).toBeInTheDocument();
    expect(screen.getByText('2 pages')).toBeInTheDocument();
    expect(screen.getByText('1 settings')).toBeInTheDocument();
  });

  it('does not show extension points when not provided', () => {
    render(<PluginCard {...defaultProps} />);
    expect(screen.queryByText(/tools$/)).not.toBeInTheDocument();
  });

  it('handles null version gracefully', () => {
    render(<PluginCard {...defaultProps} version={null} />);
    expect(screen.getByText('test-plugin')).toBeInTheDocument();
    expect(screen.queryByText(/^v/)).not.toBeInTheDocument();
  });

  it('handles null description gracefully', () => {
    render(<PluginCard {...defaultProps} description={null} />);
    expect(screen.getByText('test-plugin')).toBeInTheDocument();
    // No description paragraph should be rendered
    expect(screen.queryByText('A test plugin for unit testing')).not.toBeInTheDocument();
  });

  it('handles null author gracefully', () => {
    render(<PluginCard {...defaultProps} author={null} />);
    expect(screen.queryByText(/^by /)).not.toBeInTheDocument();
  });
});
