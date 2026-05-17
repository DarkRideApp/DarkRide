import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionHistory } from './SessionHistory';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

const mockSessions = [
  { id: 1, name: 'Session 1', status: 'success', triggerType: 'manual', deviceId: 'dev-1', isPinned: true, startedAt: '2024-01-01T00:00:00Z', completedAt: '2024-01-01T00:01:00Z' },
  { id: 2, name: 'Session 2', status: 'failed', triggerType: 'api', deviceId: 'dev-2', isPinned: false, startedAt: '2024-01-02T00:00:00Z', completedAt: '2024-01-02T00:01:00Z' },
  { id: 3, name: null, status: 'running', triggerType: 'schedule', deviceId: 'dev-1', isPinned: true, startedAt: '2024-01-03T00:00:00Z', completedAt: null },
];

const mockDevices = [
  { id: 'dev-1', name: 'Pixel 6' },
  { id: 'dev-2', name: null },
];

function createMockWs(sessions = mockSessions, devices = mockDevices): WebSocketContextValue {
  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((_method: string, url: string) => {
      if (url.includes('/v1/device/list')) {
        return Promise.resolve({
          type: 'restapi', id: '2', status: 200,
          body: { data: devices },
        });
      }
      return Promise.resolve({
        type: 'restapi', id: '1', status: 200,
        body: { data: { items: sessions, total: sessions.length } },
      });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderPage(ws?: WebSocketContextValue) {
  const mockWs = ws || createMockWs();
  render(
    <WebSocketContext.Provider value={mockWs}>
      <ToastProvider>
        <MemoryRouter>
          <SessionHistory />
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>
  );
  return mockWs;
}

describe('SessionHistory', () => {
  it('renders session history page', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('session-history')).toBeInTheDocument();
      expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
    });
  });

  it('displays sessions in the table', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Session 1')).toBeInTheDocument();
      expect(screen.getByText('Session 2')).toBeInTheDocument();
    });
  });

  it('renders the Pinned filter dropdown', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Pinned')).toBeInTheDocument();
    });
    // Check the select has the right options
    const pinnedSelect = screen.getByText('Pinned').closest('.form-group')!.querySelector('select')!;
    const options = Array.from(pinnedSelect.options).map(o => o.text);
    expect(options).toEqual(['All', 'Pinned Only', 'Unpinned Only']);
  });

  it('sends pinned=true param when Pinned Only is selected', async () => {
    const ws = createMockWs();
    renderPage(ws);
    await waitFor(() => {
      expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
    });

    // Clear initial call tracking
    (ws.sendRestApi as ReturnType<typeof vi.fn>).mockClear();

    const pinnedSelect = screen.getByText('Pinned').closest('.form-group')!.querySelector('select')!;
    fireEvent.change(pinnedSelect, { target: { value: 'true' } });

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('pinned=true')
      );
    });
  });

  it('sends pinned=false param when Unpinned Only is selected', async () => {
    const ws = createMockWs();
    renderPage(ws);
    await waitFor(() => {
      expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
    });

    (ws.sendRestApi as ReturnType<typeof vi.fn>).mockClear();

    const pinnedSelect = screen.getByText('Pinned').closest('.form-group')!.querySelector('select')!;
    fireEvent.change(pinnedSelect, { target: { value: 'false' } });

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('pinned=false')
      );
    });
  });

  it('does not send pinned param when All is selected', async () => {
    const ws = createMockWs();
    renderPage(ws);
    await waitFor(() => {
      expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
    });

    (ws.sendRestApi as ReturnType<typeof vi.fn>).mockClear();

    // Select "Pinned Only" first, then switch back to "All"
    const pinnedSelect = screen.getByText('Pinned').closest('.form-group')!.querySelector('select')!;
    fireEvent.change(pinnedSelect, { target: { value: 'true' } });
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalled();
    });

    (ws.sendRestApi as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.change(pinnedSelect, { target: { value: '' } });

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.not.stringContaining('pinned=')
      );
    });
  });

  it('shows device nice name when available', async () => {
    renderPage();
    await waitFor(() => {
      // dev-1 has name "Pixel 6" — appears in 2 session rows + 1 in the device filter dropdown
      expect(screen.getAllByText('Pixel 6')).toHaveLength(3);
      // dev-2 has no name, should show device ID in session row and dropdown
      expect(screen.getAllByText('dev-2').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows empty state when no sessions', async () => {
    const ws = createMockWs([]);
    renderPage(ws);
    await waitFor(() => {
      expect(screen.getByText('No sessions found')).toBeInTheDocument();
    });
  });

  it('toggles pin on a session', async () => {
    const ws = createMockWs();
    renderPage(ws);
    await waitFor(() => {
      expect(screen.getByTestId('pin-btn-1')).toBeInTheDocument();
    });

    // Session 1 is pinned, clicking should unpin
    fireEvent.click(screen.getByTestId('pin-btn-1'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'PATCH',
        '/v1/automation/session/1',
        { isPinned: false }
      );
    });
  });

  describe('bulk delete', () => {
    it('shows bulk action bar when rows are selected', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
      });

      // Select first row
      fireEvent.click(screen.getByTestId('row-select-1'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();
      expect(screen.getByTestId('bulk-delete-btn')).toBeInTheDocument();
    });

    it('select-all selects all session rows', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('select-all-checkbox'));
      expect(screen.getByText('3 selected')).toBeInTheDocument();
    });

    it('opens confirmation dialog on bulk delete click', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
      });

      // Select two rows
      fireEvent.click(screen.getByTestId('row-select-1'));
      fireEvent.click(screen.getByTestId('row-select-2'));

      const bulkDeleteBtn = await screen.findByTestId('bulk-delete-btn');
      fireEvent.click(bulkDeleteBtn);

      // Confirmation dialog should appear
      await waitFor(() => {
        expect(screen.getByText('Delete Sessions')).toBeInTheDocument();
        expect(screen.getByText(/Are you sure you want to delete 2 sessions/)).toBeInTheDocument();
      });
    });

    it('deletes sessions on confirmation', async () => {
      const ws = createMockWs();
      renderPage(ws);
      await waitFor(() => {
        expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('row-select-1'));
      const bulkDeleteBtn = await screen.findByTestId('bulk-delete-btn');
      fireEvent.click(bulkDeleteBtn);

      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog-confirm')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(ws.sendRestApi).toHaveBeenCalledWith(
          'DELETE',
          '/v1/automation/session/1'
        );
      });
    });

    it('cancels bulk delete on dialog cancel', async () => {
      const ws = createMockWs();
      renderPage(ws);
      await waitFor(() => {
        expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('row-select-1'));
      const bulkDeleteBtn = await screen.findByTestId('bulk-delete-btn');
      fireEvent.click(bulkDeleteBtn);

      await waitFor(() => {
        expect(screen.getByText('Cancel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Cancel'));

      // Dialog should be gone
      await waitFor(() => {
        expect(screen.queryByText('Delete Sessions')).not.toBeInTheDocument();
      });
    });
  });

  describe('running session elapsed time', () => {
    it('shows elapsed timer for running sessions', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
      });

      // Session 3 is running — should show "elapsed" text
      expect(screen.getByText(/elapsed/)).toBeInTheDocument();
    });

    it('shows completed date for finished sessions', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
      });

      // Session 1 has completedAt, should show a date string
      const completedDate = new Date('2024-01-01T00:01:00Z').toLocaleString();
      expect(screen.getByText(completedDate)).toBeInTheDocument();
    });
  });

  it('shows skeleton loading state initially', () => {
    // Render with ws not connected yet — loading should remain true
    const ws: WebSocketContextValue = {
      connected: false,
      sendMessage: vi.fn(),
      sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { data: { items: [], total: 0 } } }),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };
    const { container } = render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter>
            <SessionHistory />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>
    );
    // Loading state renders SkeletonTable
    expect(container.querySelector('.skeleton-table')).toBeInTheDocument();
  });
});
