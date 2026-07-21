import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AppDetailModal, type InstalledApp } from './AppDetailModal';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

// jsdom doesn't implement HTMLDialogElement methods (Modal uses <dialog>)
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});

function makeApp(overrides: Partial<InstalledApp> = {}): InstalledApp {
  return {
    packageName: 'com.example.app',
    appName: 'Example App',
    versionCode: 100,
    versionName: '1.0.0',
    isTracked: false,
    trackedAppId: null,
    ...overrides,
  };
}

function createMockWs(sendRestApi: WebSocketContextValue['sendRestApi']): WebSocketContextValue {
  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderModal(sendRestApi: WebSocketContextValue['sendRestApi'], app = makeApp()) {
  const ws = createMockWs(sendRestApi);
  render(
    <ToastProvider>
      <WebSocketContext.Provider value={ws}>
        <AppDetailModal deviceId="DEV001" app={app} onClose={vi.fn()} onAppUpdated={vi.fn()} />
      </WebSocketContext.Provider>
    </ToastProvider>
  );
  return { ws };
}

describe('AppDetailModal — install source', () => {
  it('fetches and shows the current install source with a friendly label', async () => {
    const sendRestApi = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path.includes('/install-source/')) {
        return { status: 200, body: { success: true, data: { packageName: 'com.example.app', installerPackageName: 'com.android.vending' } } };
      }
      return { status: 200, body: { success: true } };
    });
    renderModal(sendRestApi as any);

    await waitFor(() => {
      expect(screen.getByTestId('app-detail-install-source-current')).toHaveTextContent('Play Store');
    });
    expect(sendRestApi).toHaveBeenCalledWith(
      'GET',
      '/v1/device/apps/DEV001/install-source/com.example.app',
    );
  });

  it('shows "None / sideloaded" when no installer is recorded', async () => {
    const sendRestApi = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path.includes('/install-source/')) {
        return { status: 200, body: { success: true, data: { packageName: 'com.example.app', installerPackageName: null } } };
      }
      return { status: 200, body: { success: true } };
    });
    renderModal(sendRestApi as any);

    await waitFor(() => {
      expect(screen.getByTestId('app-detail-install-source-current')).toHaveTextContent('None / sideloaded');
    });
  });

  it('applies a chosen preset installer and updates the shown value', async () => {
    const sendRestApi = vi.fn(async (method: string, path: string, body?: any) => {
      if (method === 'GET' && path.includes('/install-source/')) {
        return { status: 200, body: { success: true, data: { packageName: 'com.example.app', installerPackageName: 'com.android.vending' } } };
      }
      if (method === 'PUT' && path.includes('/install-source/')) {
        return { status: 200, body: { success: true, data: { packageName: 'com.example.app', installerPackageName: body.installer } } };
      }
      return { status: 200, body: { success: true } };
    });
    renderModal(sendRestApi as any);

    // Wait for initial load.
    await waitFor(() => {
      expect(screen.getByTestId('app-detail-install-source-current')).toHaveTextContent('Play Store');
    });

    // Choose F-Droid and apply.
    fireEvent.change(screen.getByTestId('app-detail-install-source-select'), {
      target: { value: 'org.fdroid.fdroid' },
    });
    fireEvent.click(screen.getByTestId('app-detail-install-source-apply'));

    await waitFor(() => {
      expect(sendRestApi).toHaveBeenCalledWith(
        'PUT',
        '/v1/device/apps/DEV001/install-source/com.example.app',
        { installer: 'org.fdroid.fdroid' },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('app-detail-install-source-current')).toHaveTextContent('F-Droid');
    });
  });

  it('surfaces an error when the PUT fails', async () => {
    const sendRestApi = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path.includes('/install-source/')) {
        return { status: 200, body: { success: true, data: { packageName: 'com.example.app', installerPackageName: null } } };
      }
      if (method === 'PUT' && path.includes('/install-source/')) {
        return { status: 500, body: { success: false, error: 'Root access unavailable' } };
      }
      return { status: 200, body: { success: true } };
    });
    renderModal(sendRestApi as any);

    await waitFor(() => {
      expect(screen.getByTestId('app-detail-install-source-current')).toHaveTextContent('None / sideloaded');
    });

    fireEvent.change(screen.getByTestId('app-detail-install-source-select'), {
      target: { value: 'com.android.vending' },
    });
    fireEvent.click(screen.getByTestId('app-detail-install-source-apply'));

    await waitFor(() => {
      expect(screen.getByTestId('app-detail-install-source-error')).toHaveTextContent('Root access unavailable');
    });
  });
});
