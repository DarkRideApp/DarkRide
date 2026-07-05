import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

// Polyfill ResizeObserver for jsdom
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;

// Mock xterm
const mockTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  write: vi.fn(),
  onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  dispose: vi.fn(),
  parser: {
    registerOscHandler: vi.fn(),
  },
  attachCustomKeyEventHandler: vi.fn(),
  hasSelection: vi.fn().mockReturnValue(false),
  getSelection: vi.fn().mockReturnValue(''),
  cols: 80,
  rows: 24,
};

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => mockTerminal),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: vi.fn(),
  })),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(() => ({ name: 'web-links' })),
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { AdbShell } from './AdbShell';

const mockWs: WebSocketContextValue = {
  connected: true,
  serverReady: true,
  startupMessage: 'Server ready',
  sendMessage: vi.fn(),
  sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: {} }),
  subscribe: vi.fn().mockReturnValue(() => {}),
  subscribeBinary: vi.fn().mockReturnValue(() => {}),
};

function renderAdbShell(onClose = vi.fn()) {
  return render(
    <WebSocketContext.Provider value={mockWs}>
      <AdbShell deviceId="DEV001" onClose={onClose} />
    </WebSocketContext.Provider>,
  );
}

describe('AdbShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset requestAnimationFrame mock
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders header with close button', () => {
    renderAdbShell();
    expect(screen.getByText('ADB Shell')).toBeInTheDocument();
    expect(screen.getByTestId('adb-shell-close')).toBeInTheDocument();
  });

  it('close button calls onClose', () => {
    const onClose = vi.fn();
    renderAdbShell(onClose);
    fireEvent.click(screen.getByTestId('adb-shell-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends adb-shell/start on mount', () => {
    renderAdbShell();
    expect(mockWs.sendMessage).toHaveBeenCalledWith('adb-shell/start', expect.objectContaining({
      deviceId: 'DEV001',
      cols: 80,
      rows: 24,
    }));
  });

  it('sends adb-shell/stop on unmount', () => {
    const { unmount } = renderAdbShell();
    vi.clearAllMocks();
    unmount();
    expect(mockWs.sendMessage).toHaveBeenCalledWith('adb-shell/stop', {});
  });

  it('terminal container element exists', () => {
    renderAdbShell();
    expect(screen.getByTestId('adb-shell-body')).toBeInTheDocument();
  });

  it('subscribes to adb-shell/output and adb-shell/exit', () => {
    renderAdbShell();
    const subscribedTypes = (mockWs.subscribe as any).mock.calls.map((c: any[]) => c[0]);
    expect(subscribedTypes).toContain('adb-shell/output');
    expect(subscribedTypes).toContain('adb-shell/exit');
  });

  it('does NOT allow OSC 52 clipboard auto-copy (a connected device is untrusted output)', () => {
    renderAdbShell();
    expect(mockTerminal.parser.registerOscHandler).not.toHaveBeenCalled();
  });
});
