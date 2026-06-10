import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { InstallDeviceModal } from './InstallDeviceModal';

const devices = [
  { id: 'pixel7', name: 'Pixel 7 Pro', lastSeen: new Date().toISOString() },
  { id: 'emu1', name: null, lastSeen: new Date().toISOString() },
];

function mockWs(installStatus = 200): WebSocketContextValue {
  return {
    connected: true, serverReady: true, startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (path.startsWith('/v1/device/package-version/pixel7/')) {
        return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: { installed: true, versionCode: 100, versionName: '10.0' } } });
      }
      if (path.startsWith('/v1/device/package-version/')) {
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: { installed: false, versionCode: null, versionName: null } } });
      }
      if (method === 'POST' && path.startsWith('/v1/apps/install/')) {
        return Promise.resolve({ type: 'restapi', id: '3', status: installStatus, body: installStatus === 200 ? { success: true } : { success: false, error: 'INSTALL_FAILED_DOWNGRADE' } });
      }
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderModal(ws = mockWs(), onClose = vi.fn()) {
  render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <InstallDeviceModal
          versionId={55} packageName="com.x" versionName="11.0" versionCode={110}
          devices={devices} onClose={onClose}
        />
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
  return { ws, onClose };
}

describe('InstallDeviceModal', () => {
  it('lists online devices with upgrade hints', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText(/Installed: v10.0/)).toBeInTheDocument());
    expect(screen.getByText(/upgrade/)).toBeInTheDocument();
    expect(screen.getByText('Not installed')).toBeInTheDocument();
  });

  it('installs to the chosen device and closes on success', async () => {
    const { ws, onClose } = renderModal();
    await waitFor(() => screen.getByTestId('install-device-pixel7'));
    fireEvent.click(screen.getByTestId('install-device-pixel7'));
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/apps/install/pixel7', { apkVersionId: 55 }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows install errors inline', async () => {
    renderModal(mockWs(500));
    await waitFor(() => screen.getByTestId('install-device-pixel7'));
    fireEvent.click(screen.getByTestId('install-device-pixel7'));
    await waitFor(() => expect(screen.getByTestId('install-error')).toHaveTextContent('INSTALL_FAILED_DOWNGRADE'));
  });

  it('shows a downgrade hint when the device has a newer version', async () => {
    // Device has versionCode 100; install a lower target (90) → downgrade.
    render(
      <WebSocketContext.Provider value={mockWs()}>
        <ToastProvider>
          <InstallDeviceModal versionId={55} packageName="com.x" versionName="9.0" versionCode={90} devices={devices} onClose={vi.fn()} />
        </ToastProvider>
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText(/downgrade/)).toBeInTheDocument());
  });

  it('shows a "(same)" hint when the device already has this version', async () => {
    render(
      <WebSocketContext.Provider value={mockWs()}>
        <ToastProvider>
          <InstallDeviceModal versionId={55} packageName="com.x" versionName="10.0" versionCode={100} devices={devices} onClose={vi.fn()} />
        </ToastProvider>
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText(/\(same\)/)).toBeInTheDocument());
  });

  it('clears a prior install error when a new attempt starts', async () => {
    // First attempt fails (500), then a ws whose install succeeds.
    const failing = mockWs(500);
    let succeed = false;
    (failing.sendRestApi as any).mockImplementation((method: string, path: string) => {
      if (path.startsWith('/v1/device/package-version/pixel7/')) return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: { installed: true, versionCode: 100, versionName: '10.0' } } });
      if (path.startsWith('/v1/device/package-version/')) return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: { installed: false, versionCode: null, versionName: null } } });
      if (method === 'POST' && path.startsWith('/v1/apps/install/')) {
        return succeed
          ? Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true } })
          : Promise.resolve({ type: 'restapi', id: '3', status: 500, body: { success: false, error: 'INSTALL_FAILED_DOWNGRADE' } });
      }
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true, data: [] } });
    });
    render(
      <WebSocketContext.Provider value={failing}>
        <ToastProvider>
          <InstallDeviceModal versionId={55} packageName="com.x" versionName="11.0" versionCode={110} devices={devices} onClose={vi.fn()} />
        </ToastProvider>
      </WebSocketContext.Provider>,
    );
    await waitFor(() => screen.getByTestId('install-device-pixel7'));
    fireEvent.click(screen.getByTestId('install-device-pixel7'));
    await waitFor(() => expect(screen.getByTestId('install-error')).toBeInTheDocument());
    succeed = true;
    fireEvent.click(screen.getByTestId('install-device-pixel7'));
    await waitFor(() => expect(screen.queryByTestId('install-error')).not.toBeInTheDocument());
  });
});
