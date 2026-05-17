import type { WebSocket } from 'ws';

type WebSocketHandler = (message: any, socket: WebSocket) => void | Promise<void>;

interface WsEndpointEntry {
  handler: WebSocketHandler;
  requires?: string[];
}

const wsHandlers = new Map<string, WsEndpointEntry>();

export function registerWebsocketEndpoint(
  actionId: string,
  handler: WebSocketHandler,
  opts?: { requires?: string[] },
): void {
  wsHandlers.set(actionId, { handler, requires: opts?.requires });
}

export function getWebsocketHandler(actionId: string): WsEndpointEntry | undefined {
  return wsHandlers.get(actionId);
}

export function clearWebsocketHandlers(): void {
  wsHandlers.clear();
}
