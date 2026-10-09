import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { pluginRegistry, __resetPluginRegistry } from '@darkrideapp/plugin-sdk/react';
import { PluginsWorkspace } from './PluginsWorkspace';
import {
  createMockWs,
  mockApiState,
  withProviders,
  registryPlugin,
  installedPlugin,
  calledPaths,
  type MockApiState,
} from './testing';

// ── helpers ──────────────────────────────────────────────────────────────────

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}

function renderWorkspace(state: MockApiState, entry = '/ui/plugins') {
  const ws = createMockWs(state);
  render(
    <Routes>
      <Route
        path="/ui/plugins"
        element={
          <>
            <PluginsWorkspace />
            <LocationProbe />
          </>
        }
      />
    </Routes>,
    { wrapper: withProviders(ws, entry) },
  );
  return { ws, state };
}

const rowNames = () => screen.queryAllByTestId('plugin-row').map(r => r.getAttribute('data-plugin'));

function rowOf(name: string) {
  const el = document.querySelector<HTMLElement>(`[data-testid="plugin-row"][data-plugin="${name}"]`);
  if (!el) throw new Error(`no row for ${name}`);
  return within(el);
}

const location = () => screen.getByTestId('loc').textContent!;

/** Rows are on screen and both the installed list and the marketplace have settled. */
async function loaded() {
  await screen.findAllByTestId('plugin-row');
  await waitFor(() => expect(screen.getByTestId('plugins-workspace')).toHaveAttribute('aria-busy', 'false'));
}

