import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-pty before importing handler
const mockPtyProcess = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPtyProcess),
}));

import { registerHostShellEndpoints } from './host-shell-handlers';
import { getWebsocketHandler, clearWebsocketHandlers } from './handlers';
import * as pty from 'node-pty';

function createMockSocket() {
  const listeners = new Map<string, Function[]>();
  return {
    OPEN: 1,
    readyState: 1,
    send: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    }),
    _emit(event: string) {
      for (const cb of listeners.get(event) || []) cb();
    },
    _listeners: listeners,
  } as any;
}

describe('Host Shell Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWebsocketHandlers();
    mockPtyProcess.onData.mockReset();
    mockPtyProcess.onExit.mockReset();
    mockPtyProcess.write.mockReset();
    mockPtyProcess.resize.mockReset();
    mockPtyProcess.kill.mockReset();
    registerHostShellEndpoints();
  });

  describe('host-shell/start', () => {
    it('should spawn host shell with shell binary and correct cols/rows', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('host-shell/start')!.handler;
      handler({ sessionId: 'sess1', cols: 100, rows: 30 }, socket);

      const expectedShell = process.env.SHELL || 'bash';
      expect(pty.spawn).toHaveBeenCalledWith(
        expectedShell,
        [],
        expect.objectContaining({ cols: 100, rows: 30, name: 'xterm-256color' }),
      );

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'host-shell/started', sessionId: 'sess1' }),
      );
    });

    it('should use default cols/rows when not provided', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('host-shell/start')!.handler;
      handler({ sessionId: 'sess1' }, socket);

      expect(pty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({ cols: 80, rows: 24 }),
      );
    });

    it('should require sessionId — no spawn without it', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('host-shell/start')!.handler;
      handler({}, socket);

      expect(pty.spawn).not.toHaveBeenCalled();
      expect(socket.send).not.toHaveBeenCalled();
    });

    it('should support multiple concurrent sessions on the same socket', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('host-shell/start')!.handler;

      handler({ sessionId: 'sess1' }, socket);
      handler({ sessionId: 'sess2' }, socket);

      expect(pty.spawn).toHaveBeenCalledTimes(2);
      // Neither session should have been killed
      expect(mockPtyProcess.kill).not.toHaveBeenCalled();
    });

    it('should forward pty output data to socket with sessionId', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('host-shell/start')!.handler;
      handler({ sessionId: 'sess1' }, socket);

      const onDataCb = mockPtyProcess.onData.mock.calls[0][0];
      onDataCb('hello world');

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'host-shell/output', sessionId: 'sess1', data: 'hello world' }),
      );
    });

    it('should send exit message with sessionId when pty exits', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('host-shell/start')!.handler;
      handler({ sessionId: 'sess1' }, socket);

      const onExitCb = mockPtyProcess.onExit.mock.calls[0][0];
      onExitCb({ exitCode: 0 });

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'host-shell/exit', sessionId: 'sess1', exitCode: 0 }),
      );
    });
  });

  describe('host-shell/input', () => {
    it('should forward input to the correct pty session', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('host-shell/start')!.handler;
      startHandler({ sessionId: 'sess1' }, socket);

      const inputHandler = getWebsocketHandler('host-shell/input')!.handler;
      inputHandler({ sessionId: 'sess1', data: 'ls -la\n' }, socket);

      expect(mockPtyProcess.write).toHaveBeenCalledWith('ls -la\n');
    });

    it('should be no-op without active session', () => {
      const socket = createMockSocket();
      const inputHandler = getWebsocketHandler('host-shell/input')!.handler;
      inputHandler({ sessionId: 'nosuchsession', data: 'ls\n' }, socket);

      expect(mockPtyProcess.write).not.toHaveBeenCalled();
    });
  });

  describe('host-shell/resize', () => {
    it('should resize the correct pty session', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('host-shell/start')!.handler;
      startHandler({ sessionId: 'sess1' }, socket);

      const resizeHandler = getWebsocketHandler('host-shell/resize')!.handler;
      resizeHandler({ sessionId: 'sess1', cols: 120, rows: 40 }, socket);

      expect(mockPtyProcess.resize).toHaveBeenCalledWith(120, 40);
    });

    it('should not resize with invalid dimensions', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('host-shell/start')!.handler;
      startHandler({ sessionId: 'sess1' }, socket);

      const resizeHandler = getWebsocketHandler('host-shell/resize')!.handler;
      resizeHandler({ sessionId: 'sess1', cols: 0, rows: 24 }, socket);

      expect(mockPtyProcess.resize).not.toHaveBeenCalled();
    });
  });

  describe('host-shell/stop', () => {
    it('should kill pty and send exit message with sessionId', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('host-shell/start')!.handler;
      startHandler({ sessionId: 'sess1' }, socket);

      const stopHandler = getWebsocketHandler('host-shell/stop')!.handler;
      stopHandler({ sessionId: 'sess1' }, socket);

      expect(mockPtyProcess.kill).toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'host-shell/exit', sessionId: 'sess1', exitCode: 0 }),
      );
    });

    it('should only stop the specified session, not others', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('host-shell/start')!.handler;

      // We need two distinct pty mocks; the mock always returns the same object,
      // so just verify kill is called exactly once after stopping one of two sessions.
      startHandler({ sessionId: 'sess1' }, socket);
      startHandler({ sessionId: 'sess2' }, socket);

      vi.clearAllMocks();
      mockPtyProcess.kill.mockReset();

      const stopHandler = getWebsocketHandler('host-shell/stop')!.handler;
      stopHandler({ sessionId: 'sess1' }, socket);

      expect(mockPtyProcess.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe('socket close cleanup', () => {
    it('should kill all sessions when socket closes', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('host-shell/start')!.handler;

      handler({ sessionId: 'sess1' }, socket);
      handler({ sessionId: 'sess2' }, socket);

      // Simulate socket close
      socket._emit('close');

      // kill called once per session (2 sessions, same mock object)
      expect(mockPtyProcess.kill).toHaveBeenCalledTimes(2);
    });
  });
});
