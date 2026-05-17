/**
 * Registry of WebSocket channels whose broadcasts are filtered to subscribers.
 *
 * Plugins/services call registerFilteredChannel(name) once at init. After that,
 * broadcastToAll(message) only delivers to clients whose `subscriptions` set
 * contains message.type.
 *
 * Channels not in this registry behave as before: broadcastToAll sends to every
 * connected client. This makes the filter opt-in and backward compatible with
 * the existing 110+ broadcast call sites.
 */

interface ChannelEntry {
  requires: string[];
}

const filteredChannels = new Map<string, ChannelEntry>();

export function registerFilteredChannel(
  channel: string,
  opts: { requires?: string[] } = {},
): void {
  filteredChannels.set(channel, { requires: opts.requires ?? [] });
}

export function isFilteredChannel(channel: string): boolean {
  return filteredChannels.has(channel);
}

export function getRequiredScopes(channel: string): string[] {
  return filteredChannels.get(channel)?.requires ?? [];
}

/** Test-only — clear the registry between tests. */
export function __resetChannelRegistryForTest(): void {
  filteredChannels.clear();
}
