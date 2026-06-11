import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ActivityPanel } from './ActivityPanel';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const jobs = [
  { id: 1, apkVersionId: 10, status: 'running', stage: 'decompiling', error: null, createdAt: '2026-06-10T10:00:00Z', startedAt: '2026-06-10T10:00:05Z', completedAt: null, trackedAppId: 5, packageName: 'com.a', appName: 'Alpha', versionCode: 3, versionName: '3.0' },
  { id: 2, apkVersionId: 11, status: 'pending', stage: null, error: null, createdAt: '2026-06-10T10:01:00Z', startedAt: null, completedAt: null, trackedAppId: 6, packageName: 'com.b', appName: 'Beta', versionCode: 1, versionName: '1.0' },
  { id: 3, apkVersionId: 12, status: 'failed', stage: null, error: 'jadx: out of memory', createdAt: '2026-06-10T09:00:00Z', startedAt: '2026-06-10T09:00:05Z', completedAt: '2026-06-10T09:10:00Z', trackedAppId: 7, packageName: 'com.c', appName: 'Gamma', versionCode: 2, versionName: '2.0' },
  { id: 4, apkVersionId: 13, status: 'completed', stage: 'done', error: null, createdAt: '2026-06-10T08:00:00Z', startedAt: '2026-06-10T08:00:05Z', completedAt: '2026-06-10T08:08:46Z', trackedAppId: 8, packageName: 'com.d', appName: 'Delta', versionCode: 9, versionName: '9.0' },
];

function mockWs(): WebSocketContextValue {
  return {
    connected: true, serverReady: true, startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (path === '/v1/apps/analysis-jobs/recent') return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: jobs } });
      return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderPanel(onClose = vi.fn()) {
  const ws = mockWs();
  render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <MemoryRouter>
          <ActivityPanel onClose={onClose} />
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
  return { ws, onClose };
}

describe('ActivityPanel', () => {
  it('groups jobs into Running and Recent sections', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(/Running — 2/)).toBeInTheDocument());
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText(/Alpha · v3.0/)).toBeInTheDocument();
    expect(screen.getByText('jadx: out of memory')).toBeInTheDocument();
  });

  it('cancels a running job', async () => {
    const { ws } = renderPanel();
    await waitFor(() => screen.getAllByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/apps/analysis-jobs/1/cancel'));
  });

  it('retries a failed job via analyze endpoint', async () => {
    const { ws } = renderPanel();
    await waitFor(() => screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/apps/analyze/12'));
  });

  it('closes via the close button', async () => {
    const { onClose } = renderPanel();
    await waitFor(() => screen.getByRole('button', { name: 'Close activity panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close activity panel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('navigates to the analysis page when a completed job row is clicked', async () => {
    const { onClose } = renderPanel();
    await waitFor(() => screen.getByTestId('activity-job-4')); // Delta, completed, trackedAppId 8, version 13
    fireEvent.click(screen.getByTestId('activity-job-4'));
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/ui/apps/8/analysis/13');
  });

  it('navigates to app detail when a running job row is clicked', async () => {
    renderPanel();
    await waitFor(() => screen.getByTestId('activity-job-1')); // Alpha, running, trackedAppId 5
    fireEvent.click(screen.getByTestId('activity-job-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/ui/apps/5');
  });

  it('does not navigate when Cancel is clicked (stopPropagation)', async () => {
    renderPanel();
    await waitFor(() => screen.getAllByRole('button', { name: 'Cancel' }));
    mockNavigate.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
