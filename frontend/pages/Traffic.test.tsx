import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Traffic } from './Traffic';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

const baseEntry = {
  sessionId: null,
  deviceId: null,
  requestHeaders: null,
  requestBody: null,
  responseHeaders: null,
  responseBody: null,
  matchedRules: null,
  capturedAt: '2025-01-01T00:00:00Z',
};

const mockEntries = [
  { id: 1, requestMethod: 'GET', requestUrl: 'https://api.example.com/one', responseStatus: 200, ...baseEntry },
  { id: 2, requestMethod: 'POST', requestUrl: 'https://api.example.com/two', responseStatus: 404, ...baseEntry },
];

function createMockWs(entries = mockEntries): WebSocketContextValue & { sendRestApi: ReturnType<typeof vi.fn> } {
  const sendRestApi = vi.fn().mockImplementation((method: string, path: string) => {
    if (path.startsWith('/v1/traffic/list')) {
      return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { data: { items: entries, total: entries.length } } });
    }
    return Promise.resolve({ type: 'restapi', id: '0', status: 200, body: {} });
  });
  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderPage(ws?: ReturnType<typeof createMockWs>) {
  const mockWs = ws ?? createMockWs();
  render(
    <WebSocketContext.Provider value={mockWs}>
      <MemoryRouter>
        <Traffic />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );
  return mockWs;
}

function lastListUrl(ws: ReturnType<typeof createMockWs>): URLSearchParams {
  const calls = ws.sendRestApi.mock.calls.filter(([, path]: [string, string]) => path.startsWith('/v1/traffic/list'));
  const [, path] = calls[calls.length - 1];
  return new URLSearchParams(path.split('?')[1] ?? '');
}

describe('Traffic page — server filter wiring', () => {
  it('fetches traffic on mount with the default params', async () => {
    const ws = renderPage();
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('GET', expect.stringContaining('/v1/traffic/list')));
  });

  it('wires the "search all" filter to the server `search` query param', async () => {
    const ws = renderPage();
    await waitFor(() => screen.getByTestId('traffic-search-all-input'));

    fireEvent.change(screen.getByTestId('traffic-search-all-input'), { target: { value: 'auth-token' } });

    // Debounced (SEARCH_DEBOUNCE_MS=300ms in TrafficTable) — wait past it in real time.
    await act(async () => { await new Promise(r => setTimeout(r, 400)); });

    await waitFor(() => {
      const params = lastListUrl(ws);
      expect(params.get('search')).toBe('auth-token');
    }, { timeout: 2000 });
  });

  it('derives a single-group status century and sends it to the server', async () => {
    const ws = renderPage();
    await waitFor(() => screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByText('4xx'));

    await waitFor(() => {
      const params = lastListUrl(ws);
      expect(params.get('status')).toBe('400');
    });
  });

  it('still derives the correct method+type server params for a single included method (POST fix)', async () => {
    const ws = renderPage();
    await waitFor(() => screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));

    const postFilter = screen.getByTestId('filter-method-POST');
    fireEvent.click(postFilter.querySelector('.traffic-method-filter-btn') as HTMLElement);

    await waitFor(() => {
      const params = lastListUrl(ws);
      expect(params.get('type')).toBe('http');
      expect(params.get('method')).toBe('POST');
    });
  });

  it('keeps the selected row selected across a filter change when it still matches', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('traffic-row-1'));

    fireEvent.click(screen.getByTestId('traffic-row-1'));
    expect(screen.getByTestId('traffic-row-1')).toHaveClass('selected');

    // Apply a status filter that entry 1 (200) still passes.
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByText('2xx'));

    await waitFor(() => {
      expect(screen.getByTestId('traffic-row-1')).toBeInTheDocument();
      expect(screen.getByTestId('traffic-row-1')).toHaveClass('selected');
    });
  });

  it('clears the selection once the selected row no longer matches the new filter', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('traffic-row-1'));

    fireEvent.click(screen.getByTestId('traffic-row-1'));
    expect(screen.getByTestId('traffic-row-1')).toHaveClass('selected');

    // Row 1 is status 200 — filtering to 4xx should drop it and clear selection.
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByText('4xx'));

    await waitFor(() => {
      expect(screen.queryByTestId('traffic-row-1')).not.toBeInTheDocument();
    });
  });
});
