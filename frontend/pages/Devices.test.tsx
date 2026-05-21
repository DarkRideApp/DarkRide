import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Devices } from './Devices';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

// jsdom doesn't implement HTMLDialogElement methods
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});

const mockDevices = [
  { id: 'device-001', name: 'Pixel 6', platform: 'android', isRooted: true, setupVersion: 4, bridgePort: 9100, lastSeen: new Date().toISOString() },
  { id: 'device-002', name: 'Galaxy S21', platform: 'android', isRooted: false, setupVersion: 0, bridgePort: null, lastSeen: null },
  { id: 'device-003', name: 'iPhone 14', platform: 'ios', isRooted: false, setupVersion: 0, bridgePort: null, lastSeen: new Date().toISOString() },
];

function createMockWs(): WebSocketContextValue {
  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({
      type: 'restapi', id: '1', status: 200, body: { data: mockDevices },
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderDevices() {
  return render(
    <WebSocketContext.Provider value={createMockWs()}>
      <ToastProvider>
        <MemoryRouter>
          <Devices />
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>
  );
}

describe('Devices', () => {
  it('renders device list', async () => {
    renderDevices();
    await waitFor(() => {
      expect(screen.getByTestId('devices-page')).toBeInTheDocument();
    });
  });

  it('displays device names', async () => {
    renderDevices();
    await waitFor(() => {
      expect(screen.getByText('Pixel 6')).toBeInTheDocument();
      expect(screen.getByText('Galaxy S21')).toBeInTheDocument();
    });
  });

  it('shows online/offline status', async () => {
    renderDevices();
    await waitFor(() => {
      expect(screen.getByTestId('device-card-device-001')).toBeInTheDocument();
      // Pixel 6 should be online (lastSeen is recent)
      const pixel = screen.getByTestId('device-card-device-001');
      expect(pixel.querySelector('[data-testid="badge-online"]')).toBeInTheDocument();
    });
  });

  it('shows setup button for devices needing setup', async () => {
    renderDevices();
    await waitFor(() => {
      expect(screen.getByTestId('setup-btn-device-002')).toBeInTheDocument();
    });
  });

  it('does not show setup button for up-to-date devices', async () => {
    renderDevices();
    await waitFor(() => {
      expect(screen.queryByTestId('setup-btn-device-001')).not.toBeInTheDocument();
    });
  });

  it('shows rooted badge', async () => {
    renderDevices();
    await waitFor(() => {
      const pixel = screen.getByTestId('device-card-device-001');
      expect(pixel.querySelector('[data-testid="badge-rooted"]')).toBeInTheDocument();
    });
  });

  it('does not show setup button for iOS devices', async () => {
    renderDevices();
    await waitFor(() => {
      expect(screen.getByText('iPhone 14')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('setup-btn-device-003')).not.toBeInTheDocument();
  });

  it('opens setup wizard modal when clicking Setup Required', async () => {
    renderDevices();
    await waitFor(() => {
      expect(screen.getByTestId('setup-btn-device-002')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('setup-btn-device-002'));

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard')).toBeInTheDocument();
      expect(screen.getByText(/Device Setup — Galaxy S21/)).toBeInTheDocument();
    });
  });

  it('closes setup wizard modal via Close button', async () => {
    renderDevices();
    await waitFor(() => {
      expect(screen.getByTestId('setup-btn-device-002')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('setup-btn-device-002'));
    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Close'));
    await waitFor(() => {
      expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument();
    });
  });
});
