import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SourceManagerModal } from './SourceManagerModal';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';

// ── Mock data matching real GET /v1/plugins/sources response shape ──────────

const mockSources = [
  {
    id: 1,
    name: 'DarkRide Official',
    type: 'registry' as const,
    url: 'https://plugins.darkride.app/plugins.json',
    authToken: null,
    enabled: true,
    isDefault: true,
    priority: 0,
  },
  {
    id: 2,
    name: 'Private Registry',
    type: 'registry' as const,
    url: 'https://private.example.com/plugins.json',
    authToken: '********',
    enabled: true,
    isDefault: false,
    priority: 10,
  },
  {
    id: 3,
    name: 'My Git Plugin',
    type: 'git' as const,
    url: 'https://gitea.local/org/my-plugin.git',
    authToken: null,
    enabled: false,
    isDefault: false,
    priority: 10,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockWs(overrides?: Partial<WebSocketContextValue>): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === '/v1/plugins/sources') {
        return Promise.resolve({
          type: 'restapi',
          id: '1',
          status: 200,
          body: { success: true, data: mockSources },
        });
      }
      // Default success for POST/PUT/DELETE
      return Promise.resolve({
        type: 'restapi',
        id: '2',
        status: 200,
        body: { success: true },
      });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as any;
}

