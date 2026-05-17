import type { WebSocket } from 'ws';
import { registerWebsocketEndpoint } from './handlers';
import * as pty from 'node-pty';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('host-shell');

interface HostShellSession {
  ptyProcess: pty.IPty;
  sessionId: string;
}

// Map<socket, Map<sessionId, session>>
const sessions = new Map<WebSocket, Map<string, HostShellSession>>();

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

export function registerHostShellEndpoints(): void {
  registerWebsocketEndpoint('host-shell/start', (message, socket) => {
    const sessionId: string = message.sessionId;
    if (!sessionId) return;

    const cols: number = message.cols || 80;
    const rows: number = message.rows || 24;

    const shell = process.env.SHELL || 'bash';

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      });
    } catch (err: any) {
      error(`Failed to spawn host shell (session ${sessionId}): ${err.message}`);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({
          type: 'host-shell/exit',
          sessionId,
          exitCode: 1,
        }));
      }
      return;
    }

    if (!sessions.has(socket)) {
      sessions.set(socket, new Map());
    }
    sessions.get(socket)!.set(sessionId, { ptyProcess, sessionId });

    ptyProcess.onData((data: string) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({
        type: 'host-shell/output',
        sessionId,
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
          type: 'host-shell/exit',
          sessionId,
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
        type: 'host-shell/started',
        sessionId,
      }));
    }

    log(`Host shell started (session ${sessionId})`);
  }, { requires: ['core.host:shell'] });


  registerWebsocketEndpoint('host-shell/input', (message, socket) => {
    const sessionId: string = message.sessionId;
    if (!sessionId) return;
    const session = sessions.get(socket)?.get(sessionId);
    if (!session) return;
    session.ptyProcess.write(message.data);
  }, { requires: ['core.host:shell'] });

  registerWebsocketEndpoint('host-shell/resize', (message, socket) => {
    const sessionId: string = message.sessionId;
    if (!sessionId) return;
    const session = sessions.get(socket)?.get(sessionId);
    if (!session) return;
    const cols: number = message.cols;
    const rows: number = message.rows;
    if (cols > 0 && rows > 0) {
      session.ptyProcess.resize(cols, rows);
    }
  }, { requires: ['core.host:shell'] });

  registerWebsocketEndpoint('host-shell/stop', (message, socket) => {
    const sessionId: string = message.sessionId;
    if (!sessionId) return;
    const socketSessions = sessions.get(socket);
    if (!socketSessions) return;
    const session = socketSessions.get(sessionId);
    if (!session) return;
    killSession(socket, sessionId);
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({
        type: 'host-shell/exit',
        sessionId,
        exitCode: 0,
      }));
    }
    log(`Host shell stopped (session ${sessionId})`);
  }, { requires: ['core.host:shell'] });
}
