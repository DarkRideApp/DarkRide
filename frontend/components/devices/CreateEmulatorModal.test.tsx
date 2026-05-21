import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CreateEmulatorModal } from './CreateEmulatorModal';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';

function createWsMock(overrides: any = {}) {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === '/v1/devices/providers') {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: {
            success: true,
            data: {
              providers: [
                { id: 'docker-android', displayName: 'Docker Android', available: true, capabilities: { canCreate: true } },
                { id: 'avd', displayName: 'AVD', available: false, installHint: 'Install Android Studio', capabilities: { canCreate: true } },
              ],
            },
          },
        });
      }
      if (method === 'GET' && path === '/v1/devices/providers/docker-android/create-form') {
        return Promise.resolve({
          type: 'restapi', id: '2', status: 200,
          body: {
            success: true,
            data: {
              fields: [
                { key: 'androidVersion', label: 'Android version', type: 'select', required: true, default: '14', options: [{ value: '14', label: '14.0 (API 34)' }] },
                { key: 'ramMb', label: 'RAM (MB)', type: 'number', required: true, default: 2048 },
              ],
            },
          },
        });
      }
      return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: { instance: { id: 99 } } } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

function renderModal(ws: any = createWsMock()) {
  return {
    ws,
    ...render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <CreateEmulatorModal onCancel={vi.fn()} onCreated={vi.fn()} />
        </ToastProvider>
      </WebSocketContext.Provider>,
    ),
  };
}

describe('CreateEmulatorModal', () => {
  it('renders one tab per provider that supports createInstance', async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /docker android/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /avd/i })).toBeInTheDocument();
    });
  });

  it('shows installHint when an unavailable tab is selected', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('tab', { name: /avd/i }));
    expect(screen.getByText(/install android studio/i)).toBeInTheDocument();
  });

  it('renders the form schema from getCreateFormSchema for the selected (available) tab', async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByLabelText(/android version/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/ram \(mb\)/i)).toBeInTheDocument();
    });
  });

  it('POSTs to /v1/devices/providers/:id/instances on submit', async () => {
    const ws = createWsMock();
    const { ws: w } = renderModal(ws);
    const nameInput = await screen.findByLabelText(/^name$/i);
    fireEvent.change(nameInput, { target: { value: 'my-test' } });
    fireEvent.click(screen.getByText(/create.*start/i));
    await waitFor(() => {
      expect(w.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/devices/providers/docker-android/instances',
        expect.objectContaining({ displayName: 'my-test' }),
      );
    });
  });
});