function renderSourceManagerModal(ws?: WebSocketContextValue, props?: { onClose?: () => void; onSourcesChanged?: () => void }) {
  const mockWs = ws || createMockWs();
  const onClose = props?.onClose ?? vi.fn();
  const onSourcesChanged = props?.onSourcesChanged ?? vi.fn();
  return {
    ws: mockWs,
    onClose,
    onSourcesChanged,
    ...render(
      <WebSocketContext.Provider value={mockWs}>
        <ToastProvider>
          <MemoryRouter>
            <SourceManagerModal onClose={onClose} onSourcesChanged={onSourcesChanged} />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>,
    ),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SourceManagerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // HTMLDialogElement.showModal is not implemented in jsdom — stub it to set open attribute
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });

  it('renders source list from API', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
      expect(screen.getByText('Private Registry')).toBeInTheDocument();
      expect(screen.getByText('My Git Plugin')).toBeInTheDocument();
    });
  });

  it('shows source URLs', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('https://plugins.darkride.app/plugins.json')).toBeInTheDocument();
      expect(screen.getByText('https://private.example.com/plugins.json')).toBeInTheDocument();
      expect(screen.getByText('https://gitea.local/org/my-plugin.git')).toBeInTheDocument();
    });
  });

  it('default source shows lock icon and "read only" note', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('Default \u2014 read only')).toBeInTheDocument();
    });
  });

  it('default source has no Remove button', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    // There should be Remove buttons only for non-default sources (2 of them)
    const removeButtons = screen.getAllByText('Remove');
    expect(removeButtons).toHaveLength(2);
  });

  it('shows type badges (Registry / Git)', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    const registryBadges = screen.getAllByText('Registry');
    const gitBadges = screen.getAllByText('Git');
    expect(registryBadges).toHaveLength(2);
    expect(gitBadges).toHaveLength(1);
  });

  it('add source form appears on button click', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add Source'));

    expect(screen.getByText('Add Plugin Source')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('My Plugin Registry')).toBeInTheDocument();
  });

  it('submit calls POST /v1/plugins/sources with correct body', async () => {
    const ws = createMockWs();
    renderSourceManagerModal(ws);

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    // Open the add form
    fireEvent.click(screen.getByText('Add Source'));

    // Fill in the form
    fireEvent.change(screen.getByPlaceholderText('My Plugin Registry'), {
      target: { value: 'My Custom Registry' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://plugins.example.com/plugins.json'), {
      target: { value: 'https://my-registry.example.com/plugins.json' },
    });

    // Submit
    fireEvent.click(screen.getByText('Save Source'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/plugins/sources',
        { name: 'My Custom Registry', type: 'registry', url: 'https://my-registry.example.com/plugins.json' },
      );
    });
  });

  it('submit includes auth token when provided', async () => {
    const ws = createMockWs();
    renderSourceManagerModal(ws);

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add Source'));

    fireEvent.change(screen.getByPlaceholderText('My Plugin Registry'), {
      target: { value: 'Private' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://plugins.example.com/plugins.json'), {
      target: { value: 'https://private.example.com/api' },
    });
    fireEvent.change(screen.getByPlaceholderText('ghp_...'), {
      target: { value: 'ghp_mytoken123' },
    });

    fireEvent.click(screen.getByText('Save Source'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/plugins/sources',
        expect.objectContaining({ authToken: 'ghp_mytoken123' }),
      );
    });
  });

  it('submit calls onSourcesChanged after successful add', async () => {
    const ws = createMockWs();
    const onSourcesChanged = vi.fn();
    renderSourceManagerModal(ws, { onSourcesChanged });

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add Source'));

    fireEvent.change(screen.getByPlaceholderText('My Plugin Registry'), {
      target: { value: 'New Source' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://plugins.example.com/plugins.json'), {
      target: { value: 'https://example.com/plugins.json' },
    });

    fireEvent.click(screen.getByText('Save Source'));

    await waitFor(() => {
      expect(onSourcesChanged).toHaveBeenCalled();
    });
  });

  it('delete calls DELETE /v1/plugins/sources/:id', async () => {
    const ws = createMockWs();
    renderSourceManagerModal(ws);

    await waitFor(() => {
      expect(screen.getByText('Private Registry')).toBeInTheDocument();
    });

    // Click the first Remove button (Private Registry, id=2)
    const removeButtons = screen.getAllByText('Remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'DELETE',
        '/v1/plugins/sources/2',
      );
    });
  });

  it('test button calls POST /v1/plugins/sources/:id/test', async () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/plugins/sources') {
          return Promise.resolve({
            type: 'restapi',
            id: '1',
            status: 200,
            body: { success: true, data: mockSources },
          });
        }
        if (method === 'POST' && path.includes('/test')) {
          return Promise.resolve({
            type: 'restapi',
            id: '3',
            status: 200,
            body: { success: true, data: { plugins: [{ name: 'demo-plugin-a' }, { name: 'demo-plugin-b' }] } },
          });
        }
        return Promise.resolve({
          type: 'restapi',
          id: '2',
          status: 200,
          body: { success: true },
        });
      }),
    });
    renderSourceManagerModal(ws);

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    // Click the first "Test" button (DarkRide Official, id=1)
    const testButtons = screen.getAllByText('Test');
    fireEvent.click(testButtons[0]);

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/plugins/sources/1/test',
      );
    });
  });

  it('shows loading state while sources are being fetched', () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    renderSourceManagerModal(ws);

    const modal = screen.getByTestId('modal');
    expect(modal.querySelector('.plugin-loading')).toBeInTheDocument();
  });

  it('shows empty state when no sources configured', async () => {
    const ws = createMockWs({
      sendRestApi: vi.fn().mockResolvedValue({
        type: 'restapi',
        id: '1',
        status: 200,
        body: { success: true, data: [] },
      }),
    });
    renderSourceManagerModal(ws);

    await waitFor(() => {
      expect(screen.getByText('No plugin sources configured.')).toBeInTheDocument();
    });
  });

  it('cancel button hides the add form', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add Source'));
    expect(screen.getByText('Add Plugin Source')).toBeInTheDocument();

    // The "Cancel" inside the add form (not the modal close)
    const cancelButtons = screen.getAllByText('Cancel');
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);
    expect(screen.queryByText('Add Plugin Source')).not.toBeInTheDocument();
  });

  it('type selector changes URL placeholder', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add Source'));

    // Default type is registry — URL placeholder should match
    expect(screen.getByPlaceholderText('https://plugins.example.com/plugins.json')).toBeInTheDocument();

    // Switch to git
    const typeSelect = screen.getByDisplayValue('Registry');
    fireEvent.change(typeSelect, { target: { value: 'git' } });

    // Placeholder should change to git URL format
    expect(screen.getByPlaceholderText('https://gitea.local/org/my-plugin.git')).toBeInTheDocument();
  });

  it('edit button opens inline edit form', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('Private Registry')).toBeInTheDocument();
    });

    // Click the first Edit button
    const editButtons = screen.getAllByText('Edit');
    fireEvent.click(editButtons[0]);

    // Should show the Save Changes button (inline edit mode)
    expect(screen.getByText('Save Changes')).toBeInTheDocument();
  });

  it('enabled checkboxes reflect source state', async () => {
    renderSourceManagerModal();

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    // Get all "Enabled" labeled checkboxes
    const checkboxes = screen.getAllByRole('checkbox');
    // First (default) should be checked, second (Private) should be checked, third (Git) should be unchecked
    expect(checkboxes[0]).toBeChecked();  // DarkRide Official
    expect(checkboxes[1]).toBeChecked();  // Private Registry
    expect(checkboxes[2]).not.toBeChecked();  // My Git Plugin (disabled)
  });

  it('renders inside a modal with close button', async () => {
    const onClose = vi.fn();
    renderSourceManagerModal(undefined, { onClose });

    await waitFor(() => {
      expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    });

    // Modal should have a title
    expect(screen.getByText('Plugin Sources')).toBeInTheDocument();

    // Modal should have a close button
    const closeBtn = screen.getByLabelText('Close');
    expect(closeBtn).toBeInTheDocument();

    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});
