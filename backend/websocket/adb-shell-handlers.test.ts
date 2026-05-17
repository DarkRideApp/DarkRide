import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { registerAdbShellEndpoints } from './adb-shell-handlers';
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

describe('ADB Shell Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWebsocketHandlers();
    // Reset mock implementations
    mockPtyProcess.onData.mockReset();
    mockPtyProcess.onExit.mockReset();
    mockPtyProcess.write.mockReset();
    mockPtyProcess.resize.mockReset();
    mockPtyProcess.kill.mockReset();
    registerAdbShellEndpoints();
  });

  describe('adb-shell/start', () => {
    it('should spawn pty and send started message', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('adb-shell/start')!.handler;
      handler({ deviceId: 'DEV001', sessionId: 'sess1', cols: 80, rows: 24 }, socket);

      expect(pty.spawn).toHaveBeenCalledWith(
        'adb',
        ['-s', 'DEV001', 'shell'],
        expect.objectContaining({ cols: 80, rows: 24, name: 'xterm-256color' }),
      );

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'adb-shell/started', sessionId: 'sess1', deviceId: 'DEV001' }),
      );
    });

    it('should default sessionId to _default when not provided', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('adb-shell/start')!.handler;
      handler({ deviceId: 'DEV001', cols: 80, rows: 24 }, socket);

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'adb-shell/started', sessionId: '_default', deviceId: 'DEV001' }),
      );
    });

    it('should use default cols/rows when not provided', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('adb-shell/start')!.handler;
      handler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);

      expect(pty.spawn).toHaveBeenCalledWith(
        'adb',
        ['-s', 'DEV001', 'shell'],
        expect.objectContaining({ cols: 80, rows: 24 }),
      );
    });

    it('should do nothing if deviceId is missing', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('adb-shell/start')!.handler;
      handler({}, socket);

      expect(pty.spawn).not.toHaveBeenCalled();
      expect(socket.send).not.toHaveBeenCalled();
    });

    it('should kill existing session with same sessionId before starting new one', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('adb-shell/start')!.handler;

      // Start first session with same sessionId
      handler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);
      expect(mockPtyProcess.kill).not.toHaveBeenCalled();

      // Start second session with same sessionId — should kill first
      handler({ deviceId: 'DEV002', sessionId: 'sess1' }, socket);
      expect(mockPtyProcess.kill).toHaveBeenCalledTimes(1);
    });

    it('should allow multiple concurrent sessions with different sessionIds', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('adb-shell/start')!.handler;

      // Start two sessions on same socket with different sessionIds
      handler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);
      handler({ deviceId: 'DEV002', sessionId: 'sess2' }, socket);

      // Neither should have been killed
      expect(mockPtyProcess.kill).not.toHaveBeenCalled();
      expect(pty.spawn).toHaveBeenCalledTimes(2);

      // Both started messages should have been sent with correct sessionIds
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'adb-shell/started', sessionId: 'sess1', deviceId: 'DEV001' }),
      );
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'adb-shell/started', sessionId: 'sess2', deviceId: 'DEV002' }),
      );
    });

    it('should forward pty output data to socket with sessionId', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('adb-shell/start')!.handler;
      handler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);

      // Get the onData callback
      const onDataCb = mockPtyProcess.onData.mock.calls[0][0];
      onDataCb('hello world');

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'adb-shell/output', sessionId: 'sess1', deviceId: 'DEV001', data: 'hello world' }),
      );
    });

    it('should send exit message with sessionId when pty exits', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('adb-shell/start')!.handler;
      handler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);

      // Get the onExit callback
      const onExitCb = mockPtyProcess.onExit.mock.calls[0][0];
      onExitCb({ exitCode: 0 });

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'adb-shell/exit', sessionId: 'sess1', deviceId: 'DEV001', exitCode: 0 }),
      );
    });
  });

  describe('adb-shell/input', () => {
    it('should write data to pty process', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('adb-shell/start')!.handler;
      startHandler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);

      const inputHandler = getWebsocketHandler('adb-shell/input')!.handler;
      inputHandler({ sessionId: 'sess1', data: 'ls -la\n' }, socket);

      expect(mockPtyProcess.write).toHaveBeenCalledWith('ls -la\n');
    });

    it('should default sessionId to _default when not provided', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('adb-shell/start')!.handler;
      startHandler({ deviceId: 'DEV001' }, socket);

      const inputHandler = getWebsocketHandler('adb-shell/input')!.handler;
      inputHandler({ data: 'ls\n' }, socket);

      expect(mockPtyProcess.write).toHaveBeenCalledWith('ls\n');
    });

    it('should be no-op without active session', () => {
      const socket = createMockSocket();
      const inputHandler = getWebsocketHandler('adb-shell/input')!.handler;
      inputHandler({ sessionId: 'sess1', data: 'ls\n' }, socket);

      expect(mockPtyProcess.write).not.toHaveBeenCalled();
    });

    it('should route input to correct session when multiple sessions exist', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('adb-shell/start')!.handler;

      const mockPtyProcess2 = {
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };

      const spawnMock = vi.mocked(pty.spawn);
      spawnMock
        .mockReturnValueOnce(mockPtyProcess as any)
        .mockReturnValueOnce(mockPtyProcess2 as any);

      startHandler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);
      startHandler({ deviceId: 'DEV002', sessionId: 'sess2' }, socket);

      const inputHandler = getWebsocketHandler('adb-shell/input')!.handler;
      inputHandler({ sessionId: 'sess2', data: 'pwd\n' }, socket);

      expect(mockPtyProcess.write).not.toHaveBeenCalled();
      expect(mockPtyProcess2.write).toHaveBeenCalledWith('pwd\n');
    });
  });

  describe('adb-shell/resize', () => {
    it('should resize pty process', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('adb-shell/start')!.handler;
      startHandler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);

      const resizeHandler = getWebsocketHandler('adb-shell/resize')!.handler;
      resizeHandler({ sessionId: 'sess1', cols: 120, rows: 40 }, socket);

      expect(mockPtyProcess.resize).toHaveBeenCalledWith(120, 40);
    });

    it('should not resize with invalid dimensions', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('adb-shell/start')!.handler;
      startHandler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);

      const resizeHandler = getWebsocketHandler('adb-shell/resize')!.handler;
      resizeHandler({ sessionId: 'sess1', cols: 0, rows: 24 }, socket);

      expect(mockPtyProcess.resize).not.toHaveBeenCalled();
    });
  });

  describe('adb-shell/stop', () => {
    it('should kill pty and send exit message with sessionId', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('adb-shell/start')!.handler;
      startHandler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);

      const stopHandler = getWebsocketHandler('adb-shell/stop')!.handler;
      stopHandler({ sessionId: 'sess1' }, socket);

      expect(mockPtyProcess.kill).toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'adb-shell/exit', sessionId: 'sess1', deviceId: 'DEV001', exitCode: 0 }),
      );
    });

    it('should only stop the targeted session', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('adb-shell/start')!.handler;

      const mockPtyProcess2 = {
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };

      const spawnMock = vi.mocked(pty.spawn);
      spawnMock
        .mockReturnValueOnce(mockPtyProcess as any)
        .mockReturnValueOnce(mockPtyProcess2 as any);

      startHandler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);
      startHandler({ deviceId: 'DEV002', sessionId: 'sess2' }, socket);

      const stopHandler = getWebsocketHandler('adb-shell/stop')!.handler;
      stopHandler({ sessionId: 'sess1' }, socket);

      expect(mockPtyProcess.kill).toHaveBeenCalled();
      expect(mockPtyProcess2.kill).not.toHaveBeenCalled();
    });
  });

  describe('socket close cleanup', () => {
    it('should kill pty when socket closes', () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('adb-shell/start')!.handler;
      handler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);

      // Simulate socket close
      socket._emit('close');

      expect(mockPtyProcess.kill).toHaveBeenCalled();
    });

    it('should kill all sessions when socket closes', () => {
      const socket = createMockSocket();
      const startHandler = getWebsocketHandler('adb-shell/start')!.handler;

      const mockPtyProcess2 = {
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };

      const spawnMock = vi.mocked(pty.spawn);
      spawnMock
        .mockReturnValueOnce(mockPtyProcess as any)
        .mockReturnValueOnce(mockPtyProcess2 as any);

      startHandler({ deviceId: 'DEV001', sessionId: 'sess1' }, socket);
      startHandler({ deviceId: 'DEV002', sessionId: 'sess2' }, socket);

      socket._emit('close');

      expect(mockPtyProcess.kill).toHaveBeenCalled();
      expect(mockPtyProcess2.kill).toHaveBeenCalled();
    });
  });
});
