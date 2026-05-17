import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiCatalogue } from './ApiCatalogue';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

const mockEndpoints = {
  items: [
    { id: 1, method: 'GET', hostname: 'api.example.com', pathPattern: '/v1/users/{id}', firstSeen: Date.now(), lastSeen: Date.now(), requestCount: 42, sampleResponseStatus: 200, groupId: null, groupName: null },
    { id: 2, method: 'POST', hostname: 'api.example.com', pathPattern: '/v1/users', firstSeen: Date.now(), lastSeen: Date.now(), requestCount: 5, sampleResponseStatus: 201, groupId: 1, groupName: 'Auth' },
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

const mockGroups = [
  { id: 1, name: 'Auth', description: 'Auth endpoints', createdAt: Date.now(), endpointCount: 1, patterns: [
    { id: 1, groupId: 1, pattern: '*.auth.com', patternType: 'wildcard', createdAt: null },
  ] },
];

function createMockWs(): WebSocketContextValue {
  const sendRestApi = vi.fn().mockImplementation((_method: string, path: string) => {
    if (path.includes('groupId=ungrouped')) {
      return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { data: { items: [], total: 3, limit: 1, offset: 0 } } });
    }
    if (path.includes('/v1/api-catalogue/endpoints')) {
      return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { data: mockEndpoints } });
    }
    if (path.includes('/v1/api-catalogue/groups')) {
      return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: mockGroups } });
    }
    return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true } });
  });

  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderPage() {
  const ws = createMockWs();
  render(
    <WebSocketContext.Provider value={ws}>
      <MemoryRouter>
        <ApiCatalogue />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );
  return ws;
}

describe('ApiCatalogue', () => {
  it('renders page title', async () => {
    renderPage();
    expect(screen.getByText('API Catalogue')).toBeInTheDocument();
  });

  it('shows Manage Groups and ungrouped buttons in header', async () => {
    renderPage();
    // manage groups btn is always visible
    await waitFor(() => {
      expect(screen.getByTestId('manage-groups-btn')).toBeInTheDocument();
    });
    // ungrouped button appears when count > 0 (our mock returns total: 3)
    await waitFor(() => {
      expect(screen.getByTestId('ungrouped-btn')).toBeInTheDocument();
    });
  });

  it('fetches endpoints on mount', async () => {
    const ws = renderPage();
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('/v1/api-catalogue/endpoints')
      );
    });
  });

  it('fetches groups on mount', async () => {
    const ws = renderPage();
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        '/v1/api-catalogue/groups'
      );
    });
  });

  it('shows group browser by default with group rows', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('group-row-1')).toBeInTheDocument();
    });
    expect(screen.getByText('Auth')).toBeInTheDocument();
  });

  it('shows group search input', async () => {
    renderPage();
    expect(screen.getByTestId('group-search-input')).toBeInTheDocument();
  });

  it('filters groups by search text', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('group-row-1')).toBeInTheDocument();
    });
    const searchInput = screen.getByTestId('group-search-input');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
    await waitFor(() => {
      expect(screen.queryByTestId('group-row-1')).not.toBeInTheDocument();
    });
  });

  it('switches to manage view when Manage Groups clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-groups-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('manage-groups-btn'));
    await waitFor(() => {
      // Management view shows create group form
      expect(screen.getByText('Create Group')).toBeInTheDocument();
    });
  });

  it('clicking Ungrouped button shows filter controls', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('ungrouped-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('ungrouped-btn'));
    await waitFor(() => {
      expect(screen.getByText('Method')).toBeInTheDocument();
    });
    expect(screen.getByText('Hostname')).toBeInTheDocument();
    expect(screen.getByText('Path')).toBeInTheDocument();
  });

  it('manage view shows group list with group-link', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-groups-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('manage-groups-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('group-link-1')).toBeInTheDocument();
    });
  });

  it('clicking group Filter button in manage view switches to ungrouped view with group filter', async () => {
    const ws = renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-groups-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('manage-groups-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('group-link-1')).toBeInTheDocument();
    });
    // The Filter button filters by groupId
    fireEvent.click(screen.getByTitle('Filter endpoints by this group'));
    // Should re-fetch with groupId filter
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('groupId=1')
      );
    });
  });

  it('back to groups button appears in manage sub-view', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-groups-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('manage-groups-btn'));
    await waitFor(() => {
      expect(screen.getByText(/Back to Groups/i)).toBeInTheDocument();
    });
  });

  it('back to groups button returns to group browser', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-groups-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('manage-groups-btn'));
    await waitFor(() => {
      expect(screen.getByText(/Back to Groups/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Back to Groups/i));
    await waitFor(() => {
      expect(screen.getByTestId('group-search-input')).toBeInTheDocument();
    });
  });
});
