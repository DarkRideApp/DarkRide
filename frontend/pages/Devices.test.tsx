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

  it('surfaces emulator Stop/Delete on the device card when an instance backs the device', async () => {
    // Regression for the emulator-branch UX gap: once the docker-android
    // emulator's adb binds and the device card supersedes the instance
    // card, the user had no way to stop/delete the container from the UI.
    // We now thread the matched instance into the device card so its
    // footer renders Stop + Delete that target the instance lifecycle API.
    const emulatorDevice = {
      id: 'localhost:32770', name: 'localhost:32770', platform: 'android',
      isRooted: true, setupVersion: 4, bridgePort: null,
      lastSeen: new Date().toISOString(),
    };
    const matchingInstance = {
      id: 7, providerId: 'docker-android', runtimeId: 'container-abc',
      displayName: 'test', serial: 'localhost:32770', state: 'running',
      spawnedByDarkride: true,
    };
    const ws: WebSocketContextValue = {
      connected: true,
      sendMessage: vi.fn(),
      sendRestApi: vi.fn().mockImplementation(async (_method: string, path: string) => {
        if (path === '/v1/device/list') {
          return { type: 'restapi', id: '1', status: 200, body: { data: [emulatorDevice] } };
        }
        if (path === '/v1/devices/providers') {
          return { type: 'restapi', id: '2', status: 200, body: { data: { providers: [
            { id: 'docker-android', capabilities: { canCreate: true }, available: true },
          ] } } };
        }
        if (path === '/v1/devices/providers/docker-android/instances') {
          return { type: 'restapi', id: '3', status: 200, body: { data: { instances: [matchingInstance] } } };
        }
        return { type: 'restapi', id: '4', status: 200, body: { data: {} } };
      }),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };

    render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter>
            <Devices />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('emu-stop-localhost:32770')).toBeInTheDocument();
      expect(screen.getByTestId('emu-delete-localhost:32770')).toBeInTheDocument();
    });

    // Clicking Stop calls the instance-stop endpoint, not the device card's navigate.
    fireEvent.click(screen.getByTestId('emu-stop-localhost:32770'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/devices/providers/docker-android/instances/7/stop',
      );
    });
  });

  it('shows the instance card (not a stale device card) when the backing emulator is stopped', async () => {
    // Regression: when a docker-android emulator is stopped, the device row
    // from when it was running stays in the devices table (offline). Before
    // this fix the instance card was hidden by the serial-collision dedupe
    // and the user was left with an unactionable offline device card (no
    // Start, because Start is an instance-lifecycle op). The fix:
    //   1. Non-running instances always show their card (with Start).
    //   2. Stale device cards backed by a non-running instance are hidden.
    const staleDevice = {
      id: 'localhost:32770', name: 'localhost:32770', platform: 'android',
      isRooted: false, setupVersion: 0, bridgePort: null,
      lastSeen: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // yesterday
    };
    const stoppedInstance = {
      id: 9, providerId: 'docker-android', runtimeId: 'container-old',
      displayName: 'test-yesterday', serial: 'localhost:32770', state: 'stopped',
      spawnedByDarkride: true,
    };
    const ws: WebSocketContextValue = {
      connected: true,
      sendMessage: vi.fn(),
      sendRestApi: vi.fn().mockImplementation(async (_method: string, path: string) => {
        if (path === '/v1/device/list') {
          return { type: 'restapi', id: '1', status: 200, body: { data: [staleDevice] } };
        }
        if (path === '/v1/devices/providers') {
          return { type: 'restapi', id: '2', status: 200, body: { data: { providers: [
            { id: 'docker-android', capabilities: { canCreate: true }, available: true },
          ] } } };
        }
        if (path === '/v1/devices/providers/docker-android/instances') {
          return { type: 'restapi', id: '3', status: 200, body: { data: { instances: [stoppedInstance] } } };
        }
        return { type: 'restapi', id: '4', status: 200, body: { data: {} } };
      }),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };

    render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter>
            <Devices />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>
    );

    // The instance card should be visible (it owns the lifecycle controls).
    await waitFor(() => {
      expect(screen.getByText('test-yesterday')).toBeInTheDocument();
    });
    // The stale device card must NOT also be on the page.
    expect(screen.queryByTestId('device-card-localhost:32770')).not.toBeInTheDocument();
  });
});
