import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SetupWizardModal } from './SetupWizardModal';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import type { Device } from '../../../shared/types/api';

// jsdom doesn't implement HTMLDialogElement methods
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'device-001',
    name: 'Pixel 6',
    platform: 'android',
    isRooted: true,
    setupVersion: 1,
    bridgePort: 9100,
    lastSeen: new Date().toISOString(),
    isOnline: true,
    isBusy: false,
    batteryLevel: 85,
    manufacturer: 'Google',
    model: 'Pixel 6',
    androidVersion: '13',
    iosVersion: null,
    apiLevel: 33,
    cpuAbi: 'arm64-v8a',
    serialNumber: 'abc123',
    bootloaderLocked: false,
    ...overrides,
  };
}

function createMockWs(sendRestApi?: WebSocketContextValue['sendRestApi']): WebSocketContextValue {
  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi: sendRestApi ?? vi.fn().mockResolvedValue({ status: 200, body: {} }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderModal(device: Device, ws?: WebSocketContextValue, handlers?: { onClose?: () => void; onSetupComplete?: () => void }) {
  const onClose = handlers?.onClose ?? vi.fn();
  const onSetupComplete = handlers?.onSetupComplete ?? vi.fn();
  const wsCtx = ws ?? createMockWs();
  const result = render(
    <WebSocketContext.Provider value={wsCtx}>
      <SetupWizardModal device={device} onClose={onClose} onSetupComplete={onSetupComplete} />
    </WebSocketContext.Provider>
  );
  return { ...result, onClose, onSetupComplete, ws: wsCtx };
}

describe('SetupWizardModal', () => {
  it('renders modal with device name in title', () => {
    renderModal(makeDevice({ name: 'Pixel 6' }));
    expect(screen.getByText(/Device Setup — Pixel 6/)).toBeInTheDocument();
  });

  it('uses device id in title when name is null', () => {
    renderModal(makeDevice({ name: null, id: 'emulator-5554' }));
    expect(screen.getByText(/Device Setup — emulator-5554/)).toBeInTheDocument();
  });

  it('shows all 4 setup steps', () => {
    renderModal(makeDevice({ setupVersion: 0 }));
    expect(screen.getByTestId('setup-step-1')).toBeInTheDocument();
    expect(screen.getByTestId('setup-step-2')).toBeInTheDocument();
    expect(screen.getByTestId('setup-step-3')).toBeInTheDocument();
    expect(screen.getByTestId('setup-step-4')).toBeInTheDocument();
  });

  it('marks completed steps with Done badge based on setupVersion', () => {
    renderModal(makeDevice({ setupVersion: 2 }));
    // Steps 1 and 2 should be done
    const step1 = screen.getByTestId('setup-step-1');
    const step2 = screen.getByTestId('setup-step-2');
    const step3 = screen.getByTestId('setup-step-3');
    expect(step1.querySelector('.badge-success')).toBeInTheDocument();
    expect(step2.querySelector('.badge-success')).toBeInTheDocument();
    expect(step3.querySelector('.badge-success')).not.toBeInTheDocument();
  });

  it('shows pending step count', () => {
    renderModal(makeDevice({ setupVersion: 1 }));
    expect(screen.getByText(/3 steps remaining/)).toBeInTheDocument();
  });

  it('shows singular "step" for single remaining', () => {
    renderModal(makeDevice({ setupVersion: 3 }));
    expect(screen.getByText(/1 step remaining/)).toBeInTheDocument();
  });

  it('shows "Requires root" warning on root-dependent steps for non-rooted devices', () => {
    renderModal(makeDevice({ isRooted: false, setupVersion: 0 }));
    const badges = screen.getAllByText('Requires root');
    // Steps 2 (WireGuard) and 3 (Frida) require root
    expect(badges).toHaveLength(2);
  });

  it('does not show "Requires root" warning on rooted devices', () => {
    renderModal(makeDevice({ isRooted: true, setupVersion: 0 }));
    expect(screen.queryByText('Requires root')).not.toBeInTheDocument();
  });

  it('does not show "Requires root" for already-completed root steps', () => {
    // setupVersion 3 means steps 1-3 are done, only step 4 pending (not root-required)
    renderModal(makeDevice({ isRooted: false, setupVersion: 3 }));
    expect(screen.queryByText('Requires root')).not.toBeInTheDocument();
  });

  it('shows "fully configured" message when setupVersion >= CURRENT_SETUP_VERSION', () => {
    renderModal(makeDevice({ setupVersion: 4 }));
    expect(screen.getByText('This device is fully configured.')).toBeInTheDocument();
  });

  it('hides Run Setup button when fully configured', () => {
    renderModal(makeDevice({ setupVersion: 4 }));
    expect(screen.queryByTestId('run-setup-btn')).not.toBeInTheDocument();
  });

  it('shows Run Setup button when not fully configured', () => {
    renderModal(makeDevice({ setupVersion: 2 }));
    expect(screen.getByTestId('run-setup-btn')).toBeInTheDocument();
    expect(screen.getByTestId('run-setup-btn')).toHaveTextContent('Run Setup');
  });

  it('calls setup API and onSetupComplete on Run Setup click', async () => {
    const sendRestApi = vi.fn().mockResolvedValue({ status: 200, body: {} });
    const { onSetupComplete } = renderModal(
      makeDevice({ id: 'dev-99', setupVersion: 1 }),
      createMockWs(sendRestApi),
    );

    fireEvent.click(screen.getByTestId('run-setup-btn'));

    await waitFor(() => {
      expect(sendRestApi).toHaveBeenCalledWith('POST', '/v1/device/setup/dev-99');
      expect(onSetupComplete).toHaveBeenCalled();
    });
  });

  it('shows error message when setup API fails', async () => {
    const sendRestApi = vi.fn().mockRejectedValue(new Error('Device offline'));
    renderModal(makeDevice({ setupVersion: 0 }), createMockWs(sendRestApi));

    fireEvent.click(screen.getByTestId('run-setup-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('setup-error')).toHaveTextContent('Device offline');
    });
  });

  it('shows fallback error message when error has no message', async () => {
    const sendRestApi = vi.fn().mockRejectedValue(new Error(''));
    renderModal(makeDevice({ setupVersion: 0 }), createMockWs(sendRestApi));

    fireEvent.click(screen.getByTestId('run-setup-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('setup-error')).toHaveTextContent('Setup failed');
    });
  });

  it('disables Run Setup button while running', async () => {
    let resolveSetup: (value: any) => void;
    const sendRestApi = vi.fn().mockReturnValue(new Promise(r => { resolveSetup = r; }));
    renderModal(makeDevice({ setupVersion: 0 }), createMockWs(sendRestApi));

    fireEvent.click(screen.getByTestId('run-setup-btn'));

    expect(screen.getByTestId('run-setup-btn')).toBeDisabled();
    expect(screen.getByTestId('run-setup-btn')).toHaveTextContent('Running Setup…');

    resolveSetup!({ status: 200, body: {} });
    await waitFor(() => {
      expect(screen.getByTestId('run-setup-btn')).not.toBeDisabled();
    });
  });

  it('closes modal via Close button', () => {
    const { onClose } = renderModal(makeDevice());
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes modal via overlay click', () => {
    const { onClose } = renderModal(makeDevice());
    fireEvent.click(screen.getByTestId('modal-overlay'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside modal content', () => {
    const { onClose } = renderModal(makeDevice());
    fireEvent.click(screen.getByTestId('setup-wizard'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
