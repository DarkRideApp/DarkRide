import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PluginMarketplace } from './PluginMarketplace';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';

// ── Mock data matching real API response shapes ─────────────────────────────

const mockMarketplacePlugins = [
  {
    name: 'maps',
    displayName: 'Maps Plugin',
    description: 'Map overlay for theme parks',
    author: 'DarkRide',
    repo: 'DarkRideApp/plugin-maps',
    latestVersion: '2.0.0',
    category: 'theme-parks',
    license: 'MIT',
    npmPackage: '@darkride/plugin-maps',
    source: 'DarkRide Official',
  },
  {
    name: 'demo-plugin',
    displayName: 'Demo Plugin',
    description: 'Extract data from demo plugin apps',
    author: 'DarkRide',
    repo: 'DarkRideApp/plugin-demo-plugin',
    latestVersion: '1.3.0',
    category: 'extractors',
    license: 'MIT',
    npmPackage: '@darkride/plugin-demo-plugin',
    source: 'DarkRide Official',
  },
  {
    name: 'custom-tool',
    displayName: 'Custom Tool',
    description: 'A private community plugin',
    author: 'Community Dev',
    repo: '',
    latestVersion: '0.1.0',
    category: 'community',
    license: 'GPL-3.0',
    npmPackage: 'custom-tool',
    source: 'Private Registry',
    installUrl: 'git+https://gitea.local/org/custom-tool.git',
  },
];

const mockInstalledPlugins = [
  { name: 'maps', version: '2.0.0', enabled: true, installedVia: 'npm', loaded: true },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockWs(overrides?: Partial<WebSocketContextValue>): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === '/v1/plugins/marketplace') {
        return Promise.resolve({
          type: 'restapi',
          id: '1',
          status: 200,
          body: {
            success: true,
            data: {
              sources: [
                { sourceName: 'DarkRide Official', sourceType: 'registry', plugins: mockMarketplacePlugins.slice(0, 2) },
                { sourceName: 'Private Registry', sourceType: 'registry', plugins: mockMarketplacePlugins.slice(2) },
              ],
              plugins: mockMarketplacePlugins,
            },
          },
        });
      }
      if (method === 'GET' && path === '/v1/plugins/installed') {
        return Promise.resolve({
          type: 'restapi',
          id: '2',
          status: 200,
          body: {
            success: true,
            data: { plugins: mockInstalledPlugins, darkrideVersion: '1.5.0' },
          },
        });
      }
      // Default for POST /v1/plugins/install
      return Promise.resolve({
        type: 'restapi',
        id: '3',
        status: 200,
        body: { success: true, restartRequired: true },
      });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as any;
}

