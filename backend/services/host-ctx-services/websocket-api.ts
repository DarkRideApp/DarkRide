import type { WebsocketApi } from '@darkrideapp/plugin-sdk';

/**
 * WebsocketApi — thin wrapper for plugin ctx.websocket access.
 *
 * Mirrors the host's real surface:
 *   - `broadcast(message)` → broadcastToAll(message): sends a single message
 *     object whose `type` field selects the channel (used for filtered
 *     channels).
 *   - `registerChannel(channel, opts?)` → registerFilteredChannel(channel, opts):
 *     opts in the registry: `{ requires?: string[] }`.
 */
export interface WebsocketDeps {
  broadcastToAll: (message: Record<string, unknown>) => void;
  registerFilteredChannel: (channel: string, opts?: { requires?: string[] }) => void;
}

export function createWebsocketApi(deps: WebsocketDeps): WebsocketApi {
  return {
    broadcast(message) {
      deps.broadcastToAll(message);
    },
    registerChannel(channel, opts) {
      deps.registerFilteredChannel(channel, opts);
    },
  };
}
