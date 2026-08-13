import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';
import { AppLibrary } from './AppLibrary';

const apps = [
  {
    id: 1, packageName: 'com.disney.shanghai', appName: 'Shanghai Disney', autoFetchPlayStore: true,
    createdAt: '2026-01-01T00:00:00Z', versionCount: 12,
    latestVersion: { id: 100, trackedAppId: 1, versionCode: 114002, versionName: '11.4.0', filename: 'x.apk', fileSize: 148897792, deviceId: null, source: 'playstore', downloadedAt: '2026-06-10T08:00:00Z' },
    latestAnalysis: { status: 'running', stage: 'decompiling', error: null },
  },
  {
    id: 2, packageName: 'jp.tokyodisneyresort.portalapp', appName: 'Tokyo Disney', autoFetchPlayStore: false,
    createdAt: '2026-01-01T00:00:00Z', versionCount: 8,
    latestVersion: { id: 90, trackedAppId: 2, versionCode: 30201, versionName: '3.2.1', filename: 'y.apk', fileSize: 93323264, deviceId: 'pixel7', source: 'device', downloadedAt: '2026-06-09T08:00:00Z' },
    latestAnalysis: { status: 'completed', stage: 'done', error: null },
  },
];

function mockWs(data = apps): WebSocketContextValue {
  return {
    connected: true, serverReady: true, startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (path === '/v1/apps/tracked') return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data } });
      if (path === '/v1/apps/analysis-jobs/recent') return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: [] } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderLibrary(ws = mockWs(), initialEntry = '/ui/apks') {
  render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/ui/apks" element={<AppLibrary />} />
            <Route path="/ui/apps/:trackedAppId" element={<div data-testid="detail-page" />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
  return ws;
}

describe('AppLibrary', () => {
  beforeEach(() => localStorage.clear());

  it('renders rows sorted by recently updated by default', async () => {
    renderLibrary();
    await waitFor(() => expect(screen.getAllByTestId(/^app-row-/)).toHaveLength(2));
    const rows = screen.getAllByTestId(/^app-row-/);
    expect(within(rows[0]).getByText('Shanghai Disney')).toBeInTheDocument(); // newer first
    expect(within(rows[0]).getByText(/Decompiling/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('Ready')).toBeInTheDocument();
  });

  it('filters by search across name and package', async () => {
    renderLibrary();
    await waitFor(() => screen.getAllByTestId(/^app-row-/));
    fireEvent.change(screen.getByTestId('app-filter-input'), { target: { value: 'tokyodisney' } });
    expect(screen.getAllByTestId(/^app-row-/)).toHaveLength(1);
    expect(screen.getByText('Tokyo Disney')).toBeInTheDocument();
  });

  it('navigates to detail on row click', async () => {
    renderLibrary();
    await waitFor(() => screen.getByTestId('app-row-1'));
    fireEvent.click(screen.getByTestId('app-row-1'));
    expect(screen.getByTestId('detail-page')).toBeInTheDocument();
  });

  it('untracks via kebab with confirmation', async () => {
    const ws = renderLibrary();
    await waitFor(() => screen.getByTestId('app-row-1'));
    fireEvent.click(within(screen.getByTestId('app-row-1')).getByRole('button', { name: 'App actions' }));
    fireEvent.click(screen.getByTestId('menu-item-untrack'));
    // ConfirmDialog is passed confirmLabel="Untrack", so the confirm button reads "Untrack".
    fireEvent.click(screen.getByRole('button', { name: /untrack/i }));
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('DELETE', '/v1/apps/track/1'));
  });

  it('sorts by name when the sort select changes', async () => {
    renderLibrary();
    await waitFor(() => expect(screen.getAllByTestId(/^app-row-/)).toHaveLength(2));
    fireEvent.change(screen.getByTestId('app-sort-select'), { target: { value: 'name' } });
    const rows = screen.getAllByTestId(/^app-row-/);
    // 'Shanghai Disney' < 'Tokyo Disney' alphabetically → Shanghai first.
    expect(within(rows[0]).getByText('Shanghai Disney')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Tokyo Disney')).toBeInTheDocument();
  });

  it('rejects an Add App package without a dot', async () => {
    const ws = renderLibrary();
    await waitFor(() => screen.getByTestId('add-app-btn'));
    fireEvent.click(screen.getByTestId('add-app-btn'));
    fireEvent.change(screen.getByTestId('add-app-package-input'), { target: { value: 'nodothere' } });
    fireEvent.click(screen.getByTestId('add-app-submit-btn'));
    expect(screen.getByTestId('add-app-error')).toHaveTextContent(/at least one dot/i);
    expect(ws.sendRestApi).not.toHaveBeenCalledWith('POST', '/v1/apps/track', expect.anything());
  });

  it('renders store checkboxes from /v1/apps/sources and submits the selection + fetch flag', async () => {
    const sources = [
      { source: 'playstore', label: 'Play Store', defaultEnabled: true },
      { source: 'qq', label: 'QQ (应用宝)', defaultEnabled: false },
    ];
    const ws = mockWs([]);
    (ws.sendRestApi as any).mockImplementation((method: string, path: string) => {
      if (path === '/v1/apps/sources') return Promise.resolve({ type: 'restapi', id: 's', status: 200, body: { success: true, data: sources } });
      if (method === 'POST' && path === '/v1/apps/track') return Promise.resolve({ type: 'restapi', id: 't', status: 201, body: { success: true, data: { id: 5 } } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    });
    renderLibrary(ws);

    await waitFor(() => screen.getByTestId('add-app-empty-btn'));
    fireEvent.click(screen.getByTestId('add-app-empty-btn'));

    // Checkboxes appear from the registry; defaults match each source's defaultEnabled.
    await waitFor(() => screen.getByTestId('add-app-source-qq'));
    const playstoreCb = screen.getByTestId('add-app-source-playstore') as HTMLInputElement;
    const qqCb = screen.getByTestId('add-app-source-qq') as HTMLInputElement;
    expect(playstoreCb.checked).toBe(true);
    expect(qqCb.checked).toBe(false);

    // Enable QQ, fill the package, submit.
    fireEvent.click(qqCb);
    fireEvent.change(screen.getByTestId('add-app-package-input'), { target: { value: 'com.hytch.ftthemepark' } });
    fireEvent.click(screen.getByTestId('add-app-submit-btn'));

    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/apps/track', {
      packageName: 'com.hytch.ftthemepark', appName: null, sources: { playstore: true, qq: true }, fetch: true,
      autoAnalyse: false,
    }));
  });

  it('navigates on Enter keypress for keyboard users', async () => {
    renderLibrary();
    await waitFor(() => screen.getByTestId('app-row-1'));
    fireEvent.keyDown(screen.getByTestId('app-row-1'), { key: 'Enter' });
    expect(screen.getByTestId('detail-page')).toBeInTheDocument();
  });

  it('opens the activity panel for legacy ?tab=analysis links', async () => {
    renderLibrary(mockWs(), '/ui/apks?tab=analysis');
    await waitFor(() => expect(screen.getByTestId('activity-panel')).toBeInTheDocument());
  });

  it('shows empty state with Add and Upload entry points', async () => {
    renderLibrary(mockWs([]));
    await waitFor(() => expect(screen.getByText('No tracked apps')).toBeInTheDocument());
    expect(screen.getByTestId('add-app-empty-btn')).toBeInTheDocument();
    expect(screen.getByTestId('upload-empty-btn')).toBeInTheDocument();
  });

  it('keeps the activity chip reachable in the empty state', async () => {
    renderLibrary(mockWs([]));
    await waitFor(() => expect(screen.getByText('No tracked apps')).toBeInTheDocument());
    expect(screen.getByTestId('activity-chip')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('activity-chip'));
    await waitFor(() => expect(screen.getByTestId('activity-panel')).toBeInTheDocument());
  });
});

/**
 * `add-app:options` is the first slot whose contributions can ACT rather than
 * only render: they register a callback that core runs once the app exists.
 * The id, the prop names and that lifecycle are API surface — a plugin breaks
 * if any of them change — so they are asserted here rather than left to a
 * plugin's own tests, which cannot fail this repo.
 */
describe('AppLibrary — add-app:options slot', () => {
  function wsForAdd(created: any = { id: 5, packageName: 'com.new.app', appName: null }, ok = true) {
    const ws = mockWs([]);
    (ws.sendRestApi as any).mockImplementation((method: string, path: string) => {
      if (path === '/v1/apps/sources') return Promise.resolve({ type: 'restapi', id: 's', status: 200, body: { success: true, data: [] } });
      if (method === 'POST' && path === '/v1/apps/track') {
        return ok
          ? Promise.resolve({ type: 'restapi', id: 't', status: 201, body: { success: true, data: created } })
          : Promise.resolve({ type: 'restapi', id: 't', status: 400, body: { success: false, error: 'nope' } });
      }
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    });
    return ws;
  }

  async function openAndSubmit(pkg = 'com.new.app') {
    await waitFor(() => screen.getByTestId('add-app-empty-btn'));
    fireEvent.click(screen.getByTestId('add-app-empty-btn'));
    await waitFor(() => screen.getByTestId('add-app-package-input'));
    fireEvent.change(screen.getByTestId('add-app-package-input'), { target: { value: pkg } });
    fireEvent.click(screen.getByTestId('add-app-submit-btn'));
  }

  /** Registers a contribution that captures its props and records callbacks. */
  function contribute(name: string, onCreated?: (app: any) => void | Promise<void>) {
    const seen: Record<string, unknown>[] = [];
    pluginRegistry.registerContributionComponents('test-plugin', {
      [name]: (props: any) => {
        seen.push(props);
        // Real contributions register from an effect, not during render.
        useEffect(() => {
          if (onCreated) props.registerOnCreated(onCreated);
        }, [props.registerOnCreated]);
        return <div data-testid="contributed-option">option for {String(props.packageName)}</div>;
      },
    } as any);
    pluginRegistry.registerUiContributions('test-plugin', [
      { slot: 'add-app:options', id: 'test:option', component: name } as any,
    ]);
    return seen;
  }

  beforeEach(() => {
    localStorage.clear();
    pluginRegistry.setDisabledPlugins([]);
  });

  it('declares the slot with a usable description', () => {
    const slot = pluginRegistry.getAllSlots().find(s => s.id === 'add-app:options');
    expect(slot, 'add-app:options is not declared').toBeDefined();
    expect(slot!.plugin).toBe('core');
    // A plugin author reads this to know the callback exists at all.
    expect(slot!.description).toMatch(/registerOnCreated/);
  });

  it('renders a contribution and passes the package name as it is typed', async () => {
    const seen = contribute('OptA');
    renderLibrary(wsForAdd());
    await waitFor(() => screen.getByTestId('add-app-empty-btn'));
    fireEvent.click(screen.getByTestId('add-app-empty-btn'));
    await waitFor(() => screen.getByTestId('contributed-option'));

    fireEvent.change(screen.getByTestId('add-app-package-input'), { target: { value: 'com.typed.app' } });
    await waitFor(() => expect(screen.getByTestId('contributed-option').textContent).toContain('com.typed.app'));
    expect(seen[0]).toHaveProperty('registerOnCreated');
    expect(typeof (seen[0] as any).registerOnCreated).toBe('function');
  });

  it('invokes a registered callback with the created app, and awaits it', async () => {
    const order: string[] = [];
    const cb = vi.fn(async (app: any) => {
      await Promise.resolve();
      order.push(`cb:${app.packageName}`);
    });
    contribute('OptB', cb);
    renderLibrary(wsForAdd({ id: 7, packageName: 'com.new.app', appName: null }));
    await openAndSubmit();

    await waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    expect(cb.mock.calls[0][0]).toMatchObject({ id: 7, packageName: 'com.new.app' });
    expect(order).toEqual(['cb:com.new.app']);
  });

  it('does NOT invoke callbacks when the add fails', async () => {
    // Enabling a plugin setting for an app that was never created would leave
    // the plugin holding state for something that does not exist.
    const cb = vi.fn();
    contribute('OptC', cb);
    renderLibrary(wsForAdd(undefined, false));
    await openAndSubmit();

    await waitFor(() => screen.getByTestId('add-app-error'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('a throwing callback does not cost the operator the app', async () => {
    const boom = vi.fn(() => { throw new Error('plugin exploded'); });
    const after = vi.fn();
    contribute('OptD', boom as any);
    // A second contribution proves one failure does not skip the rest.
    pluginRegistry.registerContributionComponents('other-plugin', {
      OptE: (props: any) => {
        useEffect(() => { props.registerOnCreated(after); }, [props.registerOnCreated]);
        return null;
      },
    } as any);
    pluginRegistry.registerUiContributions('other-plugin', [
      { slot: 'add-app:options', id: 'other:option', component: 'OptE' } as any,
    ]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderLibrary(wsForAdd());
    await openAndSubmit();

    await waitFor(() => expect(boom).toHaveBeenCalled());
    expect(after, 'a failing plugin blocked the next one').toHaveBeenCalled();
    // The add still succeeded: the modal closed.
    await waitFor(() => expect(screen.queryByTestId('add-app-package-input')).toBeNull());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    pluginRegistry.setDisabledPlugins(['other-plugin']);
  });

  it('forgets callbacks between opens', async () => {
    // Otherwise the second app added in a session gets the first app's
    // callbacks, applied to the wrong app.
    const cb = vi.fn();
    contribute('OptF', cb);
    renderLibrary(wsForAdd());
    await openAndSubmit('com.first.app');
    await waitFor(() => expect(cb).toHaveBeenCalledTimes(1));

    pluginRegistry.setDisabledPlugins(['test-plugin']);   // contribution goes away
    fireEvent.click(screen.getByTestId('add-app-empty-btn'));
    await waitFor(() => screen.getByTestId('add-app-package-input'));
    fireEvent.change(screen.getByTestId('add-app-package-input'), { target: { value: 'com.second.app' } });
    fireEvent.click(screen.getByTestId('add-app-submit-btn'));

    await waitFor(() => expect(screen.queryByTestId('add-app-package-input')).toBeNull());
    expect(cb, 'a stale callback fired for a later app').toHaveBeenCalledTimes(1);
  });
});

describe('AppLibrary — auto-analyse', () => {
  beforeEach(() => { localStorage.clear(); pluginRegistry.setDisabledPlugins(['test-plugin', 'other-plugin']); });

  it('defaults to off and sends the operator choice', async () => {
    const ws = mockWs([]);
    (ws.sendRestApi as any).mockImplementation((method: string, path: string) => {
      if (path === '/v1/apps/sources') return Promise.resolve({ type: 'restapi', id: 's', status: 200, body: { success: true, data: [] } });
      if (method === 'POST' && path === '/v1/apps/track') return Promise.resolve({ type: 'restapi', id: 't', status: 201, body: { success: true, data: { id: 9 } } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    });
    renderLibrary(ws);

    await waitFor(() => screen.getByTestId('add-app-empty-btn'));
    fireEvent.click(screen.getByTestId('add-app-empty-btn'));
    await waitFor(() => screen.getByTestId('add-app-auto-analyse'));

    // Off by default: tracking a version must stay cheap, per migration 0098.
    const cb = screen.getByTestId('add-app-auto-analyse') as HTMLInputElement;
    expect(cb.checked).toBe(false);

    fireEvent.click(cb);
    fireEvent.change(screen.getByTestId('add-app-package-input'), { target: { value: 'com.analyse.me' } });
    fireEvent.click(screen.getByTestId('add-app-submit-btn'));

    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/apps/track',
      expect.objectContaining({ packageName: 'com.analyse.me', autoAnalyse: true })));
  });

  it('resets to off when the modal is reopened', async () => {
    const ws = mockWs([]);
    (ws.sendRestApi as any).mockImplementation((method: string, path: string) => {
      if (path === '/v1/apps/sources') return Promise.resolve({ type: 'restapi', id: 's', status: 200, body: { success: true, data: [] } });
      if (method === 'POST' && path === '/v1/apps/track') return Promise.resolve({ type: 'restapi', id: 't', status: 201, body: { success: true, data: { id: 9 } } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    });
    renderLibrary(ws);
    await waitFor(() => screen.getByTestId('add-app-empty-btn'));

    fireEvent.click(screen.getByTestId('add-app-empty-btn'));
    await waitFor(() => screen.getByTestId('add-app-auto-analyse'));
    fireEvent.click(screen.getByTestId('add-app-auto-analyse'));
    fireEvent.change(screen.getByTestId('add-app-package-input'), { target: { value: 'com.one.app' } });
    fireEvent.click(screen.getByTestId('add-app-submit-btn'));
    await waitFor(() => expect(screen.queryByTestId('add-app-package-input')).toBeNull());

    fireEvent.click(screen.getByTestId('add-app-empty-btn'));
    await waitFor(() => screen.getByTestId('add-app-auto-analyse'));
    expect((screen.getByTestId('add-app-auto-analyse') as HTMLInputElement).checked,
      'the previous add\'s choice leaked into the next one').toBe(false);
  });
});
