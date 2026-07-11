import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { SkeletonTable } from '@darkrideapp/plugin-sdk/react';
import { useTrafficReplay } from '../components/traffic/TrafficEntryRow';
import { TrafficTable } from '../components/traffic/TrafficTable';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Trash2, Repeat } from 'lucide-react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import type { CapturedTrafficEntry, WebSocketMessageEntry } from '../../shared/types/api';
import type { TrafficEntry } from '../components/traffic/TrafficEntryRow';
import type { TrafficFilters } from '../components/traffic/trafficUtils';
import { METHOD_FILTERS } from '../components/traffic/trafficUtils';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';

// ---------------------------------------------------------------------------
// Saved Traffic tab
// ---------------------------------------------------------------------------

interface SavedTrafficItem {
  id: number;
  url: string;
  method: string;
  requestHeaders: string | null;
  requestBody: string | null;
  responseStatus: number | null;
  responseHeaders: string | null;
  responseBody: string | null;
  deviceId: string | null;
  savedAt: string;
}

function SavedTrafficTab() {
  const ws = useWebSocket();
  const [items, setItems] = useState<SavedTrafficItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);

  const fetchSaved = useCallback(async () => {
    try {
      const params = search ? `?url=${encodeURIComponent(search)}` : '';
      const res = await ws.sendRestApi('GET', `/v1/traffic/saved${params}`);
      setItems(res.body?.data || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [ws, search]);

  useEffect(() => {
    if (ws.connected) fetchSaved();
  }, [ws.connected, fetchSaved]);

  const handleDelete = async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/traffic/saved/${id}`);
      setItems(prev => prev.filter(i => i.id !== id));
    } catch {}
  };

  const handleDeleteAll = async () => {
    try {
      await ws.sendRestApi('DELETE', '/v1/traffic/saved');
      setItems([]);
    } catch {}
  };

  // Convert saved items to TrafficEntry shape for TrafficTable
  const asTrafficEntries: TrafficEntry[] = items.map(item => ({
    id: item.id,
    sessionId: null,
    deviceId: item.deviceId,
    requestMethod: item.method,
    requestUrl: item.url,
    requestHeaders: item.requestHeaders,
    requestBody: item.requestBody,
    responseStatus: item.responseStatus,
    responseHeaders: item.responseHeaders,
    responseBody: item.responseBody,
    capturedAt: item.savedAt,
    matchedRules: null,
  }));

  if (loading) return <SkeletonTable rows={8} columns={4} />;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input
          className="form-input"
          placeholder="Search by URL (regex supported)..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 400 }}
        />
        {items.length > 0 && (
          <button
            className="btn btn-sm btn-danger"
            onClick={() => setShowClearAllConfirm(true)}
          >
            Clear All
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">&#128190;</div>
          <div>No saved traffic</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            Use <code>req.save()</code> or <code>resp.save()</code> in automation hooks to save traffic here
          </div>
        </div>
      ) : (
        <TrafficTable
          entries={asTrafficEntries}
          emptyMessage="No saved traffic"
          footer={
            <>
              {deleteConfirmId !== null && (
                <ConfirmDialog
                  title="Delete Saved Traffic"
                  message="Are you sure you want to delete this saved traffic entry? This action cannot be undone."
                  onConfirm={() => { handleDelete(deleteConfirmId); setDeleteConfirmId(null); }}
                  onCancel={() => setDeleteConfirmId(null)}
                />
              )}
              {showClearAllConfirm && (
                <ConfirmDialog
                  title="Clear All Saved Traffic"
                  message={`Are you sure you want to delete all ${items.length} saved traffic entries? This action cannot be undone.`}
                  confirmLabel="Clear All"
                  onConfirm={() => { handleDeleteAll(); setShowClearAllConfirm(false); }}
                  onCancel={() => setShowClearAllConfirm(false)}
                />
              )}
            </>
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live Traffic page
// ---------------------------------------------------------------------------

type TrafficTab = 'live' | 'saved';
const TRAFFIC_TABS: TrafficTab[] = ['live', 'saved'];

export function Traffic() {
  useDocumentTitle('Traffic');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const handleReplay = useTrafficReplay();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab') as TrafficTab | null;
  const activeTab: TrafficTab = tabParam && TRAFFIC_TABS.includes(tabParam) ? tabParam : 'live';
  const setActiveTab = useCallback((tab: TrafficTab) => {
    setSearchParams(tab === 'live' ? {} : { tab }, { replace: false });
  }, [setSearchParams]);

  const [entries, setEntries] = useState<CapturedTrafficEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [wsFrames, setWsFrames] = useState<Map<number, WebSocketMessageEntry[]>>(new Map());

  // Server-side filter state (derived from TrafficFilters; text is handled client-side in TrafficTable)
  const [serverType, setServerType] = useState('');
  const [serverStatus, setServerStatus] = useState('');
  const [serverMethod, setServerMethod] = useState('');

  // Server-side sort state
  const [sortBy, setSortBy] = useState('capturedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const LIMIT = 50;

  const statusFilter = serverStatus === '2xx' ? '200'
    : serverStatus === '3xx' ? '300'
    : serverStatus === '4xx' ? '400'
    : serverStatus === '5xx' ? '500'
    : '';

  const fetchTraffic = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(LIMIT));
      params.set('offset', String(page * LIMIT));
      if (serverType) params.set('type', serverType);
      if (serverMethod) params.set('method', serverMethod);
      if (statusFilter) params.set('status', statusFilter);
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);

      const res = await ws.sendRestApi('GET', `/v1/traffic/list?${params}`);
      const data = res.body?.data;
      if (data?.items) {
        setEntries(data.items as CapturedTrafficEntry[]);
        setTotal(data.total || data.items.length);
      } else {
        setEntries(data || []);
        setTotal(Array.isArray(data) ? data.length : 0);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws, page, serverType, serverMethod, statusFilter, sortBy, sortDir]);

  useEffect(() => {
    if (ws.connected && activeTab === 'live') fetchTraffic();
  }, [ws.connected, fetchTraffic, activeTab]);

  // Subscribe to live traffic entries + WS frame updates
  useEffect(() => {
    const unsubEntry = ws.subscribe('traffic-entry', (msg: any) => {
      const e = msg.entry;
      if (!e) return;
      const entry: CapturedTrafficEntry = {
        id: e.id,
        sessionId: e.sessionId,
        deviceId: e.deviceId,
        requestMethod: e.requestMethod,
        requestUrl: e.requestUrl,
        requestHeaders: e.requestHeaders,
        requestBody: e.requestBody,
        responseStatus: e.responseStatus,
        responseHeaders: e.responseHeaders ?? null,
        responseBody: e.responseBody,
        type: e.trafficType || e.type,
        wsMessageCount: e.wsMessageCount ?? null,
        capturedAt: e.capturedAt,
        matchedRules: e.matchedRules ?? null,
        responseContentType: e.responseContentType ?? null,
        hasImage: e.hasImage ?? false,
        durationMs: e.durationMs ?? null,
        timings: e.timings ?? null,
      };
      if (page === 0 && activeTab === 'live') {
        setEntries(prev => {
          if (prev.some(p => p.id === entry.id)) return prev;
          return [entry, ...prev];
        });
        setTotal(prev => prev + 1);
      }
    });

    const unsubFrame = ws.subscribe('ws-frame', (msg: any) => {
      const { trafficId, frame } = msg;
      setWsFrames(prev => {
        const next = new Map(prev);
        const existing = next.get(trafficId) || [];
        next.set(trafficId, [...existing, frame]);
        return next;
      });
      setEntries(prev => prev.map(e =>
        e.id === trafficId ? { ...e, wsMessageCount: (e.wsMessageCount ?? 0) + 1 } : e
      ));
    });

    const unsubClosed = ws.subscribe('ws-connection-closed', (msg: any) => {
      const { trafficId, closeCode, closeReason, messageCount } = msg;
      setEntries(prev => prev.map(e =>
        e.id === trafficId ? { ...e, wsCloseCode: closeCode, wsCloseReason: closeReason, wsMessageCount: messageCount } : e
      ));
    });

    return () => { unsubEntry(); unsubFrame(); unsubClosed(); };
  }, [ws, page, activeTab]);

  const handleFilterChange = useCallback((filters: TrafficFilters) => {
    // Derive server-side filters from the tri-state method picks. When exactly
    // one method is actively included we can push BOTH type (http|websocket)
    // AND the concrete HTTP method down to the server — gets the correct rows
    // back immediately instead of relying on client-side pruning, which was
    // the "filter on POST does nothing / sometimes works after a delay"
    // report.
    const includes = Array.from(filters.methodFilters.entries())
      .filter(([, v]) => v === 'include')
      .map(([k]) => k);
    let type = '';
    let method = '';
    if (includes.length === 1) {
      const key = includes[0];
      if (key === 'WS') {
        type = 'websocket';
      } else if (['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(key)) {
        type = 'http';
        method = key;
      } else if (key === 'CONNECT' || key === 'DNS') {
        // These have dedicated requestMethod values server-side.
        method = key;
      }
      // GQL / PROTO / TLS_FAIL: can't be reduced to a single server-side
      // predicate without body/header inspection — fall back to client-side
      // filtering by leaving both type/method empty.
    }
    setServerType(type);
    setServerMethod(method);
    setServerStatus(filters.status);
    setPage(0);
    setSelectedId(null);
  }, []);

  const handleSortChange = useCallback((newSortBy: string, newSortDir: 'asc' | 'desc') => {
    setSortBy(newSortBy);
    setSortDir(newSortDir);
    setPage(0);
    setSelectedId(null);
  }, []);

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

  const handleBlockHostname = useCallback((hostname: string) => {
    ws.sendRestApi('POST', '/v1/blocklist/add', { domain: hostname }).catch(() => {});
  }, [ws]);

  const handleClear = useCallback(() => {
    setEntries([]);
    setTotal(0);
    setSelectedId(null);
  }, []);

  const selectedEntry = selectedId != null ? entries.find(e => e.id === selectedId) : null;

  const pagination = !loading && entries.length > 0 ? (
    <div className="pagination" style={{ padding: '8px 24px' }}>
      <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
        Prev
      </button>
      <span className="page-info">
        Page {page + 1} of {Math.max(1, Math.ceil(total / LIMIT))}
      </span>
      <button className="btn btn-sm" disabled={(page + 1) * LIMIT >= total} onClick={() => setPage(p => p + 1)}>
        Next
      </button>
    </div>
  ) : null;

  if (auth && !auth.hasScope('core.traffic:read')) return <AccessDenied scope="core.traffic:read" />;

  return (
    <div data-testid="traffic-page" className="traffic-page page-full-bleed">
      {/* Action sub-header */}
      <div className="traffic-subheader">
        <div className="traffic-subheader-left">
          <h2 className="traffic-subheader-title">Traffic Analysis</h2>
          <span className="traffic-subheader-divider" />
          <div className="traffic-subheader-status">
            {ws.connected && activeTab === 'live' && (
              <>
                <span className="traffic-live-dot" />
                <span>Live Intercepting</span>
                {/* TLS-fingerprint capability pill (fresh review §1d). Static
                    informational badge — flags a differentiator that's
                    otherwise invisible without digging into a device's
                    Capture tab. Tooltip explains where to actually pick a
                    profile. */}
                <span
                  data-testid="traffic-tls-pill"
                  title="Each device can pose as Chrome 120 Android, OkHttp, or stock — set the profile on its Capture tab."
                  style={{
                    marginLeft: 12,
                    fontSize: 11,
                    fontWeight: 500,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'color-mix(in srgb, var(--accent, #4a9eff) 14%, transparent)',
                    color: 'var(--accent, #4a9eff)',
                    border: '1px solid color-mix(in srgb, var(--accent, #4a9eff) 30%, transparent)',
                    cursor: 'help',
                    whiteSpace: 'nowrap',
                  }}
                >
                  TLS fingerprint spoofing
                </span>
              </>
            )}
            {!ws.connected && <span style={{ color: 'var(--text-muted)' }}>Disconnected</span>}
          </div>
          {/* Live/Saved toggle */}
          <div style={{ display: 'flex', gap: 0, marginLeft: 16 }}>
            {(['live', 'saved'] as const).map(tab => (
              <button
                key={tab}
                className={`btn btn-sm${activeTab === tab ? ' btn-primary' : ''}`}
                onClick={() => setActiveTab(tab)}
                style={{ borderRadius: tab === 'live' ? '4px 0 0 4px' : '0 4px 4px 0' }}
              >
                {tab === 'live' ? 'Live' : 'Saved'}
              </button>
            ))}
          </div>
        </div>
        <div className="traffic-subheader-actions">
          <button className="traffic-action-btn" onClick={handleClear}>
            <Trash2 size={14} />
            Clear
          </button>
          {selectedEntry && (
            <button
              className="traffic-action-btn traffic-action-primary"
              onClick={() => selectedEntry && handleReplay(selectedEntry as TrafficEntry)}
            >
              <Repeat size={14} />
              Repeat Request
            </button>
          )}
        </div>
      </div>

      {activeTab === 'saved' ? (
        <div style={{ padding: 24 }}>
          <SavedTrafficTab />
        </div>
      ) : (
        <TrafficTable
          entries={entries as TrafficEntry[]}
          loading={loading}
          emptyMessage="No traffic captured"
          onFilterChange={handleFilterChange}
          onLoadFullBody={handleLoadFullBody}
          onLoadWsFrames={handleLoadWsFrames}
          onBlockHostname={handleBlockHostname}
          onReplay={handleReplay}
          wsFrames={wsFrames}
          selectedId={selectedId}
          onSelectEntry={setSelectedId}
          clientSideFilter={false}
          footer={pagination}
          onSortChange={handleSortChange}
          sortBy={sortBy}
          sortDir={sortDir}
        />
      )}
    </div>
  );
}
