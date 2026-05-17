import type { WebSocket } from 'ws';
import { registerWebsocketEndpoint } from './handlers';
import * as pty from 'node-pty';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('adb-shell');

interface AdbShellSession {
  ptyProcess: pty.IPty;
  deviceId: string;
  sessionId: string;
}

// Map<socket, Map<sessionId, session>>
const sessions = new Map<WebSocket, Map<string, AdbShellSession>>();

function killSession(socket: WebSocket, sessionId: string): void {
  const socketSessions = sessions.get(socket);
  if (!socketSessions) return;
  const session = socketSessions.get(sessionId);
  if (!session) return;
  try {
    session.ptyProcess.kill();
  } catch {
    // already dead
  }
  socketSessions.delete(sessionId);
  if (socketSessions.size === 0) {
    sessions.delete(socket);
  }
}

function killAllSessions(socket: WebSocket): void {
  const socketSessions = sessions.get(socket);
  if (!socketSessions) return;
  for (const session of socketSessions.values()) {
    try {
      session.ptyProcess.kill();
    } catch {
      // already dead
    }
  }
  sessions.delete(socket);
}

export function registerAdbShellEndpoints(): void {
  registerWebsocketEndpoint('adb-shell/start', (message, socket) => {
    const deviceId: string = message.deviceId;
    if (!deviceId) return;

    const sessionId: string = message.sessionId ?? '_default';

    // Kill existing session with the same sessionId if any
    killSession(socket, sessionId);

    const cols: number = message.cols || 80;
    const rows: number = message.rows || 24;

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn('adb', ['-s', deviceId, 'shell'], {
        name: 'xterm-256color',
        cols,
        rows,
        env: process.env as Record<string, string>,
      });
    } catch (err: any) {
      error(`Failed to spawn ADB shell for ${deviceId} (session ${sessionId}): ${err.message}`);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({
          type: 'adb-shell/exit',
          sessionId,
          deviceId,
          exitCode: 1,
        }));
      }
      return;
    }

    if (!sessions.has(socket)) {
      sessions.set(socket, new Map());
    }
    sessions.get(socket)!.set(sessionId, { ptyProcess, deviceId, sessionId });

    ptyProcess.onData((data: string) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({
        type: 'adb-shell/output',
        sessionId,
        deviceId,
        data,
      }));
    });

    ptyProcess.onExit(({ exitCode }) => {
      // Only clean up if this is still the active session
      const socketSessions = sessions.get(socket);
      if (socketSessions?.get(sessionId)?.ptyProcess === ptyProcess) {
        socketSessions.delete(sessionId);
        if (socketSessions.size === 0) {
          sessions.delete(socket);
        }
      }
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({
          type: 'adb-shell/exit',
          sessionId,
          deviceId,
          exitCode: exitCode ?? 0,
        }));
      }
    });

    // Clean up all sessions for this socket on close
    socket.on('close', () => {
      killAllSessions(socket);
    });

    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({
        type: 'adb-shell/started',
        sessionId,
        deviceId,
      }));
    }

    log(`ADB shell started for device ${deviceId} (session ${sessionId})`);
  }, { requires: ['core.devices:shell'] });

  registerWebsocketEndpoint('adb-shell/input', (message, socket) => {
    const sessionId: string = message.sessionId ?? '_default';
    const session = sessions.get(socket)?.get(sessionId);
    if (!session) return;
    session.ptyProcess.write(message.data);
  }, { requires: ['core.devices:shell'] });

  registerWebsocketEndpoint('adb-shell/resize', (message, socket) => {
    const sessionId: string = message.sessionId ?? '_default';
    const session = sessions.get(socket)?.get(sessionId);
    if (!session) return;
    const cols: number = message.cols;
    const rows: number = message.rows;
    if (cols > 0 && rows > 0) {
      session.ptyProcess.resize(cols, rows);
    }
  }, { requires: ['core.devices:shell'] });

  registerWebsocketEndpoint('adb-shell/stop', (message, socket) => {
    const sessionId: string = message.sessionId ?? '_default';
    const socketSessions = sessions.get(socket);
    if (!socketSessions) return;
    const session = socketSessions.get(sessionId);
    if (!session) return;
    const { deviceId } = session;
    killSession(socket, sessionId);
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({
        type: 'adb-shell/exit',
        sessionId,
        deviceId,
        exitCode: 0,
      }));
    }
    log(`ADB shell stopped for device ${deviceId} (session ${sessionId})`);
  }, { requires: ['core.devices:shell'] });
}
