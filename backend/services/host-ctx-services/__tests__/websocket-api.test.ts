import { describe, it, expect, vi } from 'vitest';
import { createWebsocketApi } from '../websocket-api';

describe('WebsocketApi', () => {
  it('broadcast forwards the message object to broadcastToAll', () => {
    const broadcastToAll = vi.fn();
    const registerFilteredChannel = vi.fn();
    const api = createWebsocketApi({ broadcastToAll, registerFilteredChannel });
    api.broadcast({ type: 'test:channel', foo: 1 });
    expect(broadcastToAll).toHaveBeenCalledWith({ type: 'test:channel', foo: 1 });
  });

  it('registerChannel forwards channel name and opts', () => {
    const broadcastToAll = vi.fn();
    const registerFilteredChannel = vi.fn();
    const api = createWebsocketApi({ broadcastToAll, registerFilteredChannel });

    api.registerChannel('tile-updates', { requires: ['scope:read'] });
    expect(registerFilteredChannel).toHaveBeenCalledWith('tile-updates', { requires: ['scope:read'] });
  });

  it('registerChannel without opts forwards undefined opts', () => {
    const broadcastToAll = vi.fn();
    const registerFilteredChannel = vi.fn();
    const api = createWebsocketApi({ broadcastToAll, registerFilteredChannel });

    api.registerChannel('public-channel');
    expect(registerFilteredChannel).toHaveBeenCalledWith('public-channel', undefined);
  });
});
