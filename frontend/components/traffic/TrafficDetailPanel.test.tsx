import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { pluginRegistry, __resetPluginRegistry } from '@darkrideapp/plugin-sdk/react';
import { blipDecoder } from '../../../plugins/blip-decoder/frontend/blip';
import { TrafficDetailPanel } from './TrafficDetailPanel';
import type { TrafficEntry } from './TrafficEntryRow';
import type { WebSocketMessageEntry } from '../../../shared/types/api';

// Real handshake headers + frames captured from a CouchbaseLite BLIP sync
// connection (wss://.../_blipsync) — regression fixture for the bug where
// WsFramesPanel never invoked the registered protocol decoder and showed
// raw base64 for every frame regardless of a matching decoder.
const BLIP_REQUEST_HEADERS = JSON.stringify({
  Host: 'realtime-sync-gw.wdprapps.disney.com:443',
  'User-Agent': 'CouchbaseLite/3.2.4-2 (Java; Android 14; ONEPLUS A5000) EE/release',
  'Sec-WebSocket-Protocol': 'BLIP_3+CBMobile_3,BLIP_3+CBMobile_2',
  Upgrade: 'websocket',
  Connection: 'Upgrade',
});

const wsEntry: TrafficEntry = {
  id: 12203,
  sessionId: 350,
  deviceId: 'device-1',
  requestMethod: 'GET',
  requestUrl: 'wss://realtime-sync-gw.wdprapps.disney.com/park-platform-pub/_blipsync',
  requestHeaders: BLIP_REQUEST_HEADERS,
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
    // BLIP REQ, Profile=getCheckpoint
    payload: 'AQA9UHJvZmlsZQBnZXRDaGVja3BvaW50AGNsaWVudABjcC0wWGNTeG1Md3pI',
    isBinary: true,
    payloadSize: 92,
    timestamp: '2026-07-12T09:00:01Z',
  },
  {
    id: 21222,
    trafficId: 12203,
    sessionId: 350,
    deviceId: 'device-1',
    direction: 'receive',
    opcode: 'binary',
    // BLIP ERR, Error-Domain=HTTP, Error-Code=404, body="missing"
    payload: 'AQIhRXJyb3ItRG9tYWluAEhUVFAARXJyb3ItQ29kZQA0MDQAbWlzc2luZ5IQ3rw=',
    isBinary: true,
    payloadSize: 47,
    timestamp: '2026-07-12T09:00:02Z',
  },
];

describe('TrafficDetailPanel — WebSocket protocol decoding', () => {
  afterEach(() => {
    __resetPluginRegistry();
  });

  it('decodes BLIP frames via a registered plugin decoder instead of showing raw base64', async () => {
    pluginRegistry.registerDecoders('blip-decoder', [blipDecoder]);

    render(
      <TrafficDetailPanel
        entry={wsEntry}
        wsFrames={wsFrames}
        onClose={() => {}}
      />,
    );

    // Switch to the Frames tab
    fireEvent.click(screen.getByRole('button', { name: /Frames/ }));

    // The decoder should be detected (Sec-WebSocket-Protocol includes BLIP)
    // and its name shown, proving decodeFrames() ran rather than the raw
    // fallback view.
    expect(await screen.findByText(/BLIP \(Couchbase Sync\)/)).toBeInTheDocument();

    // Decoded message content should be visible...
    expect(await screen.findByText('getCheckpoint')).toBeInTheDocument();
    expect(screen.getByText(/404/)).toBeInTheDocument();

    // ...and the raw base64 payloads should NOT be dumped to the screen.
    expect(screen.queryByText(/AQA9UHJvZmlsZQ/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AQIhRXJyb3ItRG9tYWlu/)).not.toBeInTheDocument();
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

    expect(screen.queryByText(/BLIP \(Couchbase Sync\)/)).not.toBeInTheDocument();
    expect(await screen.findByText(/AQA9UHJvZmlsZQ/)).toBeInTheDocument();
  });
});
