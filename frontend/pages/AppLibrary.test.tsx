import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
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
});
