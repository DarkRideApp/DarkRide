import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Utils } from './Utils';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

// Mock recharts to avoid DOM measurement issues in jsdom
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  Tooltip: () => <div />,
}));

function createMockWs(historyData: any[] = [], cloudStatus?: any): WebSocketContextValue {
  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (path === '/v1/utils/info') {
        return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { data: { dbSizeBytes: 52428800 } } });
      }
      if (path === '/v1/utils/db-size-history') {
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { data: historyData } });
      }
      if (path === '/v1/cloud/status') {
        return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { data: cloudStatus ?? null } });
      }
      if (method === 'POST' && path.startsWith('/v1/cloud/retry/')) {
        return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { success: true } });
      }
      return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderUtils(ws?: WebSocketContextValue) {
  const mockWs = ws || createMockWs();
  return render(
    <WebSocketContext.Provider value={mockWs}>
      <MemoryRouter>
        <Utils />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );
}

describe('Utils Page', () => {
  it('renders the utils page', () => {
    renderUtils();
    expect(screen.getByTestId('utils-page')).toBeInTheDocument();
  });

  it('shows no-data message when history is empty', async () => {
    renderUtils(createMockWs([]));
    await waitFor(() => {
      expect(screen.getByTestId('db-size-no-data')).toBeInTheDocument();
      expect(screen.getByText(/No size history data yet/)).toBeInTheDocument();
    });
  });

  it('renders chart when history data is available', async () => {
    const historyData = [
      { sizeBytes: 10000000, capturedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
      { sizeBytes: 12000000, capturedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    renderUtils(createMockWs(historyData));
    await waitFor(() => {
      expect(screen.getByTestId('db-size-chart')).toBeInTheDocument();
      expect(screen.getByText('Size History (Last 60 Days)')).toBeInTheDocument();
    });
  });

  it('displays the database size', async () => {
    renderUtils();
    await waitFor(() => {
      expect(screen.getByText('50.0 MB')).toBeInTheDocument();
    });
  });

  it('has a download backup button', () => {
    renderUtils();
    expect(screen.getByTestId('download-db-btn')).toBeInTheDocument();
  });
});

describe('Utils Page — Cloud Backup section', () => {
  it('does not show cloud backup section when cloud is not configured', async () => {
    const ws = createMockWs([], { configured: false, errors: [] });
    renderUtils(ws);
    await waitFor(() => {
      expect(screen.queryByTestId('cloud-backup-section')).not.toBeInTheDocument();
    });
  });

  it('shows cloud backup section when cloud is configured', async () => {
    const ws = createMockWs([], { configured: true, errors: [] });
    renderUtils(ws);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-backup-section')).toBeInTheDocument();
    });
  });

  it('shows no-errors message when there are no failed uploads', async () => {
    const ws = createMockWs([], { configured: true, errors: [] });
    renderUtils(ws);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-no-errors')).toBeInTheDocument();
      expect(screen.queryByTestId('cloud-error-badge')).not.toBeInTheDocument();
    });
  });

  it('shows error badge and failed uploads list', async () => {
    const ws = createMockWs([], {
      configured: true,
      errors: [
        { cloudKey: 'apks/com.example/app.apk', error: 'Connection timeout' },
        { cloudKey: 'backups/2026-01-01.db', error: 'Access denied' },
      ],
    });
    renderUtils(ws);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-error-badge')).toHaveTextContent('2');
      expect(screen.getByTestId('cloud-errors-table')).toBeInTheDocument();
      expect(screen.getByText('Connection timeout')).toBeInTheDocument();
      expect(screen.getByText('Access denied')).toBeInTheDocument();
    });
  });

  it('removes entry from list after successful retry', async () => {
    const ws = createMockWs([], {
      configured: true,
      errors: [{ cloudKey: 'apks/com.example/app.apk', error: 'Network error' }],
    });
    renderUtils(ws);

    await waitFor(() => {
      expect(screen.getByTestId('retry-btn-apks/com.example/app.apk')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('retry-btn-apks/com.example/app.apk'));

    await waitFor(() => {
      expect(screen.queryByText('Network error')).not.toBeInTheDocument();
      expect(screen.getByTestId('cloud-no-errors')).toBeInTheDocument();
    });
  });
});
