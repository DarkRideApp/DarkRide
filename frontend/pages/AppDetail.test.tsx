import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { AppDetail } from './AppDetail';

vi.mock('../utils/upload', () => ({ uploadApk: vi.fn() }));
import { uploadApk } from '../utils/upload';

const app = {
  id: 1, packageName: 'com.disney.shanghai', appName: 'Shanghai Disney', autoFetchPlayStore: true,
  createdAt: '2026-01-01T00:00:00Z', versionCount: 2,
  latestVersion: { id: 100, trackedAppId: 1, versionCode: 114002, versionName: '11.4.0', filename: 'a.apk', fileSize: 1000, deviceId: null, source: 'playstore', downloadedAt: '2026-06-10T08:00:00Z' },
  latestAnalysis: { status: 'completed', stage: 'done', error: null },
};
const versions = [
  { id: 100, trackedAppId: 1, versionCode: 114002, versionName: '11.4.0', filename: 'a.apk', fileSize: 1000, deviceId: null, source: 'playstore', downloadedAt: '2026-06-10T08:00:00Z', availability: 'local', analysis: { status: 'completed', stage: 'done', error: null, aiRunning: false } },
  { id: 99, trackedAppId: 1, versionCode: 113008, versionName: '11.3.0', filename: 'b.apk', fileSize: 900, deviceId: 'pixel7', source: 'device', downloadedAt: '2026-03-02T08:00:00Z', availability: 'local', analysis: null },
];
const injected = [
  { id: 7, packageName: 'com.disney.shanghai', versionCode: 113008, fridaVersion: '17.2.1', createdAt: '2026-03-03T08:00:00Z' },
  { id: 8, packageName: 'com.disney.shanghai', versionCode: 50, fridaVersion: '17.0.0', createdAt: '2026-01-03T08:00:00Z' },
];

