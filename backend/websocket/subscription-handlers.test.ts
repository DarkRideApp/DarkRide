import { describe, it, expect, beforeEach, vi } from 'vitest';
import { broadcastToAll, getConnectedClients } from './index';
import { registerFilteredChannel, __resetChannelRegistryForTest } from './channel-registry';

interface FakeWebSocket {
  readyState: number;
  sent: string[];
  subscriptions?: Set<string>;
  send: (data: string) => void;
}

function makeFakeClient(): FakeWebSocket {
  const sent: string[] = [];
  return {
    readyState: 1, // OPEN
    sent,
    send: (data: string) => { sent.push(data); },
  };
}

describe('broadcastToAll filter', () => {
  beforeEach(() => {
    __resetChannelRegistryForTest();
    // Clear connected clients between tests
    const clients = getConnectedClients();
    clients.clear();
  });

  it('sends unfiltered channels to every connected client (legacy behaviour)', () => {
    const a = makeFakeClient();
    const b = makeFakeClient();
    getConnectedClients().add(a as any);
    getConnectedClients().add(b as any);

    broadcastToAll({ type: 'unfiltered:channel', payload: 'hi' });

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('skips clients without a matching subscription on filtered channels', () => {
    registerFilteredChannel('demo-plugin:change');
    const subscribed = makeFakeClient();
    subscribed.subscriptions = new Set(['demo-plugin:change']);
    const notSubscribed = makeFakeClient();
    notSubscribed.subscriptions = new Set();
    getConnectedClients().add(subscribed as any);
    getConnectedClients().add(notSubscribed as any);

    broadcastToAll({ type: 'demo-plugin:change', docId: 'x' });

    expect(subscribed.sent).toHaveLength(1);
    expect(notSubscribed.sent).toHaveLength(0);
  });

  it('treats a missing subscriptions set as not-subscribed for filtered channels', () => {
    registerFilteredChannel('demo-plugin:change');
    const noSet = makeFakeClient();
    // intentionally no subscriptions field
    getConnectedClients().add(noSet as any);

    broadcastToAll({ type: 'demo-plugin:change' });

    expect(noSet.sent).toHaveLength(0);
  });

  it('still delivers unfiltered channels to a client that has a subscriptions set', () => {
    registerFilteredChannel('demo-plugin:change');
    const c = makeFakeClient();
    c.subscriptions = new Set(); // subscribed to nothing
    getConnectedClients().add(c as any);

    broadcastToAll({ type: 'startup-progress', message: 'ready' });

    expect(c.sent).toHaveLength(1);
  });

  it('always JSON.stringifies the message before sending (no string fast-path)', () => {
    const c = makeFakeClient();
    getConnectedClients().add(c as any);

    broadcastToAll({ type: 'unfiltered:foo', x: 1 });

    // Sent exactly the JSON-encoded form; no raw string forwarding.
    expect(c.sent).toEqual(['{"type":"unfiltered:foo","x":1}']);
  });
});
