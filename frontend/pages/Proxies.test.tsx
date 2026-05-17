import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Proxies } from './Proxies';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

const mockProxies = [
  { id: 1, url: 'http://proxy1:8080', username: 'user1', password: null, failureCount: 1, enabled: true, createdAt: '2024-01-01' },
  { id: 2, url: 'http://proxy2:8080', username: null, password: null, failureCount: 5, enabled: false, createdAt: '2024-01-01' },
  { id: 3, url: 'http://proxy3:8080', username: null, password: null, failureCount: 10, enabled: true, createdAt: '2024-01-01' },
];

function createMockWs(): WebSocketContextValue {
  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({
      type: 'restapi', id: '1', status: 200, body: { data: mockProxies },
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderProxies() {
  const ws = createMockWs();
  render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <MemoryRouter>
          <Proxies />
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>
  );
  return ws;
}

describe('Proxies', () => {
  it('renders proxy list', async () => {
    renderProxies();
    await waitFor(() => {
      expect(screen.getByTestId('proxies-page')).toBeInTheDocument();
      expect(screen.getByTestId('proxies-table')).toBeInTheDocument();
    });
  });

  it('displays proxy URLs', async () => {
    renderProxies();
    await waitFor(() => {
      expect(screen.getByText('http://proxy1:8080')).toBeInTheDocument();
      expect(screen.getByText('http://proxy2:8080')).toBeInTheDocument();
      expect(screen.getByText('http://proxy3:8080')).toBeInTheDocument();
    });
  });

  it('shows failure count with color coding', async () => {
    renderProxies();
    await waitFor(() => {
      const low = screen.getByTestId('failure-count-1');
      const mid = screen.getByTestId('failure-count-2');
      const high = screen.getByTestId('failure-count-3');
      expect(low).toHaveClass('failure-low');
      expect(mid).toHaveClass('failure-medium');
      expect(high).toHaveClass('failure-high');
    });
  });

  it('opens add proxy modal', async () => {
    renderProxies();
    await waitFor(() => screen.getByTestId('add-proxy-btn'));
    fireEvent.click(screen.getByTestId('add-proxy-btn'));
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    expect(screen.getByTestId('modal').querySelector('h2')?.textContent).toBe('Add Proxy');
  });

  it('opens edit proxy modal', async () => {
    renderProxies();
    await waitFor(() => screen.getByTestId('edit-1'));
    fireEvent.click(screen.getByTestId('edit-1'));
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    expect(screen.getByText('Edit Proxy')).toBeInTheDocument();
  });

  it('calls delete API when delete confirmed', async () => {
    const ws = renderProxies();
    await waitFor(() => screen.getByTestId('delete-1'));
    fireEvent.click(screen.getByTestId('delete-1'));
    // Confirm the deletion dialog
    await waitFor(() => screen.getByTestId('confirm-dialog-confirm'));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('DELETE', '/v1/proxy/delete/1');
    });
  });

  it('calls toggle API when toggle clicked', async () => {
    const ws = renderProxies();
    await waitFor(() => screen.getByTestId('toggle-1'));
    fireEvent.click(screen.getByTestId('toggle-1'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/proxy/disable/1');
    });
  });

  it('fills and submits add form', async () => {
    const ws = renderProxies();
    await waitFor(() => screen.getByTestId('add-proxy-btn'));
    fireEvent.click(screen.getByTestId('add-proxy-btn'));

    fireEvent.change(screen.getByTestId('proxy-url-input'), { target: { value: 'http://new:9090' } });
    fireEvent.change(screen.getByTestId('proxy-username-input'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByTestId('proxy-password-input'), { target: { value: 'pass' } });
    fireEvent.click(screen.getByTestId('save-proxy-btn'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/proxy/add', {
        url: 'http://new:9090',
        username: 'admin',
        password: 'pass',
      });
    });
  });
});