function mockWs(): WebSocketContextValue {
  return {
    connected: true, serverReady: true, startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (path === '/v1/apps/tracked') return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: [app] } });
      if (path === '/v1/apps/versions/1') return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: versions } });
      if (path === '/v1/frida/gadget/injected') return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: injected } });
      if (path === '/v1/device/list') return Promise.resolve({ type: 'restapi', id: '6', status: 200, body: { success: true, data: [] } });
      if (path === '/v1/apps/analysis-jobs/recent') return Promise.resolve({ type: 'restapi', id: '7', status: 200, body: { success: true, data: [] } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderDetail(ws = mockWs()) {
  render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/ui/apps/1']}>
          <Routes>
            <Route path="/ui/apps/:trackedAppId" element={<AppDetail />} />
            <Route path="/ui/apps/:trackedAppId/analysis/:versionId" element={<div data-testid="analysis-page" />} />
            <Route path="/ui/apks" element={<div data-testid="library-page" />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
  return ws;
}

describe('AppDetail', () => {
  it('applies a live analysis-update to a version that started unanalysed', async () => {
    // The page has multiple subscribers to each event (AppDetail itself plus the
    // embedded ActivityChip's hook), so collect them all and broadcast like the
    // real WS does — otherwise the last subscriber would mask the others.
    const handlers: Record<string, ((msg: any) => void)[]> = {};
    const ws = { ...mockWs(), subscribe: vi.fn((evt: string, cb: (msg: any) => void) => { (handlers[evt] ||= []).push(cb); return () => {}; }) } as any;
    renderDetail(ws);
    // Version 99 starts with analysis: null → shows the "Analyze" button.
    await waitFor(() => within(screen.getByTestId('version-row-99')).getByRole('button', { name: 'Analyze' }));
    // A WS update for v99 (e.g. analysis triggered from the Activity panel) updates the row live.
    act(() => handlers['apk:analysis-update'].forEach(cb => cb({ apkVersionId: 99, status: 'running', stage: 'decompiling', error: null })));
    await waitFor(() =>
      expect(within(screen.getByTestId('version-row-99')).getByRole('button', { name: /Decompiling/ })).toBeDisabled(),
    );
  });

  it('navigates to the filed-under app when an uploaded APK is a different package', async () => {
    // Upload returns a different trackedAppId (the APK was a different package).
    vi.mocked(uploadApk).mockResolvedValue({ success: true, status: 200, data: { id: 5, trackedAppId: 99, packageName: 'com.other', versionCode: 1, versionName: null } });
    renderDetail(); // current app id is 1
    await waitFor(() => screen.getByTestId('upload-version-btn'));
    fireEvent.click(screen.getByTestId('upload-version-btn'));
    fireEvent.change(screen.getByTestId('upload-file-input'), {
      target: { files: [new File(['PK'], 'other.apk', { type: 'application/octet-stream' })] },
    });
    fireEvent.click(screen.getByTestId('upload-submit-btn'));
    // Navigated to /ui/apps/99, which isn't in the mock → renders "App not found".
    await waitFor(() => expect(screen.getByText(/app not found/i)).toBeInTheDocument());
  });

  it('renders header identity, stats and PS switch', async () => {
    renderDetail();
    // The app name appears in both the breadcrumb and the header card; assert the header one.
    await waitFor(() => expect(screen.getByTestId('app-detail-name')).toHaveTextContent('Shanghai Disney'));
    expect(screen.getByText('com.disney.shanghai')).toBeInTheDocument();
    expect(screen.getByText(/2 versions/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /auto-fetch from play store/i })).toBeChecked();
  });

  it('marks the newest version row with a Latest badge', async () => {
    renderDetail();
    await waitFor(() => screen.getByTestId('version-row-100'));
    expect(within(screen.getByTestId('version-row-100')).getByText('Latest')).toBeInTheDocument();
    expect(within(screen.getByTestId('version-row-99')).queryByText('Latest')).not.toBeInTheDocument();
  });

  it('shows Open Analysis for completed, Analyze for unanalyzed', async () => {
    renderDetail();
    await waitFor(() => screen.getByTestId('version-row-100'));
    await waitFor(() => expect(within(screen.getByTestId('version-row-100')).getByRole('button', { name: 'Open Analysis' })).toBeInTheDocument());
    expect(within(screen.getByTestId('version-row-99')).getByRole('button', { name: 'Analyze' })).toBeInTheDocument();
  });

  it('navigates to analysis from the primary action', async () => {
    renderDetail();
    await waitFor(() => screen.getByTestId('version-row-100'));
    await waitFor(() => within(screen.getByTestId('version-row-100')).getByRole('button', { name: 'Open Analysis' }));
    fireEvent.click(within(screen.getByTestId('version-row-100')).getByRole('button', { name: 'Open Analysis' }));
    expect(screen.getByTestId('analysis-page')).toBeInTheDocument();
  });

  it('nests injected builds under their version and lists orphans separately', async () => {
    renderDetail();
    await waitFor(() => screen.getByTestId('injected-row-7'));
    expect(screen.getByText(/frida 17.2.1/)).toBeInTheDocument();
    expect(screen.getByTestId('orphaned-injected')).toBeInTheDocument();
    expect(within(screen.getByTestId('orphaned-injected')).getByTestId('injected-row-8')).toBeInTheDocument();
  });

  it('deletes a version through kebab + confirm', async () => {
    const ws = renderDetail();
    await waitFor(() => screen.getByTestId('version-row-99'));
    fireEvent.click(within(screen.getByTestId('version-row-99')).getByRole('button', { name: 'Version actions' }));
    fireEvent.click(screen.getByTestId('menu-item-delete'));
    // Click the ConfirmDialog's confirm button specifically (injected rows also have Delete buttons).
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('DELETE', '/v1/apps/version/99'));
  });

  it('toggles Play Store auto-fetch', async () => {
    const ws = renderDetail();
    await waitFor(() => screen.getByRole('switch', { name: /auto-fetch/i }));
    fireEvent.click(screen.getByRole('switch', { name: /auto-fetch/i }));
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('PATCH', '/v1/apps/track/1', { autoFetchPlayStore: false }));
  });

  it('shows not-found state for unknown app id', async () => {
    const ws = mockWs();
    (ws.sendRestApi as any).mockImplementation((m: string, path: string) =>
      Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: path === '/v1/apps/tracked' ? [] : [] } }));
    renderDetail(ws);
    await waitFor(() => expect(screen.getByText(/app not found/i)).toBeInTheDocument());
  });

  it('untracks the app via the settings menu and returns to the library', async () => {
    const ws = renderDetail();
    await waitFor(() => screen.getByTestId('app-detail'));
    fireEvent.click(screen.getByRole('button', { name: 'App settings' }));
    fireEvent.click(screen.getByTestId('menu-item-untrack'));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('DELETE', '/v1/apps/track/1'));
    await waitFor(() => expect(screen.getByTestId('library-page')).toBeInTheDocument());
  });
});
