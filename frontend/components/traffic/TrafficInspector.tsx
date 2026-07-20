import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { interceptHost } from '../intercept/interceptArm';
import { TrafficTable } from './TrafficTable';
import { ReplayDrawer } from './ReplayDrawer';
import type { TrafficEntry } from './TrafficEntryRow';
import type { WebSocketMessageEntry } from '../../../shared/types/api';
import type { TrafficEntryMessage, TrafficRequestStartedMessage, WebSocketFrameMessage, WebSocketConnectionClosedMessage } from '../../../shared/types/websocket';

// Retain up to 5000 rows in memory. DOM cost is now viewport-bounded by
// TrafficTable's virtualizer, so the cap can be high; this trim is the
// JS-heap / WS-frame-map backstop, not a render-cost limit.
const MAX_ENTRIES = 5000;
let pendingIdCounter = 0;

interface TrafficInspectorProps {
  deviceId: string;
  sessionId: number | null;
  mode?: 'live' | 'static';
}

/**
 * TrafficInspector — data-layer wrapper that manages WebSocket subscriptions
 * (live mode) or REST fetching (static mode) and renders TrafficTable.
 */
export function TrafficInspector({ deviceId, sessionId, mode = 'live' }: TrafficInspectorProps) {
  const ws = useWebSocket();
  // In-place Repeater — replay opens a drawer over the inspector rather than
  // navigating away to the Request Builder.
  const [replayEntry, setReplayEntry] = useState<TrafficEntry | null>(null);
  const handleReplay = useCallback((entry: TrafficEntry) => setReplayEntry(entry), []);
  const [entries, setEntries] = useState<TrafficEntry[]>([]);
  const [wsFrames, setWsFrames] = useState<Map<number, WebSocketMessageEntry[]>>(new Map());
  const [staticLoading, setStaticLoading] = useState(mode === 'static');

  // Static mode: fetch historical traffic data
  useEffect(() => {
    if (mode !== 'static' || !sessionId || !ws.connected) return;
    setStaticLoading(true);
    ws.sendRestApi('GET', `/v1/traffic/list?sessionId=${sessionId}&limit=2000`).then(res => {
      const items = res.body?.data?.items || res.body?.data || [];
      // API returns descending order, reverse to chronological
      setEntries([...items].reverse());
    }).catch(() => {}).finally(() => setStaticLoading(false));
  }, [mode, sessionId, ws.connected]);

  // Subscribe to traffic-request-started WebSocket messages (live mode only)
  useEffect(() => {
    if (mode !== 'live') return;
    return ws.subscribe('traffic-request-started', (msg: TrafficRequestStartedMessage) => {
      if (msg.deviceId !== deviceId) return;
      const pendingEntry: TrafficEntry = {
        id: -(Date.now() * 1000 + (pendingIdCounter++ % 1000)),
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
        requestMethod: msg.requestMethod,
        requestUrl: msg.requestUrl,
        requestHeaders: msg.requestHeaders,
        requestBody: null,
        responseStatus: null,
        responseHeaders: null,
        responseBody: null,
        capturedAt: msg.timestamp,
        flowId: msg.flowId,
        pending: true,
      };
      setEntries(prev => {
        const next = [...prev, pendingEntry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    });
  }, [ws, deviceId, mode]);

  // Subscribe to traffic-entry WebSocket messages (live mode only)
  useEffect(() => {
    if (mode !== 'live') return;
    return ws.subscribe('traffic-entry', (msg: TrafficEntryMessage) => {
      if (msg.entry.deviceId !== deviceId) return;
      // Map broadcast field trafficType → type for TrafficEntry compatibility
      const entry: TrafficEntry = {
        ...msg.entry,
        type: (msg.entry as any).trafficType || (msg.entry as any).type,
        wsMessageCount: msg.entry.wsMessageCount ?? null,
        capturedAt: msg.entry.capturedAt,
      };
      setEntries(prev => {
        // If entry has a flowId, find and replace the matching pending entry
        if (entry.flowId) {
          const pendingIdx = prev.findIndex(e => e.pending && e.flowId === entry.flowId);
          if (pendingIdx !== -1) {
            const next = [...prev];
            next[pendingIdx] = entry;
            return next;
          }
        }
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    });
  }, [ws, deviceId, mode]);

  // Subscribe to ws-frame and ws-connection-closed (live mode only)
  useEffect(() => {
    if (mode !== 'live') return;

    const unsubFrame = ws.subscribe('ws-frame', (msg: WebSocketFrameMessage) => {
      setWsFrames(prev => {
        const next = new Map(prev);
        const existing = next.get(msg.trafficId) || [];
        next.set(msg.trafficId, [...existing, msg.frame as WebSocketMessageEntry]);
        return next;
      });
      setEntries(prev => prev.map(e =>
        e.id === msg.trafficId ? { ...e, wsMessageCount: (e.wsMessageCount ?? 0) + 1 } : e
      ));
    });

    const unsubClosed = ws.subscribe('ws-connection-closed', (msg: WebSocketConnectionClosedMessage) => {
      setEntries(prev => prev.map(e =>
        e.id === msg.trafficId ? { ...e, wsCloseCode: msg.closeCode, wsCloseReason: msg.closeReason, wsMessageCount: msg.messageCount } : e
      ));
    });

    return () => { unsubFrame(); unsubClosed(); };
  }, [ws, mode]);

  const handleLoadFullBody = useCallback((id: number) => {
    ws.sendRestApi('GET', `/v1/traffic/view/${id}`).then(res => {
      const data = res.body?.data;
      if (!data) return;
      setEntries(prev => prev.map(e =>
        e.id === id ? { ...e, responseBody: data.responseBody ?? e.responseBody } : e
      ));
    }).catch(() => {});
  }, [ws]);

  const handleLoadWsFrames = useCallback((id: number) => {
    if (wsFrames.has(id)) return;
    ws.sendRestApi('GET', `/v1/traffic/ws-messages/${id}?limit=500`).then(res => {
      const items = res.body?.data?.items || [];
      setWsFrames(prev => new Map(prev).set(id, items));
    }).catch(() => {});
  }, [ws, wsFrames]);

  const handleClear = useCallback(() => {
    setEntries([]);
  }, []);

  const handleBlockHostname = useCallback((hostname: string) => {
    ws.sendRestApi('POST', '/v1/blocklist/add', { domain: hostname }).catch(() => {});
  }, [ws]);

  const handleInterceptHost = useCallback((hostname: string) => {
    interceptHost(ws, hostname).catch(() => {});
  }, [ws]);

  const handleSave = useCallback((entry: TrafficEntry) => {
    ws.sendRestApi('POST', '/v1/traffic/saved', { id: entry.id }).catch(() => {});
  }, [ws]);

  const emptyMsg = mode === 'static' && staticLoading
    ? 'Loading traffic…'
    : mode === 'static' && entries.length === 0
      ? 'No traffic captured in this session'
      : entries.length === 0
        ? 'Waiting for traffic…'
        : 'No entries match filters';

  return (
    <>
    <ReplayDrawer entry={replayEntry} onClose={() => setReplayEntry(null)} />
    <TrafficTable
      entries={entries}
      loading={mode === 'static' && staticLoading}
      emptyMessage={emptyMsg}
      onReplay={handleReplay}
      onSave={handleSave}
      wsFrames={wsFrames}
      onLoadWsFrames={handleLoadWsFrames}
      onLoadFullBody={handleLoadFullBody}
      onBlockHostname={mode === 'live' ? handleBlockHostname : undefined}
      onInterceptHost={handleInterceptHost}
      liveMode={mode === 'live'}
      onClear={mode === 'live' ? handleClear : undefined}
      footer={
        <div
          style={{
            padding: '4px 10px',
            borderTop: '1px solid var(--border-color, #333)',
            background: 'var(--bg-secondary, #1e1e2e)',
            fontSize: 11,
            color: 'var(--text-muted, #888)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>{entries.length} entries</span>
          {sessionId && <span>Session #{sessionId}</span>}
        </div>
      }
    />
    </>
  );
}