function bodyOf(ws: ReturnType<typeof createMockWs>, method: string, path: string) {
  const call = (ws.sendRestApi as any).mock.calls.find((c: unknown[]) => c[0] === method && c[1] === path);
  return call?.[2];
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const maps = () => registryPlugin({ name: 'maps', displayName: 'Maps Plugin', category: 'theme-parks' });
const frida = () => registryPlugin({ name: 'frida-tools', displayName: 'Frida Tools', category: 'extractors' });

afterEach(() => {
  __resetPluginRegistry();
});

// ── landing and tabs ─────────────────────────────────────────────────────────

describe('PluginsWorkspace: landing and tabs', () => {
  it('opens on Installed when there are installed plugins', async () => {
    renderWorkspace(mockApiState({ registry: [maps(), frida()], installed: [installedPlugin({ name: 'maps' })] }));
    expect(screen.getByRole('heading', { level: 1, name: 'Plugins' })).toBeInTheDocument();
    await loaded();
    expect(screen.getByRole('tab', { name: /Installed/ })).toHaveAttribute('aria-selected', 'true');
    expect(rowNames()).toEqual(['maps']);
  });

  it('opens on Discover on a first run with nothing installed', async () => {
    renderWorkspace(mockApiState({ registry: [maps(), frida()] }));
    await loaded();
    expect(screen.getByRole('tab', { name: /Discover/ })).toHaveAttribute('aria-selected', 'true');
    expect(rowNames().sort()).toEqual(['frida-tools', 'maps']);
  });

  it('honours ?tab=discover even when plugins are installed', async () => {
    renderWorkspace(
      mockApiState({ registry: [maps(), frida()], installed: [installedPlugin({ name: 'maps' })] }),
      '/ui/plugins?tab=discover',
    );
    await loaded();
    expect(screen.getByRole('tab', { name: /Discover/ })).toHaveAttribute('aria-selected', 'true');
    expect(rowNames()).toHaveLength(2);
  });

  it('shows how many plugins each tab holds', async () => {
    renderWorkspace(mockApiState({ registry: [maps(), frida()], installed: [installedPlugin({ name: 'maps' })] }));
    await loaded();
    expect(screen.getByRole('tab', { name: 'Installed 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Discover 2' })).toBeInTheDocument();
  });

  it('switches tab and records it in the URL', async () => {
    renderWorkspace(mockApiState({ registry: [maps(), frida()], installed: [installedPlugin({ name: 'maps' })] }));
    await loaded();
    fireEvent.click(screen.getByRole('tab', { name: /Discover/ }));
    expect(location()).toContain('tab=discover');
    expect(rowNames()).toHaveLength(2);
  });

  it('lists a local plugin on Installed but not on Discover', async () => {
    renderWorkspace(
      mockApiState({
        registry: [maps()],
        installed: [installedPlugin({ name: 'maps' }), installedPlugin({ name: 'dev', npmPackage: null, installedVia: 'workspace' })],
      }),
    );
    await loaded();
    expect(rowNames().sort()).toEqual(['dev', 'maps']);
    fireEvent.click(screen.getByRole('tab', { name: /Discover/ }));
    expect(rowNames()).toEqual(['maps']);
  });

  it('marks an installed plugin on Discover instead of hiding it', async () => {
    renderWorkspace(mockApiState({ registry: [maps(), frida()], installed: [installedPlugin({ name: 'maps' })] }), '/ui/plugins?tab=discover');
    await loaded();
    expect(rowOf('maps').getByTestId('plugin-status')).toHaveTextContent('Installed');
    expect(rowOf('frida-tools').queryByTestId('plugin-status')).toBeNull();
  });

  it('shows the restart banner slot and one heading, not two', async () => {
    renderWorkspace(mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps' })] }));
    await loaded();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText('Plugin Marketplace')).toBeNull();
  });
});

// ── updating ─────────────────────────────────────────────────────────────────

describe('PluginsWorkspace: updates', () => {
  const stale = (name: string) => installedPlugin({ name, version: '1.0.0', updateAvailable: true, latestVersion: '2.0.0' });

  function updateRoute(state: MockApiState) {
    state.routes['POST /v1/plugins/update'] = (body: { name: string }) => {
      state.installed = state.installed.map(p => (p.name === body.name ? { ...p, version: '2.0.0', updateAvailable: false } : p));
      return { success: true, restartRequired: true };
    };
  }

  it('updates a plugin from the Installed tab', async () => {
    const { ws, state } = renderWorkspace(mockApiState({ registry: [maps()], installed: [stale('maps')] }));
    updateRoute(state);
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Update to v2.0.0' }));
    expect(await screen.findByText('Updated Maps Plugin')).toBeInTheDocument();
    expect(bodyOf(ws, 'POST', '/v1/plugins/update')).toEqual({ name: 'maps' });
    await waitFor(() => expect(rowOf('maps').queryByRole('button', { name: /Update to/ })).toBeNull());
  });

  it('offers the same Update button on the Discover tab', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps()], installed: [stale('maps')] }), '/ui/plugins?tab=discover');
    updateRoute(state);
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Update to v2.0.0' }));
    expect(await screen.findByText('Updated Maps Plugin')).toBeInTheDocument();
  });

  it('shows an update strip with a count and nothing when there are none', async () => {
    renderWorkspace(mockApiState({ registry: [maps(), frida()], installed: [installedPlugin({ name: 'maps' })] }));
    await loaded();
    expect(screen.queryByTestId('plugins-update-strip')).toBeNull();
  });

  it('words the strip for one update and updates it', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps()], installed: [stale('maps')] }));
    updateRoute(state);
    await loaded();
    const strip = screen.getByTestId('plugins-update-strip');
    expect(strip).toHaveTextContent('1 update available');
    fireEvent.click(within(strip).getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('Updated Maps Plugin')).toBeInTheDocument();
  });

  it('updates all plugins one after another, never two at once', async () => {
    const state = mockApiState({
      registry: [registryPlugin({ name: 'a' }), registryPlugin({ name: 'b' })],
      installed: [stale('a'), stale('b')],
    });
    const gate = deferred();
    const started: string[] = [];
    state.routes['POST /v1/plugins/update'] = async (body: { name: string }) => {
      started.push(body.name);
      if (body.name === 'a') await gate.promise;
      state.installed = state.installed.map(p => (p.name === body.name ? { ...p, updateAvailable: false } : p));
      return { success: true };
    };
    renderWorkspace(state);
    await loaded();
    const strip = screen.getByTestId('plugins-update-strip');
    expect(strip).toHaveTextContent('2 updates available');
    fireEvent.click(within(strip).getByRole('button', { name: 'Update all' }));
    await waitFor(() => expect(started).toEqual(['a']));
    await act(async () => {
      await Promise.resolve();
    });
    expect(started).toEqual(['a']);
    gate.resolve();
    await waitFor(() => expect(started).toEqual(['a', 'b']));
    expect(await screen.findByText('Updated 2 plugins')).toBeInTheDocument();
  });

  it('reports a partial update-all honestly', async () => {
    const state = mockApiState({
      registry: [registryPlugin({ name: 'a' }), registryPlugin({ name: 'b' })],
      installed: [stale('a'), stale('b')],
    });
    state.routes['POST /v1/plugins/update'] = (body: { name: string }) =>
      body.name === 'a' ? { success: false, error: 'npm exploded' } : { success: true };
    renderWorkspace(state);
    await loaded();
    fireEvent.click(within(screen.getByTestId('plugins-update-strip')).getByRole('button', { name: 'Update all' }));
    expect(await screen.findByText('Updated 1 of 2 plugins. 1 failed.')).toBeInTheDocument();
  });

  it('shows the server error when an update fails', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps()], installed: [stale('maps')] }));
    state.routes['POST /v1/plugins/update'] = () => ({ success: false, error: 'registry unreachable' });
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Update to v2.0.0' }));
    expect(await screen.findByText('Failed to update Maps Plugin: registry unreachable')).toBeInTheDocument();
    expect(rowOf('maps').getByRole('button', { name: 'Update to v2.0.0' })).toBeEnabled();
  });
});

