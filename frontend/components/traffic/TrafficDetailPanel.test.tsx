import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { pluginRegistry, __resetPluginRegistry } from '@darkrideapp/plugin-sdk/react';
import { blipDecoder } from '../../../plugins/blip-decoder/frontend/blip';
import { TrafficDetailPanel } from './TrafficDetailPanel';
import type { TrafficEntry } from './TrafficEntryRow';
import type { WebSocketMessageEntry } from '../../../shared/types/api';

// Regression fixture for the bug where WsFramesPanel never invoked the
// registered protocol decoder and showed raw base64 for every WS frame
// regardless of a matching decoder being registered. Frames below are
// synthetic BLIP wire frames (uncompressed MSG/ERR), not real captured
// traffic — only the wire format matters for this test, not the payload.

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return bytes;
}

function buildBlipFrame(messageNumber: number, flags: number, properties: Record<string, string>, body = ''): string {
  const encoder = new TextEncoder();
  const propParts: number[] = [];
  for (const [key, val] of Object.entries(properties)) {
    propParts.push(...encoder.encode(key), 0, ...encoder.encode(val), 0);
  }
  const propsLenVarint = encodeVarint(propParts.length);
  const bodyBytes = encoder.encode(body);
  const bytes = new Uint8Array([
    ...encodeVarint(messageNumber),
    ...encodeVarint(flags),
    ...propsLenVarint,
    ...propParts,
    ...bodyBytes,
    0, 0, 0, 0, // CRC32 placeholder
  ]);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// testing-library's queryByText takes a RegExp, but base64 payloads can
// contain regex metacharacters (+, /). Match on a plain substring instead.
function rawPayloadMatcher(payload: string): (content: string) => boolean {
  const needle = payload.slice(0, 20);
  return (content: string) => content.includes(needle);
}

const BLIP_REQUEST_HEADERS = JSON.stringify({
  Host: 'sync.example.test:443',
  'User-Agent': 'CouchbaseLite/3.2.4 (test-harness)',
  'Sec-WebSocket-Protocol': 'BLIP_3+CBMobile_3,BLIP_3+CBMobile_2',
  Upgrade: 'websocket',
  Connection: 'Upgrade',
});

const wsEntry: TrafficEntry = {
  id: 12203,
  sessionId: 350,
  deviceId: 'device-1',
  requestMethod: 'GET',
  requestUrl: 'wss://sync.example.test/testdb/_blipsync',
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
    payload: buildBlipFrame(1, 0x00, { Profile: 'getCheckpoint' }, '{"client":"test-client"}'),
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
    payload: buildBlipFrame(1, 0x02, { 'Error-Domain': 'HTTP', 'Error-Code': '404' }, 'missing'),
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
    expect(screen.queryByText(rawPayloadMatcher(wsFrames[0].payload!))).not.toBeInTheDocument();
    expect(screen.queryByText(rawPayloadMatcher(wsFrames[1].payload!))).not.toBeInTheDocument();
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
    expect(await screen.findByText(rawPayloadMatcher(wsFrames[0].payload!))).toBeInTheDocument();
  });
});
