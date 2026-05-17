import type { WebSocket } from 'ws';
import { registerWebsocketEndpoint } from './handlers';
import { subscribe, subscribeAll, getRecentLogs, type LogEntry } from '../logs';

/** Per-client log subscription cleanup function */
const clientSubscriptions = new Map<WebSocket, () => void>();

export function registerLiveLogEndpoints(): void {
  registerWebsocketEndpoint('livelog/subscribe', (message, socket) => {
    // Clean up any previous subscription for this client
    const prev = clientSubscriptions.get(socket);
    if (prev) prev();

    const systemId: string | undefined = message.systemId;

    const sendLog = (entry: LogEntry) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({
        type: 'livelog',
        system: entry.system,
        datetime: entry.datetime,
        severity: entry.severity,
        message: entry.message,
        file: entry.file,
        line: entry.line,
      }));
    };

    // Replay recent log history before attaching the live listener
    const recent = getRecentLogs();
    const filtered = systemId ? recent.filter(e => e.system === systemId) : recent;
    for (const entry of filtered) sendLog(entry);

    const unsub = systemId
      ? subscribe(systemId, sendLog)
      : subscribeAll(sendLog);

    clientSubscriptions.set(socket, unsub);

    // Clean up on socket close
    socket.on('close', () => {
      const cleanup = clientSubscriptions.get(socket);
      if (cleanup) {
        cleanup();
        clientSubscriptions.delete(socket);
      }
    });
  });

  registerWebsocketEndpoint('livelog/unsubscribe', (_message, socket) => {
    const unsub = clientSubscriptions.get(socket);
    if (unsub) {
      unsub();
      clientSubscriptions.delete(socket);
    }
  });
}