function renderMarketplace(ws?: WebSocketContextValue) {
  const mockWs = ws || createMockWs();
  return {
    ws: mockWs,
    ...render(
      <WebSocketContext.Provider value={mockWs}>
        <ToastProvider>
          <MemoryRouter>
            <PluginMarketplace />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>,
    ),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PluginMarketplace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    renderMarketplace(ws);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('shows plugins from API in grid', async () => {
    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
      expect(screen.getByText('Demo Plugin')).toBeInTheDocument();
      expect(screen.getByText('Custom Tool')).toBeInTheDocument();
    });
  });

  it('search filters by name', async () => {
    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search plugins...');
    fireEvent.change(searchInput, { target: { value: 'maps' } });

    expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
    expect(screen.queryByText('Demo Plugin')).not.toBeInTheDocument();
    expect(screen.queryByText('Custom Tool')).not.toBeInTheDocument();
  });

  it('search filters by description', async () => {
    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search plugins...');
    fireEvent.change(searchInput, { target: { value: 'demo plugin' } });

    expect(screen.queryByText('Maps Plugin')).not.toBeInTheDocument();
    expect(screen.getByText('Demo Plugin')).toBeInTheDocument();
  });

  it('category filter works', async () => {
    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
    });

    // Click the "extractors" category button (use the button element, not the badge span)
    const extractorsButton = screen.getByRole('button', { name: 'extractors' });
    fireEvent.click(extractorsButton);

    expect(screen.queryByText('Maps Plugin')).not.toBeInTheDocument();
    expect(screen.getByText('Demo Plugin')).toBeInTheDocument();
    expect(screen.queryByText('Custom Tool')).not.toBeInTheDocument();

    // Click "All" to reset
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
    expect(screen.getByText('Demo Plugin')).toBeInTheDocument();
    expect(screen.getByText('Custom Tool')).toBeInTheDocument();
  });

  it('install button calls correct API with npmPackage', async () => {
    const ws = createMockWs();
    renderMarketplace(ws);

    await waitFor(() => {
      expect(screen.getByText('Demo Plugin')).toBeInTheDocument();
    });

    // The "Install" buttons should be present for non-installed plugins
    const installButtons = screen.getAllByText('Install');
    // Click the first one (demo-plugin or custom-tool, both are not installed)
    fireEvent.click(installButtons[0]);

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/plugins/install',
        expect.objectContaining({ npmPackage: expect.any(String) }),
      );
    });
  });

  it('shows a name-collision message when install returns 409 with nameCollision', async () => {
    // The install endpoint refuses with 409 when the would-be runtime name
    // collides with a workspace/npm plugin. The toast must tell the user
    // what's wrong AND what to do, not just show the raw 409 body.
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/marketplace') {
          return Promise.resolve({
            type: 'restapi',
            id: '1',
            status: 200,
            body: {
              success: true,
              data: { sources: [], plugins: [mockMarketplacePlugins[1]] }, // demo-plugin
            },
          });
        }
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi',
            id: '2',
            status: 200,
            body: { success: true, data: { plugins: [], darkrideVersion: '1.5.0' } },
          });
        }
        if (method === 'POST' && path === '/v1/plugins/install') {
          return Promise.resolve({
            type: 'restapi',
            id: '3',
            status: 409,
            body: {
              success: false,
              error: 'Plugin name "demo-plugin" collides with an existing workspace plugin. Uninstall or rename the existing plugin first.',
              nameCollision: { existingSource: 'workspace' },
            },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { success: true } });
      }),
    });
    renderMarketplace(ws);

    await waitFor(() => {
      expect(screen.getByText('Demo Plugin')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Install'));

    await waitFor(() => {
      // The toast wrapper renders to a portal — query for the structured
      // workspace-collision message.
      expect(screen.getByText(/Name conflicts with an existing workspace plugin/i)).toBeInTheDocument();
    });
  });

  it('install button uses installUrl for git sources', async () => {
    // Only show the git plugin so we know which button to click
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/marketplace') {
          return Promise.resolve({
            type: 'restapi',
            id: '1',
            status: 200,
            body: {
              success: true,
              data: {
                sources: [],
                plugins: [mockMarketplacePlugins[2]], // custom-tool with installUrl
              },
            },
          });
        }
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi',
            id: '2',
            status: 200,
            body: { success: true, data: { plugins: [], darkrideVersion: '1.5.0' } },
          });
        }
        return Promise.resolve({
          type: 'restapi',
          id: '3',
          status: 200,
          body: { success: true, restartRequired: true },
        });
      }),
    });
    renderMarketplace(ws);

    await waitFor(() => {
      expect(screen.getByText('Custom Tool')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Install'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/plugins/install',
        expect.objectContaining({ installUrl: 'git+https://gitea.local/org/custom-tool.git' }),
      );
    });
  });

  it('"Installed" badge shows for installed plugins', async () => {
    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Installed')).toBeInTheDocument();
    });

    // The maps plugin is installed so it should show "Installed" and no "Install" button
    // Other plugins should show "Install" buttons
    const installButtons = screen.getAllByText('Install');
    // 2 non-installed plugins (demo-plugin + custom-tool)
    expect(installButtons).toHaveLength(2);
  });

  it('"Requires: X" pill renders when plugin declares dependencies', async () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/marketplace') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { plugins: [{ ...mockMarketplacePlugins[1], dependencies: ['maps'] }] } },
          });
        }
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi', id: '2', status: 200,
            body: { success: true, data: { plugins: mockInstalledPlugins, darkrideVersion: '1.5.0' } },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true } });
      }),
    });
    renderMarketplace(ws);
    const pill = await screen.findByTestId('marketplace-requires');
    // 'maps' is installed (installedVia: 'npm') so the dep is satisfied — no "(not installed)" suffix.
    expect(pill.textContent).toBe('Requires: maps');
    expect(pill.className).toBe('marketplace-requires');
  });

  it('"Requires: X (not installed)" warns when a dep is absent', async () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/marketplace') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { plugins: [{ ...mockMarketplacePlugins[1], dependencies: ['maps', 'ghosts'] }] } },
          });
        }
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi', id: '2', status: 200,
            body: { success: true, data: { plugins: mockInstalledPlugins, darkrideVersion: '1.5.0' } },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true } });
      }),
    });
    renderMarketplace(ws);
    const pill = await screen.findByTestId('marketplace-requires');
    expect(pill.textContent).toBe('Requires: maps, ghosts (not installed)');
    expect(pill.className).toBe('marketplace-requires-unmet');
  });

  it('"Reinstall" button shows for plugins whose files are missing', async () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/marketplace') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { plugins: mockMarketplacePlugins, sources: [] } },
          });
        }
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi', id: '2', status: 200,
            body: {
              success: true,
              data: {
                plugins: [{ name: 'maps', version: '2.0.0', enabled: true, installedVia: 'missing', loaded: false }],
                darkrideVersion: '1.5.0',
              },
            },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true } });
      }),
    });
    renderMarketplace(ws);

    await waitFor(() => {
      expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
    });

    // Missing plugin should NOT show "Installed" badge, should show "Reinstall" button
    expect(screen.queryByText('Installed')).not.toBeInTheDocument();
    expect(screen.getByText('Reinstall')).toBeInTheDocument();
  });

  it('Reinstall click posts to /v1/plugins/install (same flow as Install)', async () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/marketplace') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { plugins: mockMarketplacePlugins, sources: [] } },
          });
        }
        if (method === 'GET' && path === '/v1/plugins/installed') {
          return Promise.resolve({
            type: 'restapi', id: '2', status: 200,
            body: {
              success: true,
              data: {
                plugins: [{ name: 'maps', version: '2.0.0', enabled: true, installedVia: 'missing', loaded: false }],
                darkrideVersion: '1.5.0',
              },
            },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, restartRequired: true } });
      }),
    });
    renderMarketplace(ws);

    const reinstall = await screen.findByText('Reinstall');
    fireEvent.click(reinstall);

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/plugins/install',
        expect.objectContaining({ npmPackage: '@darkride/plugin-maps' }),
      );
    });
  });

  it('error state when marketplace API fails', async () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (path === '/v1/plugins/marketplace') {
          return Promise.resolve({
            type: 'restapi',
            id: '1',
            status: 502,
            body: { success: false, error: 'All sources unreachable' },
          });
        }
        return Promise.resolve({
          type: 'restapi',
          id: '2',
          status: 200,
          body: { success: true, data: { plugins: [], darkrideVersion: '1.5.0' } },
        });
      }),
    });
    renderMarketplace(ws);

    await waitFor(() => {
      expect(screen.getByText('All sources unreachable')).toBeInTheDocument();
    });
  });

  it('"Manage Sources" button is present', async () => {
    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Manage Sources')).toBeInTheDocument();
    });

    const button = screen.getByText('Manage Sources');
    expect(button.tagName).toBe('BUTTON');
  });

  it('shows empty state when no plugins match search', async () => {
    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search plugins...');
    fireEvent.change(searchInput, { target: { value: 'nonexistent-plugin-xyz' } });

    expect(screen.getByText('No plugins match your search.')).toBeInTheDocument();
  });

  it('shows source badge on plugin cards', async () => {
    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
    });

    expect(screen.getAllByText('DarkRide Official')).toHaveLength(2);
    expect(screen.getByText('Private Registry')).toBeInTheDocument();
  });

  // ─── Verification badges ───────────────────────────────────────────────

  describe('verification badges', () => {
    const verifiedPlugin = {
      ...mockMarketplacePlugins[0],
      verification: { status: 'verified' as const, signedBy: 'darkride-official', keyLabel: 'DarkRide Official' },
    };

    const unsignedPlugin = {
      ...mockMarketplacePlugins[1],
      verification: { status: 'unsigned' as const },
    };

    function createVerificationWs(plugins: typeof mockMarketplacePlugins) {
      return createMockWs({
        sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
          if (method === 'GET' && path === '/v1/plugins/marketplace') {
            return Promise.resolve({
              type: 'restapi',
              id: '1',
              status: 200,
              body: {
                success: true,
                data: { sources: [], plugins },
              },
            });
          }
          if (method === 'GET' && path === '/v1/plugins/installed') {
            return Promise.resolve({
              type: 'restapi',
              id: '2',
              status: 200,
              body: { success: true, data: { plugins: [], darkrideVersion: '1.5.0' } },
            });
          }
          return Promise.resolve({
            type: 'restapi',
            id: '3',
            status: 200,
            body: { success: true, restartRequired: true },
          });
        }),
      });
    }

    it('verified plugin shows green shield badge', async () => {
      renderMarketplace(createVerificationWs([verifiedPlugin]));

      await waitFor(() => {
        expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
      });

      const badge = screen.getByText(/Verified by DarkRide Official/);
      expect(badge).toBeInTheDocument();
      expect(badge.closest('.plugin-verified')).toBeInTheDocument();
    });

    it('unsigned plugin shows yellow warning badge', async () => {
      renderMarketplace(createVerificationWs([unsignedPlugin]));

      await waitFor(() => {
        expect(screen.getByText('Demo Plugin')).toBeInTheDocument();
      });

      const badge = screen.getByText('Unverified');
      expect(badge).toBeInTheDocument();
      expect(badge.closest('.plugin-unverified')).toBeInTheDocument();
    });
  });

  // ─── Install flow: verification prompts ─────────────────────────────────

  describe('install flow with verification', () => {
    it('unsigned plugin triggers ConfirmDialog (not native confirm)', async () => {
      const unsignedPlugin = {
        ...mockMarketplacePlugins[1],
        verification: { status: 'unsigned' as const },
      };

      let callCount = 0;
      const ws = createMockWs({
        sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
          if (method === 'GET' && path === '/v1/plugins/marketplace') {
            return Promise.resolve({
              type: 'restapi',
              id: '1',
              status: 200,
              body: { success: true, data: { sources: [], plugins: [unsignedPlugin] } },
            });
          }
          if (method === 'GET' && path === '/v1/plugins/installed') {
            return Promise.resolve({
              type: 'restapi',
              id: '2',
              status: 200,
              body: { success: true, data: { plugins: [], darkrideVersion: '1.5.0' } },
            });
          }
          if (method === 'POST' && path === '/v1/plugins/install') {
            callCount++;
            if (callCount === 1) {
              // First call — return confirmRequired
              return Promise.resolve({
                type: 'restapi',
                id: '3',
                status: 200,
                body: {
                  success: false,
                  confirmRequired: true,
                  warning: 'This plugin is not verified by any trusted publisher. Unverified plugins could contain malicious code.',
                },
              });
            }
            // Second call — confirmed
            return Promise.resolve({
              type: 'restapi',
              id: '4',
              status: 200,
              body: { success: true, restartRequired: true },
            });
          }
          return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true } });
        }),
      });
      renderMarketplace(ws);

      await waitFor(() => {
        expect(screen.getByText('Demo Plugin')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Install'));

      // ConfirmDialog should render with the warning text from the backend.
      const installAnyway = await screen.findByText('Install anyway');
      expect(installAnyway).toBeInTheDocument();
      // The warning text is rendered inside the dialog.
      expect(screen.getByText(/not verified by any trusted publisher/i)).toBeInTheDocument();

      // Click through — second POST should carry confirmed: true.
      fireEvent.click(installAnyway);

      await waitFor(() => {
        expect(ws.sendRestApi).toHaveBeenCalledWith(
          'POST',
          '/v1/plugins/install',
          expect.objectContaining({ confirmed: true }),
        );
      });
    });

    it('blocked auth plugin shows error toast', async () => {
      const blockedPlugin = {
        ...mockMarketplacePlugins[1],
        name: 'shady-auth',
        displayName: 'Shady Auth',
        category: 'auth-providers',
      };

      const ws = createMockWs({
        sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
          if (method === 'GET' && path === '/v1/plugins/marketplace') {
            return Promise.resolve({
              type: 'restapi',
              id: '1',
              status: 200,
              body: { success: true, data: { sources: [], plugins: [blockedPlugin] } },
            });
          }
          if (method === 'GET' && path === '/v1/plugins/installed') {
            return Promise.resolve({
              type: 'restapi',
              id: '2',
              status: 200,
              body: { success: true, data: { plugins: [], darkrideVersion: '1.5.0' } },
            });
          }
          if (method === 'POST' && path === '/v1/plugins/install') {
            return Promise.resolve({
              type: 'restapi',
              id: '3',
              status: 403,
              body: {
                success: false,
                blocked: true,
                error: 'Auth plugins must be signed by a trusted publisher. This plugin cannot be installed.',
              },
            });
          }
          return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true } });
        }),
      });
      renderMarketplace(ws);

      await waitFor(() => {
        expect(screen.getByText('Shady Auth')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Install'));

      await waitFor(() => {
        // Toast error should appear with the blocked message
        expect(screen.getByText(/Auth plugins must be signed/)).toBeInTheDocument();
      });
    });
  });

  // ─── Refresh / fetchedAt ──────────────────────────────────────────────

  describe('refresh and fetchedAt', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function createRefreshWs() {
      const now = Math.floor(Date.now() / 1000) * 1000; // round to seconds
      return createMockWs({
        sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
          if (method === 'GET' && path === '/v1/plugins/marketplace') {
            return Promise.resolve({
              type: 'restapi',
              id: '1',
              status: 200,
              body: {
                success: true,
                data: {
                  sources: [],
                  plugins: mockMarketplacePlugins,
                  fetchedAt: now - 300_000, // 5 min ago
                },
              },
            });
          }
          if (method === 'GET' && path === '/v1/plugins/installed') {
            return Promise.resolve({
              type: 'restapi',
              id: '2',
              status: 200,
              body: { success: true, data: { plugins: mockInstalledPlugins, darkrideVersion: '1.5.0' } },
            });
          }
          if (method === 'POST' && path === '/v1/plugins/marketplace/refresh') {
            return Promise.resolve({
              type: 'restapi',
              id: '3',
              status: 200,
              body: {
                success: true,
                data: {
                  sources: [],
                  plugins: mockMarketplacePlugins,
                  fetchedAt: Date.now(),
                },
              },
            });
          }
          return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true } });
        }),
      });
    }

    it('shows "Last updated" timestamp when fetchedAt is present', async () => {
      renderMarketplace(createRefreshWs());

      await waitFor(() => {
        expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
      });
    });

    it('refresh button calls POST refresh endpoint', async () => {
      const ws = createRefreshWs();
      renderMarketplace(ws);

      await waitFor(() => {
        expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
      });

      const refreshBtn = screen.getByRole('button', { name: /Refresh/i });
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/plugins/marketplace/refresh');
      });
    });

    it('refresh button is disabled during cooldown', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const ws = createRefreshWs();
      renderMarketplace(ws);

      // Wait for initial load to finish
      await waitFor(() => {
        expect(screen.getByText('Maps Plugin')).toBeInTheDocument();
      });

      const refreshBtn = screen.getByRole('button', { name: /Refresh/i });
      expect(refreshBtn).not.toBeDisabled();

      // Click refresh — this triggers the async handler + setTimeout cooldown
      await act(async () => {
        fireEvent.click(refreshBtn);
      });

      // Now it should be disabled (cooldown)
      expect(refreshBtn).toBeDisabled();

      // Advance 61 seconds — cooldown should expire
      act(() => {
        vi.advanceTimersByTime(61_000);
      });

      expect(refreshBtn).not.toBeDisabled();
    });
  });
});