// ── search and filters ───────────────────────────────────────────────────────

describe('PluginsWorkspace: search and filters', () => {
  const three = () =>
    mockApiState({
      registry: [maps(), frida(), registryPlugin({ name: 'zeta', displayName: 'Zeta Kit', category: 'extractors' })],
      installed: [
        installedPlugin({ name: 'maps' }),
        installedPlugin({ name: 'frida-tools', enabled: false }),
        installedPlugin({ name: 'zeta', updateAvailable: true, latestVersion: '2.0.0' }),
      ],
    });

  it('narrows the list as you type and keeps the query in the URL', async () => {
    renderWorkspace(three());
    await loaded();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plugins' }), { target: { value: 'zeta' } });
    expect(rowNames()).toEqual(['zeta']);
    expect(location()).toContain('q=zeta');
  });

  it('restores a search from the URL', async () => {
    renderWorkspace(three(), '/ui/plugins?q=frida');
    await loaded();
    expect(screen.getByRole('searchbox', { name: 'Search plugins' })).toHaveValue('frida');
    expect(rowNames()).toEqual(['frida-tools']);
  });

  it('says nothing matched and lets you clear the search', async () => {
    renderWorkspace(three());
    await loaded();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plugins' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No plugins match "zzz".')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(rowNames()).toHaveLength(3);
    expect(location()).not.toContain('q=');
  });

  it('filters Installed to updates and shows chips only for states that exist', async () => {
    renderWorkspace(three());
    await loaded();
    expect(screen.getByRole('button', { name: /^Updates/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Disabled/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Errors/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
    expect(rowNames()).toEqual(['zeta']);
    expect(location()).toContain('filter=updates');
    expect(screen.getByRole('button', { name: /^Updates/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('filters Installed to disabled', async () => {
    renderWorkspace(three(), '/ui/plugins?filter=disabled');
    await loaded();
    expect(rowNames()).toEqual(['frida-tools']);
  });

  it('filters Discover by category and drops the Installed filter when switching tabs', async () => {
    renderWorkspace(three(), '/ui/plugins?filter=updates');
    await loaded();
    fireEvent.click(screen.getByRole('tab', { name: /Discover/ }));
    expect(location()).not.toContain('filter=');
    expect(rowNames()).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'extractors' }));
    expect(rowNames().sort()).toEqual(['frida-tools', 'zeta']);
    expect(location()).toContain('category=extractors');
  });

  it('keeps the query when switching tabs', async () => {
    renderWorkspace(three(), '/ui/plugins?q=maps');
    await loaded();
    fireEvent.click(screen.getByRole('tab', { name: /Discover/ }));
    expect(location()).toContain('q=maps');
  });
});

// ── installing ───────────────────────────────────────────────────────────────

describe('PluginsWorkspace: install', () => {
  const installRoute = (state: MockApiState) => {
    state.routes['POST /v1/plugins/install'] = () => {
      state.installed = [...state.installed, installedPlugin({ name: 'maps', loaded: false })];
      return { success: true, restartRequired: true };
    };
  };

  it('installs from Discover, then shows it waiting for a restart', async () => {
    const { ws, state } = renderWorkspace(mockApiState({ registry: [maps()] }));
    installRoute(state);
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Install' }));
    expect(await screen.findByText('Maps Plugin installed. Restart to activate.')).toBeInTheDocument();
    const body = bodyOf(ws, 'POST', '/v1/plugins/install');
    expect(body.npmPackage).toBe('@darkride/plugin-maps');
    expect(body.pluginData.name).toBe('maps');
    expect(body.confirmed).toBeUndefined();
    await waitFor(() => expect(rowOf('maps').getByTestId('plugin-status')).toHaveTextContent('Restart to activate'));
    expect(screen.getByText('Installing "maps"')).toBeInTheDocument();
  });

  it('installs a git-sourced plugin from its installUrl', async () => {
    const { ws, state } = renderWorkspace(
      mockApiState({
        registry: [registryPlugin({ name: 'custom', displayName: 'Custom Tool', npmPackage: 'custom-tool', installUrl: 'git+https://git.example/org/custom-tool.git' })],
      }),
    );
    state.routes['POST /v1/plugins/install'] = () => ({ success: true });
    await loaded();
    fireEvent.click(rowOf('custom').getByRole('button', { name: 'Install' }));
    await screen.findByText('Custom Tool installed. Restart to activate.');
    const body = bodyOf(ws, 'POST', '/v1/plugins/install');
    expect(body.installUrl).toBe('git+https://git.example/org/custom-tool.git');
    expect(body.npmPackage).toBe('custom-tool');
  });

  it('asks before installing an unverified plugin, then confirms', async () => {
    const { ws, state } = renderWorkspace(mockApiState({ registry: [maps()] }));
    state.routes['POST /v1/plugins/install'] = (body: { confirmed?: boolean }) => {
      if (!body.confirmed) return { success: false, confirmRequired: true, warning: 'Not signed by a trusted publisher.' };
      state.installed = [installedPlugin({ name: 'maps', loaded: false })];
      return { success: true };
    };
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Install' }));
    expect(await screen.findByText('Install unverified "Maps Plugin"?')).toBeInTheDocument();
    expect(screen.getByText(/Not signed by a trusted publisher\./)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(await screen.findByText('Maps Plugin installed. Restart to activate.')).toBeInTheDocument();
    const posts = (ws.sendRestApi as any).mock.calls.filter((c: unknown[]) => c[1] === '/v1/plugins/install');
    expect(posts).toHaveLength(2);
    expect(posts[1][2].confirmed).toBe(true);
  });

  it('cancelling the warning installs nothing and frees the button', async () => {
    const { ws, state } = renderWorkspace(mockApiState({ registry: [maps()] }));
    state.routes['POST /v1/plugins/install'] = () => ({ success: false, confirmRequired: true, warning: 'Unsigned.' });
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Install' }));
    await screen.findByText('Install unverified "Maps Plugin"?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Install unverified "Maps Plugin"?')).toBeNull());
    expect(screen.queryByText('Installing "maps"')).toBeNull();
    expect(rowOf('maps').getByRole('button', { name: 'Install' })).toBeEnabled();
    expect((ws.sendRestApi as any).mock.calls.filter((c: unknown[]) => c[1] === '/v1/plugins/install')).toHaveLength(1);
  });

  it('explains a name collision and closes the progress dialog', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps()] }));
    state.routes['POST /v1/plugins/install'] = () => ({ success: false, error: 'collision', nameCollision: { existingSource: 'workspace' } });
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Install' }));
    expect(
      await screen.findByText('Name conflicts with an existing workspace plugin. Uninstall the workspace copy or rename this plugin to install both.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Installing "maps"')).toBeNull();
  });

  it('reports a content pin mismatch', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps()] }));
    state.routes['POST /v1/plugins/install'] = () => ({ success: false, error: 'hash differs', contentMismatch: true });
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Install' }));
    expect(await screen.findByText('Refused: signed-manifest content pin mismatch. hash differs')).toBeInTheDocument();
  });

  it('shows a blocked install as an error toast', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps()] }));
    state.routes['POST /v1/plugins/install'] = () => ({ success: false, blocked: true, error: 'Blocked by policy' });
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Install' }));
    expect(await screen.findByText('Blocked by policy')).toBeInTheDocument();
    expect(screen.queryByText('Installing "maps"')).toBeNull();
  });

  it('falls back to a generic message when the server gives none', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps()] }));
    state.routes['POST /v1/plugins/install'] = () => ({ success: false });
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Install' }));
    expect(await screen.findByText('Failed to install Maps Plugin')).toBeInTheDocument();
  });

  it('allows only one install at a time', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps(), frida()] }));
    const gate = deferred();
    state.routes['POST /v1/plugins/install'] = async () => {
      await gate.promise;
      return { success: true };
    };
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(rowOf('maps').getByRole('button', { name: /Installing/ })).toBeDisabled());
    expect(rowOf('frida-tools').getByRole('button', { name: 'Install' })).toBeDisabled();
    gate.resolve();
    await waitFor(() => expect(rowOf('frida-tools').getByRole('button', { name: 'Install' })).toBeEnabled());
  });

  it('reinstalls a plugin whose files went missing', async () => {
    const { ws, state } = renderWorkspace(
      mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps', installedVia: 'missing' })] }),
    );
    state.routes['POST /v1/plugins/install'] = () => {
      state.installed = [installedPlugin({ name: 'maps' })];
      return { success: true };
    };
    await loaded();
    expect(rowOf('maps').getByTestId('plugin-status')).toHaveTextContent('Files missing');
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Reinstall' }));
    await screen.findByText('Maps Plugin installed. Restart to activate.');
    expect(bodyOf(ws, 'POST', '/v1/plugins/install').npmPackage).toBe('@darkride/plugin-maps');
  });
});

