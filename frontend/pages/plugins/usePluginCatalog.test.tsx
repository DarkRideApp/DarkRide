import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePluginCatalog } from './usePluginCatalog';
import {
  createMockWs,
  mockApiState,
  withProviders,
  registryPlugin,
  installedPlugin,
  calledPaths,
} from './testing';

function setup(state = mockApiState()) {
  const ws = createMockWs(state);
  const view = renderHook(() => usePluginCatalog(), { wrapper: withProviders(ws) });
  return { ws, state, ...view };
}

describe('usePluginCatalog', () => {
  it('loads both lists and joins them into entries', async () => {
    const { result } = setup(
      mockApiState({
        registry: [registryPlugin({ name: 'maps', displayName: 'Maps Plugin' }), registryPlugin({ name: 'frida-tools' })],
        installed: [installedPlugin({ name: 'maps' })],
        fetchedAt: 1_700_000_000_000,
      }),
    );
    expect(result.current.installedLoading).toBe(true);
    await waitFor(() => expect(result.current.installedLoading).toBe(false));
    await waitFor(() => expect(result.current.registryLoading).toBe(false));
    expect(result.current.entries.map(e => e.name).sort()).toEqual(['frida-tools', 'maps']);
    expect(result.current.entries.find(e => e.name === 'maps')!.displayName).toBe('Maps Plugin');
    expect(result.current.fetchedAt).toBe(1_700_000_000_000);
    expect(result.current.installedError).toBeNull();
    expect(result.current.registryError).toBeNull();
  });

  it('keeps the installed list working when the marketplace fails', async () => {
    const { result } = setup(
      mockApiState({
        installed: [installedPlugin({ name: 'maps' }), installedPlugin({ name: 'local', npmPackage: null, installedVia: 'workspace' })],
        failing: new Set(['GET /v1/plugins/marketplace']),
      }),
    );
    await waitFor(() => expect(result.current.registryLoading).toBe(false));
    await waitFor(() => expect(result.current.installedLoading).toBe(false));
    expect(result.current.registryError).toMatch(/failed/);
    expect(result.current.installedError).toBeNull();
    expect(result.current.entries.map(e => e.name).sort()).toEqual(['local', 'maps']);
  });

  it('keeps the registry working when the installed list fails', async () => {
    const { result } = setup(
      mockApiState({
        registry: [registryPlugin({ name: 'maps' })],
        failing: new Set(['GET /v1/plugins/installed']),
      }),
    );
    await waitFor(() => expect(result.current.installedLoading).toBe(false));
    await waitFor(() => expect(result.current.registryLoading).toBe(false));
    expect(result.current.installedError).toMatch(/failed/);
    expect(result.current.entries.map(e => e.name)).toEqual(['maps']);
  });

  it('reports a thrown websocket error as an error, not an endless spinner', async () => {
    const ws = createMockWs(mockApiState());
    (ws.sendRestApi as any).mockRejectedValue(new Error('socket closed'));
    const { result } = renderHook(() => usePluginCatalog(), { wrapper: withProviders(ws) });
    await waitFor(() => expect(result.current.installedLoading).toBe(false));
    await waitFor(() => expect(result.current.registryLoading).toBe(false));
    expect(result.current.installedError).toBeTruthy();
    expect(result.current.registryError).toBeTruthy();
  });

  it('fetches scope-status only for loaded plugins', async () => {
    const { ws, result } = setup(
      mockApiState({
        installed: [
          installedPlugin({ name: 'live', loaded: true }),
          installedPlugin({ name: 'pending', loaded: false }),
          installedPlugin({ name: 'gone', loaded: false, installedVia: 'missing' }),
        ],
      }),
    );
    await waitFor(() => expect(result.current.scopeStatuses.live).toBeDefined());
    const paths = calledPaths(ws);
    expect(paths).toContain('GET /v1/plugins/live/scope-status');
    expect(paths.some(p => p.includes('/pending/'))).toBe(false);
    expect(paths.some(p => p.includes('/gone/'))).toBe(false);
  });

  it('exposes scope-status fields from the top level of the response body', async () => {
    const { result } = setup(
      mockApiState({
        installed: [installedPlugin({ name: 'ai' })],
        scopeStatus: {
          ai: { success: true, state: 'unconsented', manifestScopes: ['ai.chat'], approvedScopes: null, added: [{ key: 'ai.chat' }], removed: [] },
        },
      }),
    );
    await waitFor(() => expect(result.current.scopeStatuses.ai?.state).toBe('unconsented'));
    expect(result.current.scopeStatuses.ai.manifestScopes).toEqual(['ai.chat']);
  });

  it('reloadInstalled picks up changes and refreshes scope-status', async () => {
    const { ws, state, result } = setup(mockApiState({ installed: [installedPlugin({ name: 'a' })] }));
    await waitFor(() => expect(result.current.installedLoading).toBe(false));
    state.installed = [installedPlugin({ name: 'a' }), installedPlugin({ name: 'b' })];
    await act(async () => {
      await result.current.reloadInstalled();
    });
    expect(result.current.entries.map(e => e.name).sort()).toEqual(['a', 'b']);
    await waitFor(() => expect(calledPaths(ws)).toContain('GET /v1/plugins/b/scope-status'));
  });

  it('does not show the loading state again on a reload, so the list does not blank out', async () => {
    const state = mockApiState({ installed: [installedPlugin({ name: 'a' })] });
    const ws = createMockWs(state);
    const rendered: boolean[] = [];
    const { result } = renderHook(
      () => {
        const c = usePluginCatalog();
        rendered.push(c.installedLoading);
        return c;
      },
      { wrapper: withProviders(ws) },
    );
    await waitFor(() => expect(result.current.installedLoading).toBe(false));
    rendered.length = 0;
    state.installed = [installedPlugin({ name: 'a' }), installedPlugin({ name: 'b' })];
    await act(async () => {
      await result.current.reloadInstalled();
    });
    expect(result.current.entries).toHaveLength(2);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.every(loading => loading === false)).toBe(true);
  });

  it('refreshRegistry busts the cache, updates the list and returns true', async () => {
    const { ws, state, result } = setup(mockApiState({ registry: [registryPlugin({ name: 'old' })] }));
    await waitFor(() => expect(result.current.registryLoading).toBe(false));
    state.registry = [registryPlugin({ name: 'old' }), registryPlugin({ name: 'new' })];
    state.fetchedAt = 1_800_000_000_000;
    let ok = false;
    await act(async () => {
      ok = await result.current.refreshRegistry();
    });
    expect(ok).toBe(true);
    expect(calledPaths(ws)).toContain('POST /v1/plugins/marketplace/refresh');
    // The backend recomputes updateAvailable against the fresh cache, so installed is fetched again.
    expect(calledPaths(ws).filter(p => p === 'GET /v1/plugins/installed').length).toBeGreaterThanOrEqual(2);
    expect(result.current.entries.map(e => e.name).sort()).toEqual(['new', 'old']);
    expect(result.current.fetchedAt).toBe(1_800_000_000_000);
  });

  it('refreshRegistry returns false and keeps the old list when the refresh fails', async () => {
    const { state, result } = setup(mockApiState({ registry: [registryPlugin({ name: 'old' })] }));
    await waitFor(() => expect(result.current.registryLoading).toBe(false));
    state.failing.add('POST /v1/plugins/marketplace/refresh');
    let ok = true;
    await act(async () => {
      ok = await result.current.refreshRegistry();
    });
    expect(ok).toBe(false);
    expect(result.current.entries.map(e => e.name)).toEqual(['old']);
  });

  it('reloadRegistry clears a previous error on success', async () => {
    const { state, result } = setup(mockApiState({ registry: [registryPlugin({ name: 'maps' })], failing: new Set(['GET /v1/plugins/marketplace']) }));
    await waitFor(() => expect(result.current.registryError).toBeTruthy());
    state.failing.clear();
    await act(async () => {
      await result.current.reloadRegistry();
    });
    expect(result.current.registryError).toBeNull();
    expect(result.current.entries.map(e => e.name)).toEqual(['maps']);
  });
});
