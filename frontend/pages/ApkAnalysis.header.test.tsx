import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ApkAnalysis } from './ApkAnalysis';

const overview = {
  appName: 'Shanghai Disney', packageName: 'com.disney.shanghai', versionCode: 114002, versionName: '11.4.0',
  manifest: { package: 'com.disney.shanghai', permissions: [], activities: [], services: [], receivers: [], providers: [] },
  findingCounts: { critical: 2, high: 7 }, findingsByCategory: {}, fileCount: 10, totalSize: 1000, sourceCounts: { java: 10 },
};
const versions = [
  { id: 55, trackedAppId: 1, versionCode: 114002, versionName: '11.4.0', filename: 'a.apk', fileSize: 1000, deviceId: null, source: 'playstore', downloadedAt: '2026-06-10T08:00:00Z' },
  { id: 50, trackedAppId: 1, versionCode: 113000, versionName: '11.3.0', filename: 'b.apk', fileSize: 900, deviceId: null, source: 'device', downloadedAt: '2026-03-01T08:00:00Z' },
];

function mockWs(overviewVid = '55'): WebSocketContextValue {
  return {
    connected: true, serverReady: true, startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (path === `/v1/apps/analysis/${overviewVid}/overview`) return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: overview } });
      if (path === `/v1/apps/analysis/${overviewVid}/notes`) return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, notes: '' } });
      if (path === '/v1/apps/versions/1') return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: versions } });
      if (path === `/v1/apps/diff/${overviewVid}`) return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { success: true, report: null } });
      if (path.includes('/availability')) return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { state: 'local' } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderPage(versionId = '55', ws = mockWs(versionId)) {
  render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/ui/apps/1/analysis/${versionId}`]}>
          <Routes>
            <Route path="/ui/apps/:trackedAppId/analysis/:versionId" element={<ApkAnalysis />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
}

describe('ApkAnalysis header rework', () => {
  it('shows a Latest badge when viewing the newest stored version', async () => {
    renderPage('55');
    await waitFor(() => expect(screen.getByTestId('latest-badge')).toBeInTheDocument());
  });

  it('does not show Latest when viewing an older version', async () => {
    renderPage('50');
    await waitFor(() => screen.getByTestId('ai-review-btn'));
    expect(screen.queryByTestId('latest-badge')).not.toBeInTheDocument();
  });

  it('keeps stable action labels and has no Back button', async () => {
    renderPage('55');
    await waitFor(() => screen.getByTestId('ai-review-btn'));
    expect(screen.getByTestId('ai-review-btn')).toHaveTextContent('AI Review');
    expect(screen.queryByRole('button', { name: 'Back to APKs' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });
});

describe('ApkAnalysis tabs', () => {
  it('shows findings count badge and notes dot via SDK Tabs', async () => {
    // notes non-empty so the Notes dot shows
    const ws = mockWs('55');
    (ws.sendRestApi as any).mockImplementation((method: string, path: string) => {
      if (path === '/v1/apps/analysis/55/overview') return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: overview } });
      if (path === '/v1/apps/analysis/55/notes') return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, notes: 'investigated SSL pinning' } });
      if (path === '/v1/apps/versions/1') return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: versions } });
      if (path === '/v1/apps/diff/55') return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { success: true, report: null } });
      if (path.includes('/availability')) return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { state: 'local' } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    });
    renderPage('55', ws);
    await waitFor(() => expect(screen.getByTestId('tab-findings')).toHaveTextContent('9'));
    expect(screen.getByTestId('tab-dot-notes')).toBeInTheDocument();
  });

  it('does not render the old toggle-library button in the tab strip', async () => {
    renderPage('55');
    await waitFor(() => screen.getByTestId('tab-findings'));
    // The findings tab is active by default? No — overview is default. The strip-level toggle is gone regardless.
    expect(screen.queryByTestId('toggle-library')).not.toBeInTheDocument();
  });
});

describe('ApkAnalysis overview', () => {
  it('removes the package-name stat card (identity is in the header)', async () => {
    renderPage('55');
    await waitFor(() => screen.getByTestId('tab-content-overview'));
    const statCards = screen.getAllByTestId('stat-card');
    for (const card of statCards) expect(card).not.toHaveTextContent('com.disney.shanghai');
  });

  it('severity pills navigate to a pre-filtered findings tab', async () => {
    const { fireEvent } = await import('@testing-library/react');
    renderPage('55');
    await waitFor(() => screen.getByTestId('severity-critical'));
    fireEvent.click(screen.getByTestId('severity-critical'));
    await waitFor(() => expect(screen.getByTestId('tab-content-findings')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('severity-filter')).toHaveValue('critical'));
  });

  it('groups permissions by protection level with a filter', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const ws = mockWs('55');
    const permOverview = { ...overview, manifest: { ...overview.manifest, permissions: ['android.permission.CAMERA', 'android.permission.INTERNET', 'com.custom.WEIRD'] } };
    (ws.sendRestApi as any).mockImplementation((method: string, path: string) => {
      if (path === '/v1/apps/analysis/55/overview') return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: permOverview } });
      if (path === '/v1/apps/analysis/55/notes') return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, notes: '' } });
      if (path === '/v1/apps/versions/1') return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: versions } });
      if (path === '/v1/apps/diff/55') return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { success: true, report: null } });
      if (path.includes('/availability')) return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { state: 'local' } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    });
    renderPage('55', ws);
    await waitFor(() => expect(screen.getByText(/Dangerous \(1\)/)).toBeInTheDocument());
    expect(screen.getByText(/Normal \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Other \(1\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('permission-filter'), { target: { value: 'camera' } });
    expect(screen.getByText('android.permission.CAMERA')).toBeInTheDocument();
    expect(screen.queryByText('android.permission.INTERNET')).not.toBeInTheDocument();
  });
});
