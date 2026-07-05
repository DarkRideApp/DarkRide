import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

import { TerminalTab } from './TerminalTab';

let subscribers: Record<string, ((msg: any) => void)[]>;

function makeMockWs(): WebSocketContextValue {
  subscribers = {};
  return {
    connected: true,
    serverReady: true,
    startupMessage: 'Server ready',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: {} }),
    subscribe: vi.fn((type: string, cb: (msg: any) => void) => {
      (subscribers[type] ??= []).push(cb);
      return () => {
        subscribers[type] = (subscribers[type] || []).filter((fn) => fn !== cb);
      };
    }),
    subscribeBinary: vi.fn().mockReturnValue(() => {}),
  };
}

function emit(type: string, msg: any) {
  (subscribers[type] || []).forEach((cb) => cb(msg));
}

function renderTab(props: Partial<React.ComponentProps<typeof TerminalTab>> = {}, ws = makeMockWs()) {
  const defaults: React.ComponentProps<typeof TerminalTab> = {
    sessionId: 'sess-1',
    type: 'host',
    visible: true,
    onExit: vi.fn(),
  };
  const utils = render(
    <WebSocketContext.Provider value={ws}>
      <TerminalTab {...defaults} {...props} />
    </WebSocketContext.Provider>,
  );
  return { ...utils, ws };
}

describe('TerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the terminal container', () => {
    renderTab();
    expect(screen.getByTestId('terminal-tab-body')).toBeInTheDocument();
  });

  it('sends host-shell/start on mount for type=host', () => {
    const { ws } = renderTab({ type: 'host' });
    vi.runAllTimers();
    expect(ws.sendMessage).toHaveBeenCalledWith(
      'host-shell/start',
      expect.objectContaining({ sessionId: 'sess-1', cols: 80, rows: 24 }),
    );
  });

  it('sends adb-shell/start with deviceId for type=device', () => {
    const { ws } = renderTab({ type: 'device', deviceId: 'DEV001' });
    vi.runAllTimers();
    expect(ws.sendMessage).toHaveBeenCalledWith(
      'adb-shell/start',
      expect.objectContaining({ sessionId: 'sess-1', deviceId: 'DEV001', cols: 80, rows: 24 }),
    );
  });

  it('sends host-shell/stop on unmount', () => {
    const { ws, unmount } = renderTab({ type: 'host' });
    vi.runAllTimers();
    vi.clearAllMocks();
    unmount();
    expect(ws.sendMessage).toHaveBeenCalledWith('host-shell/stop', { sessionId: 'sess-1' });
  });

  it('subscribes to host-shell/output and host-shell/exit', () => {
    renderTab({ type: 'host' });
    expect(Object.keys(subscribers)).toEqual(
      expect.arrayContaining(['host-shell/output', 'host-shell/exit']),
    );
  });

  it('sends the initial command once, after the first output for this session', () => {
    const { ws } = renderTab({ type: 'host', initialCommand: 'claude login' });
    vi.runAllTimers();

    emit('host-shell/output', { sessionId: 'sess-1', data: '$ ' });
    expect(ws.sendMessage).toHaveBeenCalledWith('host-shell/input', {
      sessionId: 'sess-1',
      data: 'claude login\r',
    });

    vi.clearAllMocks();
    emit('host-shell/output', { sessionId: 'sess-1', data: 'more output' });
    expect(ws.sendMessage).not.toHaveBeenCalledWith('host-shell/input', expect.anything());
  });

  it('ignores output/exit events for other sessions', () => {
    const onExit = vi.fn();
    renderTab({ type: 'host', onExit });
    emit('host-shell/exit', { sessionId: 'other-session', exitCode: 1 });
    expect(onExit).not.toHaveBeenCalled();
    expect(mockTerminal.write).not.toHaveBeenCalled();
  });

  it('calls onExit and writes the exit banner when this session exits', () => {
    const onExit = vi.fn();
    renderTab({ type: 'host', onExit });
    emit('host-shell/exit', { sessionId: 'sess-1', exitCode: 0 });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(mockTerminal.write).toHaveBeenCalledWith(expect.stringContaining('exit code: 0'));
  });
});