// ── enabling, disabling, consent ─────────────────────────────────────────────

describe('PluginsWorkspace: enable, disable and permissions', () => {
  const aiScopes = {
    success: true,
    state: 'unconsented',
    manifestScopes: ['ai.chat'],
    approvedScopes: null,
    added: [{ key: 'ai.chat', metadata: { label: 'Chat with models', description: 'Send prompts' } }],
    removed: [],
  };

  it('disables a plugin from its switch', async () => {
    const { ws, state } = renderWorkspace(mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps' })] }));
    state.routes['POST /v1/plugins/maps/disable'] = () => {
      state.installed = [installedPlugin({ name: 'maps', enabled: false })];
      return { success: true, restartRequired: true };
    };
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('switch', { name: 'Enable Maps Plugin' }));
    expect(await screen.findByText('Maps Plugin disabled')).toBeInTheDocument();
    expect(calledPaths(ws)).toContain('POST /v1/plugins/maps/disable');
    await waitFor(() => expect(rowOf('maps').getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
    expect(rowOf('maps').getByTestId('plugin-status')).toHaveTextContent('Disabled');
  });

  it('enables a plugin from its switch', async () => {
    const { ws, state } = renderWorkspace(mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps', enabled: false })] }));
    state.routes['POST /v1/plugins/maps/enable'] = () => {
      state.installed = [installedPlugin({ name: 'maps', enabled: true })];
      return { success: true, restartRequired: true };
    };
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('switch'));
    expect(await screen.findByText('Maps Plugin enabled')).toBeInTheDocument();
    expect(calledPaths(ws)).toContain('POST /v1/plugins/maps/enable');
  });

  it('shows an error toast and leaves the switch alone when toggling fails', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps' })] }));
    state.routes['POST /v1/plugins/maps/disable'] = () => ({ success: false, error: 'db locked' });
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('switch'));
    expect(await screen.findByText('Failed to disable Maps Plugin: db locked')).toBeInTheDocument();
    expect(rowOf('maps').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('asks for AI permission consent before enabling a plugin that has never been approved', async () => {
    const { ws, state } = renderWorkspace(
      mockApiState({
        registry: [registryPlugin({ name: 'ai', displayName: 'AI Helper' })],
        installed: [installedPlugin({ name: 'ai', enabled: false, version: '1.0.0' })],
        scopeStatus: { ai: { ...aiScopes } },
      }),
    );
    state.routes['POST /v1/plugins/ai/approve-scopes'] = () => ({ success: true });
    await loaded();
    await waitFor(() => expect(calledPaths(ws)).toContain('GET /v1/plugins/ai/scope-status'));
    // A pending plugin leads with Review; flip the switch to take the enable path.
    await waitFor(() => expect(rowOf('ai').getByRole('button', { name: 'Review permissions' })).toBeInTheDocument());
    fireEvent.click(rowOf('ai').getByRole('switch'));
    expect(await screen.findByText(/AI scope request/)).toBeInTheDocument();
    expect(calledPaths(ws)).not.toContain('POST /v1/plugins/ai/enable');
    fireEvent.click(screen.getByRole('button', { name: 'Allow and enable' }));
    await screen.findByText('Permissions approved for AI Helper');
    expect(bodyOf(ws, 'POST', '/v1/plugins/ai/approve-scopes')).toEqual({ approvedScopes: ['ai.chat'] });
  });

  it('opens the consent dialog from Review permissions on an enabled plugin', async () => {
    renderWorkspace(
      mockApiState({
        registry: [registryPlugin({ name: 'ai', displayName: 'AI Helper' })],
        installed: [installedPlugin({ name: 'ai' })],
        scopeStatus: { ai: { ...aiScopes } },
      }),
    );
    await loaded();
    fireEvent.click(await within(document.body).findByRole('button', { name: 'Review permissions' }));
    expect(await screen.findByText(/AI scope request/)).toBeInTheDocument();
    expect(screen.getByText('Chat with models')).toBeInTheDocument();
  });

  it('dismissing the consent dialog changes nothing', async () => {
    const { ws } = renderWorkspace(
      mockApiState({
        registry: [registryPlugin({ name: 'ai' })],
        installed: [installedPlugin({ name: 'ai' })],
        scopeStatus: { ai: { ...aiScopes } },
      }),
    );
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: 'Review permissions' }));
    await screen.findByText(/AI scope request/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/AI scope request/)).toBeNull());
    expect(calledPaths(ws).some(p => p.includes('approve-scopes'))).toBe(false);
  });

  it('shows an error toast when approval fails and keeps the dialog open', async () => {
    const { state } = renderWorkspace(
      mockApiState({
        registry: [registryPlugin({ name: 'ai', displayName: 'AI Helper' })],
        installed: [installedPlugin({ name: 'ai' })],
        scopeStatus: { ai: { ...aiScopes } },
      }),
    );
    state.routes['POST /v1/plugins/ai/approve-scopes'] = () => ({ success: false, error: 'nope' });
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: 'Review permissions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow and enable' }));
    expect(await screen.findByText('Failed to approve permissions: nope')).toBeInTheDocument();
    expect(screen.getByText(/AI scope request/)).toBeInTheDocument();
  });
});

