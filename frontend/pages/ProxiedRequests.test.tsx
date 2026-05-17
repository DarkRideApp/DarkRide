import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProxiedRequests } from './ProxiedRequests';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

const mockHistory = [
  {
    id: 'req_1',
    url: 'https://api.example.com/data',
    method: 'GET',
    headers: { 'accept': 'application/json' },
    body: null,
    proxyType: 'proxyId',
    proxyLabel: 'Proxy #1',
    status: 'completed',
    responseStatus: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}',
    responseBodyBase64: null,
    timingMs: 142,
    error: null,
    createdAt: '2024-01-01T00:00:00Z',
    completedAt: '2024-01-01T00:00:01Z',
  },
  {
    id: 'req_2',
    url: 'https://api.example.com/fail',
    method: 'POST',
    headers: null,
    body: '{"test":1}',
    proxyType: 'nordvpn',
    proxyLabel: 'NordVPN us',
    status: 'failed',
    responseStatus: null,
    responseHeaders: null,
    responseBody: null,
    responseBodyBase64: null,
    timingMs: null,
    error: 'Connection refused',
    createdAt: '2024-01-01T00:00:02Z',
    completedAt: '2024-01-01T00:00:03Z',
  },
  {
    id: 'req_3',
    url: 'https://api.example.com/image',
    method: 'GET',
    headers: null,
    body: null,
    proxyType: 'inline',
    proxyLabel: 'http://proxy:8080',
    status: 'completed',
    responseStatus: 200,
    responseHeaders: { 'content-type': 'image/png' },
    responseBody: null,
    responseBodyBase64: 'iVBORw0KGgo=',
    timingMs: 85,
    error: null,
    createdAt: '2024-01-01T00:00:04Z',
    completedAt: '2024-01-01T00:00:05Z',
  },
];

const mockStatus = { queueLength: 0, activeCount: 0, maxConcurrency: 5 };

function createMockWs(historyData = mockHistory, statusData = mockStatus): WebSocketContextValue {
  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (path.startsWith('/v1/proxied-request/history')) {
        return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { data: historyData } });
      }
      if (path === '/v1/proxied-request/status') {
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { data: statusData } });
      }
      return Promise.resolve({ type: 'restapi', id: '0', status: 200, body: {} });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderPage(ws?: WebSocketContextValue) {
  const mockWs = ws ?? createMockWs();
  render(
    <WebSocketContext.Provider value={mockWs}>
      <MemoryRouter>
        <ProxiedRequests />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );
  return mockWs;
}

describe('ProxiedRequests', () => {
  it('renders page header', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('proxied-requests-page')).toBeInTheDocument();
      expect(screen.getByText('HTTP Requests')).toBeInTheDocument();
    });
  });

  it('shows stats cards', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('stats-grid')).toBeInTheDocument();
      expect(screen.getByText('Queue')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });
  });

  it('renders empty state when no history', async () => {
    renderPage(createMockWs([]));
    await waitFor(() => {
      expect(screen.getByTestId('empty-history')).toBeInTheDocument();
      expect(screen.getByText('No requests yet')).toBeInTheDocument();
    });
  });

  it('renders history table with entries', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('history-table')).toBeInTheDocument();
      expect(screen.getByText('https://api.example.com/data')).toBeInTheDocument();
      expect(screen.getByText('https://api.example.com/fail')).toBeInTheDocument();
      expect(screen.getByText('142ms')).toBeInTheDocument();
      expect(screen.getByText('Proxy #1')).toBeInTheDocument();
      expect(screen.getByText('NordVPN us')).toBeInTheDocument();
    });
  });

  it('shows correct status badges', async () => {
    renderPage();
    await waitFor(() => {
      const successBadges = screen.getAllByTestId('badge-success');
      const failedBadges = screen.getAllByTestId('badge-failed');
      expect(successBadges.length).toBe(2);
      expect(failedBadges.length).toBe(1);
    });
  });

  it('expands row to show detail', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('row-req_1'));
    fireEvent.click(screen.getByTestId('row-req_1'));
    await waitFor(() => {
      const detail = screen.getByTestId('detail-req_1');
      expect(detail).toBeInTheDocument();
      expect(detail.textContent).toContain('accept: application/json');
      expect(detail.textContent).toContain('"ok": true');
    });
  });

  it('collapses expanded row on second click', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('row-req_1'));
    fireEvent.click(screen.getByTestId('row-req_1'));
    await waitFor(() => expect(screen.getByTestId('detail-req_1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('row-req_1'));
    await waitFor(() => expect(screen.queryByTestId('detail-req_1')).not.toBeInTheDocument());
  });

  it('shows error in failed request detail', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('row-req_2'));
    fireEvent.click(screen.getByTestId('row-req_2'));
    await waitFor(() => {
      const detail = screen.getByTestId('detail-req_2');
      expect(detail.textContent).toContain('Connection refused');
    });
  });

  it('shows binary indicator for base64 response', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('row-req_3'));
    fireEvent.click(screen.getByTestId('row-req_3'));
    await waitFor(() => {
      const detail = screen.getByTestId('detail-req_3');
      expect(detail.textContent).toContain('binary');
      expect(detail.textContent).toContain('bytes base64');
    });
  });

  it('subscribes to WebSocket events', async () => {
    const ws = renderPage();
    await waitFor(() => {
      expect(ws.subscribe).toHaveBeenCalledWith('proxied-request-queued', expect.any(Function));
      expect(ws.subscribe).toHaveBeenCalledWith('proxied-request-started', expect.any(Function));
      expect(ws.subscribe).toHaveBeenCalledWith('proxied-request-completed', expect.any(Function));
      expect(ws.subscribe).toHaveBeenCalledWith('proxied-request-failed', expect.any(Function));
    });
  });

  it('fetches history and status on mount', async () => {
    const ws = renderPage();
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/proxied-request/history?limit=50');
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/proxied-request/status');
    });
  });
});
