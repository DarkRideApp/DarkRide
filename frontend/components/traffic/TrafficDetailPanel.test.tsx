import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { pluginRegistry, __resetPluginRegistry } from '@darkrideapp/plugin-sdk/react';
import type { ProtocolDecoder, DecodedMessage } from '@darkrideapp/plugin-sdk/react';
import { TrafficDetailPanel } from './TrafficDetailPanel';
import type { TrafficEntry } from './TrafficEntryRow';
import type { WebSocketMessageEntry } from '../../../shared/types/api';

// Regression test for the bug where WsFramesPanel (the component the app
// actually renders for the Traffic tab's WebSocket frames view) never called
// detectProtocol()/pluginRegistry at all, so registered ProtocolDecoder
// plugins had zero effect and every frame showed as raw base64 regardless
// of a matching decoder being registered.
//
// This deliberately uses a small self-contained fake decoder rather than a
// real plugin (e.g. blip-decoder) — plugins live in their own separate repos
// and aren't guaranteed to be checked out here, and decode-logic correctness
// for a specific protocol belongs in that plugin's own test suite. This test
// only needs to prove the host wires *some* registered decoder in correctly.

const fakeDecoder: ProtocolDecoder = {
  id: 'fake-protocol',
  name: 'Fake Protocol (test)',
  detect: (headers) => {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'sec-websocket-protocol') {
        return value.toLowerCase().includes('fake-protocol');
      }
    }
    return false;
  },
  decodeFrames: (frames) => frames.map((f, i): DecodedMessage => ({
    messageNumber: i,
    type: 'request',
    typeLabel: 'REQ',
    direction: f.direction,
    properties: { profile: 'test-op' },
    body: `parsed frame #${i}`,
    bodySize: f.payloadSize,
    timestamp: f.timestamp,
    flags: [],
    rawFrameIds: [f.id],
  })),
};

const wsEntry: TrafficEntry = {
  id: 12203,
  sessionId: 350,
  deviceId: 'device-1',
  requestMethod: 'GET',
  requestUrl: 'wss://sync.example.test/testdb/_stream',
  requestHeaders: JSON.stringify({
    Host: 'sync.example.test:443',
    'Sec-WebSocket-Protocol': 'fake-protocol-v1',
    Upgrade: 'websocket',
    Connection: 'Upgrade',
  }),
  requestBody: null,
  responseStatus: 101,
  responseHeaders: null,
  responseBody: null,
  type: 'websocket',
  wsMessageCount: 2,
  capturedAt: '2026-07-12T09:00:00Z',
};

const wsFrames: WebSocketMessageEntry[] = [
  {
    id: 21220,
    trafficId: 12203,
    sessionId: 350,
    deviceId: 'device-1',
    direction: 'send',
    opcode: 'binary',
    payload: 'RAWBASE64PAYLOADFRAMEONE',
    isBinary: true,
    payloadSize: 24,
    timestamp: '2026-07-12T09:00:01Z',
  },
  {
    id: 21222,
    trafficId: 12203,
    sessionId: 350,
    deviceId: 'device-1',
    direction: 'receive',
    opcode: 'binary',
    payload: 'RAWBASE64PAYLOADFRAMETWO',
    isBinary: true,
    payloadSize: 24,
    timestamp: '2026-07-12T09:00:02Z',
  },
];

describe('TrafficDetailPanel — WebSocket protocol decoding', () => {
  afterEach(() => {
    __resetPluginRegistry();
  });

  it('decodes frames via a registered plugin decoder instead of showing raw base64', async () => {
    pluginRegistry.registerDecoders('fake-decoder-plugin', [fakeDecoder]);

    render(
      <TrafficDetailPanel
        entry={wsEntry}
        wsFrames={wsFrames}
        onClose={() => {}}
      />,
    );

    // Switch to the Frames tab
    fireEvent.click(screen.getByRole('button', { name: /Frames/ }));

    // The decoder should be detected (Sec-WebSocket-Protocol includes
    // "fake-protocol") and its name shown, proving decodeFrames() ran
    // rather than the raw fallback view.
    expect(await screen.findByText('Fake Protocol (test)')).toBeInTheDocument();

    // Decoded message content should be visible...
    expect(await screen.findByText('parsed frame #0')).toBeInTheDocument();
    expect(screen.getByText('parsed frame #1')).toBeInTheDocument();

    // ...and the raw payloads should NOT be dumped to the screen.
    expect(screen.queryByText(/RAWBASE64PAYLOAD/)).not.toBeInTheDocument();
  });

  it('falls back to raw frames when no decoder matches the connection', async () => {
    // No decoder registered at all — Sec-WebSocket-Protocol has no match.
    render(
      <TrafficDetailPanel
        entry={wsEntry}
        wsFrames={wsFrames}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Frames/ }));

    expect(screen.queryByText('Fake Protocol (test)')).not.toBeInTheDocument();
    expect(await screen.findByText(/RAWBASE64PAYLOADFRAMEONE/)).toBeInTheDocument();
  });
});

describe('TrafficDetailPanel — Save action', () => {
  const httpEntry: TrafficEntry = {
    id: 7, sessionId: null, deviceId: null, requestMethod: 'GET',
    requestUrl: 'https://api.test/x', requestHeaders: null, requestBody: null,
    responseStatus: 200, responseHeaders: null, responseBody: '{"ok":true}',
    type: 'http', capturedAt: '2026-07-16T00:00:00Z',
  };

  it('calls onSave with the entry when Save is clicked', () => {
    const onSave = vi.fn();
    render(<TrafficDetailPanel entry={httpEntry} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
  });
});