// ── drawer and URL ───────────────────────────────────────────────────────────

describe('PluginsWorkspace: detail drawer', () => {
  const one = () => mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps' })] });

  it('opens from a row and records the plugin in the URL', async () => {
    renderWorkspace(one());
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Maps Plugin' }));
    expect(await screen.findByRole('dialog', { name: 'Maps Plugin details' })).toBeInTheDocument();
    expect(location()).toContain('plugin=maps');
    expect(rowOf('maps').getByRole('button', { name: 'Maps Plugin' }).closest('li')).toHaveAttribute('aria-current', 'true');
  });

  it('opens straight from a deep link', async () => {
    renderWorkspace(one(), '/ui/plugins?plugin=maps');
    expect(await screen.findByRole('dialog', { name: 'Maps Plugin details' })).toBeInTheDocument();
  });

  it('closes from the X and removes the plugin from the URL', async () => {
    renderWorkspace(one(), '/ui/plugins?plugin=maps');
    await screen.findByRole('dialog', { name: 'Maps Plugin details' });
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /details/ })).toBeNull());
    expect(location()).not.toContain('plugin=');
  });

  it('opening another plugin while the drawer is open swaps it, so closing really closes', async () => {
    renderWorkspace(
      mockApiState({
        registry: [maps(), frida()],
        installed: [installedPlugin({ name: 'maps' }), installedPlugin({ name: 'frida-tools' })],
      }),
    );
    await loaded();
    fireEvent.click(rowOf('maps').getByRole('button', { name: 'Maps Plugin' }));
    await screen.findByRole('dialog', { name: 'Maps Plugin details' });
    fireEvent.click(rowOf('frida-tools').getByRole('button', { name: 'Frida Tools' }));
    expect(await screen.findByRole('dialog', { name: 'Frida Tools details' })).toBeInTheDocument();
    expect(location()).toContain('plugin=frida-tools');

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /details/ })).toBeNull());
    expect(location()).not.toContain('plugin=');
  });

  it('closes on Escape', async () => {
    renderWorkspace(one(), '/ui/plugins?plugin=maps');
    await screen.findByRole('dialog', { name: 'Maps Plugin details' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /details/ })).toBeNull());
  });

  it('says so for a plugin that does not exist, once loading is done', async () => {
    renderWorkspace(one(), '/ui/plugins?plugin=ghost');
    expect(await screen.findByRole('dialog', { name: 'Plugin not found' })).toBeInTheDocument();
    expect(screen.getByText(/No plugin named "ghost"/)).toBeInTheDocument();
  });

  it('does not flash "not found" while the lists are still loading', async () => {
    renderWorkspace(one(), '/ui/plugins?plugin=maps');
    expect(screen.queryByRole('dialog', { name: 'Plugin not found' })).toBeNull();
    await screen.findByRole('dialog', { name: 'Maps Plugin details' });
  });

  it('links to the plugin settings page when it registered one', async () => {
    pluginRegistry.registerSettings('maps', { label: 'Maps', component: () => null } as any);
    renderWorkspace(one(), '/ui/plugins?plugin=maps');
    const dialog = await screen.findByRole('dialog', { name: 'Maps Plugin details' });
    expect(within(dialog).getByRole('link', { name: 'Open settings' })).toHaveAttribute('href', '/ui/settings/plugins/maps/settings');
  });

  it('uninstalls from the drawer through the footprint dialog, then closes the drawer', async () => {
    const { ws, state } = renderWorkspace(one(), '/ui/plugins?plugin=maps');
    state.routes['POST /v1/plugins/uninstall'] = () => {
      state.installed = [];
      return { success: true, restartRequired: true };
    };
    const dialog = await screen.findByRole('dialog', { name: 'Maps Plugin details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    expect(await screen.findByText('Uninstall "maps"?')).toBeInTheDocument();
    expect(calledPaths(ws)).toContain('GET /v1/plugins/maps/uninstall-footprint');
    fireEvent.click(screen.getByTestId('uninstall-keep-data'));
    expect(await screen.findByText('Maps Plugin uninstalled (data kept)')).toBeInTheDocument();
    expect(bodyOf(ws, 'POST', '/v1/plugins/uninstall')).toEqual({ name: 'maps', preserveData: true });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /details/ })).toBeNull());
    expect(location()).not.toContain('plugin=');
    expect(rowNames()).not.toContain('maps');
  });

  it('can uninstall and delete the plugin data too', async () => {
    const { ws, state } = renderWorkspace(one(), '/ui/plugins?plugin=maps');
    state.routes['POST /v1/plugins/uninstall'] = () => {
      state.installed = [];
      return { success: true };
    };
    const dialog = await screen.findByRole('dialog', { name: 'Maps Plugin details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    fireEvent.click(await screen.findByTestId('uninstall-delete-data'));
    expect(await screen.findByText('Maps Plugin uninstalled (data deleted)')).toBeInTheDocument();
    expect(bodyOf(ws, 'POST', '/v1/plugins/uninstall')).toEqual({ name: 'maps', preserveData: false });
  });

  it('shows an error and keeps the plugin when uninstall fails', async () => {
    const { state } = renderWorkspace(one(), '/ui/plugins?plugin=maps');
    state.routes['POST /v1/plugins/uninstall'] = () => ({ success: false, error: 'files are locked' });
    const dialog = await screen.findByRole('dialog', { name: 'Maps Plugin details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    fireEvent.click(await screen.findByTestId('uninstall-keep-data'));
    expect(await screen.findByText('Failed to uninstall Maps Plugin: files are locked')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Maps Plugin details' })).toBeInTheDocument();
  });

  it('stays on Installed after the last plugin is uninstalled, instead of jumping to Discover', async () => {
    const { state } = renderWorkspace(one(), '/ui/plugins?plugin=maps');
    state.routes['POST /v1/plugins/uninstall'] = () => {
      state.installed = [];
      return { success: true };
    };
    const dialog = await screen.findByRole('dialog', { name: 'Maps Plugin details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    fireEvent.click(await screen.findByTestId('uninstall-keep-data'));
    expect(await screen.findByText('No plugins installed.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Installed/ })).toHaveAttribute('aria-selected', 'true');
  });
});

// ── failure handling ─────────────────────────────────────────────────────────

describe('PluginsWorkspace: when a list fails to load', () => {
  it('keeps Installed working when the marketplace is down, and offers a retry on Discover', async () => {
    const state = mockApiState({
      registry: [maps()],
      installed: [installedPlugin({ name: 'maps' })],
      failing: new Set(['GET /v1/plugins/marketplace']),
    });
    renderWorkspace(state);
    await loaded();
    expect(rowNames()).toEqual(['maps']);
    fireEvent.click(screen.getByRole('tab', { name: /Discover/ }));
    expect(await screen.findByText(/Couldn't load the marketplace/)).toBeInTheDocument();
    state.failing.clear();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Couldn't load the marketplace/)).toBeNull());
    expect(rowNames()).toEqual(['maps']);
  });

  it('shows an error with a retry when the installed list fails', async () => {
    const state = mockApiState({ registry: [maps()], failing: new Set(['GET /v1/plugins/installed']) });
    renderWorkspace(state, '/ui/plugins?tab=installed');
    expect(await screen.findByText(/Couldn't load installed plugins/)).toBeInTheDocument();
    state.failing.clear();
    state.installed = [installedPlugin({ name: 'maps' })];
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await loaded();
    expect(rowNames()).toEqual(['maps']);
  });

  it('tells you the Installed tab is empty and points at Discover', async () => {
    renderWorkspace(mockApiState({ registry: [maps()] }), '/ui/plugins?tab=installed');
    expect(await screen.findByText('No plugins installed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browse the marketplace' }));
    expect(location()).toContain('tab=discover');
  });
});

// ── header: refresh and sources ──────────────────────────────────────────────

describe('PluginsWorkspace: header', () => {
  it('shows how fresh the marketplace data is', async () => {
    renderWorkspace(
      mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps' })], fetchedAt: Date.now() - 5 * 60_000 }),
    );
    await loaded();
    expect(await screen.findByTestId('plugins-updated')).toHaveTextContent('Updated 5m ago');
  });

  it('refreshes the marketplace, says so, and pauses the button', async () => {
    const { ws } = renderWorkspace(mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps' })] }));
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Marketplace refreshed')).toBeInTheDocument();
    expect(calledPaths(ws)).toContain('POST /v1/plugins/marketplace/refresh');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });

  it('reports a failed refresh and lets you try again', async () => {
    const { state } = renderWorkspace(mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps' })] }));
    state.failing.add('POST /v1/plugins/marketplace/refresh');
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Could not refresh the marketplace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('opens the source manager and closes it again', async () => {
    const { ws } = renderWorkspace(mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps' })] }));
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
    expect(await screen.findByText('Plugin Sources')).toBeInTheDocument();
    expect(calledPaths(ws)).toContain('GET /v1/plugins/sources');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Plugin Sources')).toBeNull());
  });

  it('adding a source busts the marketplace cache and leaves the dialog open', async () => {
    // The server caches the marketplace for an hour and add() does not clear it,
    // so a cached reload would show nothing from the new source until Refresh.
    const { ws } = renderWorkspace(mockApiState({ registry: [maps()], installed: [installedPlugin({ name: 'maps' })] }));
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
    await screen.findByText('Plugin Sources');
    fireEvent.click(screen.getByRole('button', { name: 'Add Source' }));
    fireEvent.change(screen.getByPlaceholderText('My Plugin Registry'), { target: { value: 'Team registry' } });
    const urlInput = document.querySelectorAll('.source-add-form input[type="text"]')[1] as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: 'https://example.com/registry.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Source' }));
    await waitFor(() => expect(calledPaths(ws)).toContain('POST /v1/plugins/marketplace/refresh'));
    expect(screen.getByText('Plugin Sources')).toBeInTheDocument();
  });
});
