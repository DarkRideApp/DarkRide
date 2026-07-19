import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { SkeletonTable } from '@darkrideapp/plugin-sdk/react';
import { interceptHost } from '../components/intercept/interceptArm';
import { TrafficTable } from '../components/traffic/TrafficTable';
import { ReplayDrawer } from '../components/traffic/ReplayDrawer';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Trash2, Repeat, ShieldBan, ListTree } from 'lucide-react';
import { BlocklistPanel } from '../components/traffic/BlocklistPanel';
import { TrafficTree } from '../components/traffic/TrafficTree';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import type { CapturedTrafficEntry, WebSocketMessageEntry } from '../../shared/types/api';
import type { TrafficEntry } from '../components/traffic/TrafficEntryRow';
import type { TrafficFilters } from '../components/traffic/trafficUtils';
import { deriveServerStatusCentury } from '../components/traffic/trafficUtils';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { InterceptHoldPanel, InterceptArmControl } from '../components/intercept/InterceptHoldPanel';

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

interface TrafficProps {
  /** Restrict the view to one device (Network workspace scope). Default: all. */
  scopeDeviceId?: string | null;
  /** Restrict the view to one capture session. Default: all. */
  scopeSessionId?: number | null;
}

export function Traffic({ scopeDeviceId = null, scopeSessionId = null }: TrafficProps = {}) {
  useDocumentTitle('Traffic');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  // In-place Repeater: replay opens a drawer over the Traffic view (keeps
  // context) instead of navigating away to the Request Builder.
  const [replayEntry, setReplayEntry] = useState<TrafficEntry | null>(null);
  const handleReplay = useCallback((entry: TrafficEntry) => setReplayEntry(entry), []);
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
  // Count of live entries captured while the user is paged away or in a
  // non-live order — surfaced by the jump-to-live banner instead of dropped.
  const [pendingLiveCount, setPendingLiveCount] = useState(0);
  const [showBlocklist, setShowBlocklist] = useState(false);

  // Server-side filter state (derived from TrafficFilters in handleFilterChange below).
  // - serverType/serverMethod: derived from the tri-state method picks (unchanged).
  // - serverStatusCentury: a single century string ('200'/'300'/'400'/'500') derived
  //   via deriveServerStatusCentury() from the (now multi-select) status pills +
  //   exact status codes. The API only supports one century band per request, so
  //   when 0 or 2+ groups are active this stays '' and the deep filters (content
  //   type, size, exact status, multi-group status, search-fallback) are applied
  //   client-side on top of whatever page comes back — see clientSideFilter below.
  // - serverSearch: the "Search all" field, sent as the server `search` param
  //   (matches URL + body + headers per backend/api/traffic.ts).
  const [serverType, setServerType] = useState('');
  const [serverStatusCentury, setServerStatusCentury] = useState('');
  const [serverMethod, setServerMethod] = useState('');
  const [serverSearch, setServerSearch] = useState('');
  // Host/path narrowing driven by the tree navigator (precise, server-side,
  // across all pages via the /list hostname + path params).
  const [serverHostname, setServerHostname] = useState('');
  const [serverPath, setServerPath] = useState('');
  const [treeOpen, setTreeOpen] = useState(() => {
    try { return localStorage.getItem('darkride:traffic-tree-open') === '1'; } catch { return false; }
  });
  const toggleTree = useCallback(() => {
    setTreeOpen(prev => {
      const next = !prev;
      try { localStorage.setItem('darkride:traffic-tree-open', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Server-side sort state
  const [sortBy, setSortBy] = useState('capturedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const LIMIT = 50;

  const fetchTraffic = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(LIMIT));
      params.set('offset', String(page * LIMIT));
      if (serverType) params.set('type', serverType);
      if (serverMethod) params.set('method', serverMethod);
      if (serverStatusCentury) params.set('status', serverStatusCentury);
      if (serverSearch) params.set('search', serverSearch);
      if (serverHostname) params.set('hostname', serverHostname);
      if (serverPath) params.set('path', serverPath);
      if (scopeDeviceId) params.set('deviceId', scopeDeviceId);
      if (scopeSessionId != null) params.set('sessionId', String(scopeSessionId));
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
      // A fresh page-0 load already includes anything the banner was buffering.
      if (page === 0) setPendingLiveCount(0);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws, page, serverType, serverMethod, serverStatusCentury, serverSearch, serverHostname, serverPath, scopeDeviceId, scopeSessionId, sortBy, sortDir]);

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
      if (activeTab !== 'live') return;
      // Prepend live only when the current view IS the live head: page 0 in the
      // default newest-first order with no active search. In any other view
      // (paged away, custom sort, or searching) the entry doesn't belong at the
      // top, so buffer it and let the banner offer a one-click jump back.
      const defaultLiveOrder = sortBy === 'capturedAt' && sortDir === 'desc' && !serverSearch && !serverHostname && !serverPath;
      if (page === 0 && defaultLiveOrder) {
        setEntries(prev => {
          if (prev.some(p => p.id === entry.id)) return prev;
          return [entry, ...prev];
        });
        setTotal(prev => prev + 1);
      } else {
        setPendingLiveCount(c => c + 1);
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
  }, [ws, page, activeTab, sortBy, sortDir, serverSearch, serverHostname, serverPath]);

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
    setServerStatusCentury(deriveServerStatusCentury(filters));
    setServerSearch(filters.search);
    setPage(0);
    // NOTE: selection is intentionally NOT force-cleared here. TrafficTable
    // clears it itself (via its own effect) once the previously-selected row
    // no longer appears in the filtered set — otherwise every filter tweak
    // during triage would kick the user out of the row they're inspecting.
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

  const handleInterceptHost = useCallback((hostname: string) => {
    interceptHost(ws, hostname).catch(() => {});
  }, [ws]);

  const handleSave = useCallback((entry: TrafficEntry) => {
    ws.sendRestApi('POST', '/v1/traffic/saved', { id: entry.id }).catch(() => {});
  }, [ws]);

  const handleSelectHost = useCallback((hostname: string) => {
    setServerHostname(hostname === '(unknown)' ? '' : hostname);
    setServerPath('');
    setPage(0);
  }, []);

  const handleSelectPath = useCallback((hostname: string, path: string, latestId: number) => {
    setServerHostname(hostname === '(unknown)' ? '' : hostname);
    setServerPath(path);
    setPage(0);
    setSelectedId(latestId);
  }, []);

  const handleClear = useCallback(() => {
    setEntries([]);
    setTotal(0);
    setSelectedId(null);
  }, []);

  const handleBackToLive = useCallback(() => {
    setSortBy('capturedAt');
    setSortDir('desc');
    setPage(0);
    setPendingLiveCount(0);
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
      {/* Interactive intercept ("breakpoints") — modal appears only when a flow is held. */}
      <InterceptHoldPanel />
      {/* In-place Repeater — replaces the navigate-away replay flow on this view. */}
      <ReplayDrawer entry={replayEntry} onClose={() => setReplayEntry(null)} />
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
                  title="Each device can pose as Chrome 120 Android, OkHttp, or stock. Set the profile on that device's Capture tab."
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
                  TLS spoofing · per device
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
          <InterceptArmControl />
          <button
            className={`traffic-action-btn${treeOpen ? ' traffic-action-primary' : ''}`}
            data-testid="traffic-tree-toggle"
            onClick={toggleTree}
            title="Toggle the host / path tree navigator"
          >
            <ListTree size={14} />
            Tree
          </button>
          <div style={{ position: 'relative' }}>
            <button
              className="traffic-action-btn"
              data-testid="traffic-blocked-btn"
              onClick={() => setShowBlocklist(v => !v)}
            >
              <ShieldBan size={14} />
              Blocked
            </button>
            {showBlocklist && (
              <BlocklistPanel ws={ws} onClose={() => setShowBlocklist(false)} />
            )}
          </div>
          <button
            className="traffic-action-btn"
            onClick={handleClear}
            title="Clears the current view only. Captured traffic stays in the database."
          >
            <Trash2 size={14} />
            Clear view
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
        <>
        {pendingLiveCount > 0 && (
          <div className="traffic-live-banner" data-testid="traffic-live-banner">
            <span>
              {pendingLiveCount} new request{pendingLiveCount === 1 ? '' : 's'} captured while you were browsing.
            </span>
            <button
              className="btn btn-sm btn-primary"
              data-testid="traffic-back-to-live"
              onClick={handleBackToLive}
            >
              Back to live
            </button>
          </div>
        )}
        <div className="traffic-workspace">
        {treeOpen && (
          <div className="traffic-tree-panel" data-testid="traffic-tree-panel">
            <TrafficTree
              ws={ws}
              sessionId={scopeSessionId}
              activeHost={serverHostname || null}
              onSelectHost={handleSelectHost}
              onSelectPath={handleSelectPath}
            />
          </div>
        )}
        <TrafficTable
          entries={entries as TrafficEntry[]}
          loading={loading}
          emptyMessage="No traffic captured"
          onFilterChange={handleFilterChange}
          onLoadFullBody={handleLoadFullBody}
          onLoadWsFrames={handleLoadWsFrames}
          onBlockHostname={handleBlockHostname}
          onInterceptHost={handleInterceptHost}
          onReplay={handleReplay}
          onSave={handleSave}
          wsFrames={wsFrames}
          selectedId={selectedId}
          onSelectEntry={setSelectedId}
          // Client-side filtering runs on top of whatever the server already
          // narrowed down (type/method/status-century/search). This is what
          // makes the Host/URL text filter, content-type pills, size quick
          // filters, exact-status chips, and multi-group status selection
          // actually take effect on this page — previously this was false,
          // which silently made the "Filter by host or regex" box a no-op.
          // Known trade-off: filters that can't be pushed server-side only
          // narrow the currently-fetched page, not the full result set
          // across pages (the API has no OR-across-century or content-type
          // params). Acceptable for a 50-row page; documented for reviewers.
          clientSideFilter={true}
          footer={pagination}
          onSortChange={handleSortChange}
          sortBy={sortBy}
          sortDir={sortDir}
        />
        </div>
        </>
      )}
    </div>
  );
}
