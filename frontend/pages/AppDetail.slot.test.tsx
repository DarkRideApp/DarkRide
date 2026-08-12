import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WebSocketContext, ToastProvider, pluginRegistry } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { AppDetail } from './AppDetail';

/**
 * `app-detail:panels` is the first extension point on this page, and a slot id
 * plus its prop names are API surface: once a plugin contributes to it, neither
 * can change without breaking that plugin. These tests exist so a rename or a
 * dropped prop fails here rather than in someone's plugin.
 *
 * Its first consumer is the private appwatch publisher plugin, which renders a
 * per-app "publish to ThemeParks.wiki" toggle into it.
 */

const app = {
  id: 1, packageName: 'com.disney.shanghai', appName: 'Shanghai Disney', autoFetchPlayStore: true,
  createdAt: '2026-01-01T00:00:00Z', versionCount: 0,
  latestVersion: null, latestAnalysis: null,
};

function mockWs(): WebSocketContextValue {
  return {
    connected: true, serverReady: true, startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((_method: string, path: string) => {
      if (path === '/v1/apps/tracked') return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: [app] } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderDetail() {
  render(
    <WebSocketContext.Provider value={mockWs()}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/ui/apps/1']}>
          <Routes>
            <Route path="/ui/apps/:trackedAppId" element={<AppDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
}

describe('AppDetail — app-detail:panels slot', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('declares the slot on the registry', () => {
    // Importing AppDetail runs the module-scope registerUiSlots call.
    const slot = pluginRegistry.getAllSlots().find(s => s.id === 'app-detail:panels');
    expect(slot, 'app-detail:panels is not declared').toBeDefined();
    expect(slot!.plugin).toBe('core');
    // A description is what a plugin author reads to decide whether this is the
    // right slot, so an empty one makes the slot undiscoverable.
    expect(slot!.description).toBeTruthy();
  });

  it('renders a contribution and forwards the app as props', async () => {
    const seen: Record<string, unknown>[] = [];
    // Two calls, as a real plugin does it: the contribution names its component
    // as a STRING, and the component itself is registered separately. Passing a
    // function here resolves to nothing and the registry warns.
    pluginRegistry.registerContributionComponents('test-plugin', {
      TestPanel: (props: Record<string, unknown>) => {
        seen.push(props);
        return <div data-testid="contributed-panel">panel for {String(props.packageName)}</div>;
      },
    } as any);
    pluginRegistry.registerUiContributions('test-plugin', [
      { slot: 'app-detail:panels', id: 'test:panel', component: 'TestPanel' } as any,
    ]);

    renderDetail();

    await waitFor(() => expect(screen.getByTestId('contributed-panel')).toBeTruthy());
    expect(screen.getByTestId('contributed-panel').textContent).toContain('com.disney.shanghai');

    // The prop contract. A contribution that only receives trackedAppId would
    // have to refetch the app just to know its package name.
    expect(seen[0]).toMatchObject({
      trackedAppId: 1,
      packageName: 'com.disney.shanghai',
      appName: 'Shanghai Disney',
    });
  });

  it('does not warn about an undeclared slot', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByTestId('app-detail')).toBeTruthy());
    const undeclared = warn.mock.calls.filter(c => String(c[0]).includes('[ExtensionSlot]'));
    expect(undeclared, 'ExtensionSlot warned — the slot is mounted but not declared').toEqual([]);
  });

  it('renders nothing when no plugin contributes', async () => {
    // pluginRegistry is a module-level singleton, so a contribution registered by
    // an earlier test is still there. Disabling the plugin is the real mechanism
    // for "this contribution should not render", and it keeps this test
    // independent of run order rather than relying on it.
    pluginRegistry.setDisabledPlugins(['test-plugin']);
    try {
      renderDetail();
      await waitFor(() => expect(screen.getByTestId('app-detail')).toBeTruthy());
      expect(screen.queryByTestId('contributed-panel')).toBeNull();
    } finally {
      pluginRegistry.setDisabledPlugins([]);
    }
  });
});
