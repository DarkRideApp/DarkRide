import React, { useEffect, useState, useCallback, useRef } from 'react';
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
import { applyClientFilters, createDefaultFilters, deserializeTrafficFilters, isDefaultTrafficFilters, serializeTrafficFilters, trafficFiltersToListParams } from '../components/traffic/trafficUtils';
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
  // Filters restored from the ?filters= deep link. Read once: after mount the
  // table owns filter state and writes changes back to the URL.
  const [initialFilters] = useState(() => deserializeTrafficFilters(searchParams.get('filters')));
  const setActiveTab = useCallback((tab: TrafficTab) => {
    // Only touch ?tab= so the Network workspace's ?pane= / ?scope= survive.
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      if (tab === 'live') p.delete('tab'); else p.set('tab', tab);
      return p;
    }, { replace: false });
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

  // The table's filter state, mirrored here to drive the server query. Every
  // deep filter (method pills, status, content type, size, URL regex, search)
  // is applied server-side in SQL with the same shared classifier the table
  // uses (shared/lib/traffic-classify.ts), so pages and totals are exact.
  const [serverFilters, setServerFilters] = useState<TrafficFilters>(() => initialFilters ?? createDefaultFilters());
  const serverSearch = serverFilters.search;
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
      for (const [k, v] of trafficFiltersToListParams(serverFilters)) params.set(k, v);
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
  }, [ws, page, serverFilters, serverHostname, serverPath, scopeDeviceId, scopeSessionId, sortBy, sortDir]);

  useEffect(() => {
    if (ws.connected && activeTab === 'live') fetchTraffic();
  }, [ws.connected, fetchTraffic, activeTab]);

  // Subscribe to live traffic entries + WS frame updates
  useEffect(() => {
    const unsubEntry = ws.subscribe('traffic-entry', (msg: any) => {
      const e = msg.entry;
      if (!e) return;
      if (scopeDeviceId && e.deviceId !== scopeDeviceId) return;
      if (scopeSessionId != null && e.sessionId !== scopeSessionId) return;
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
      // Same predicate the server applied to this page: a row the filters
      // exclude must not be prepended or counted.
      if (applyClientFilters([entry as TrafficEntry], serverFilters).length === 0) return;
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
  }, [ws, page, activeTab, sortBy, sortDir, serverFilters, serverSearch, serverHostname, serverPath, scopeDeviceId, scopeSessionId]);

  const handleFilterChange = useCallback((filters: TrafficFilters) => {
    // Skip no-op notifications (the table reports its state on mount) so the
    // first fetch isn't repeated and page/selection aren't reset.
    setServerFilters(prev => serializeTrafficFilters(prev) === serializeTrafficFilters(filters) ? prev : filters);
    // Any non-default state is shareable via ?filters=; the default drops it.
    // Functional update so the workspace's ?pane= / ?scope= are never clobbered.
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (isDefaultTrafficFilters(filters)) next.delete('filters');
      else next.set('filters', serializeTrafficFilters(filters));
      return next.toString() === prev.toString() ? prev : next;
    }, { replace: true });
    // NOTE: selection is intentionally NOT force-cleared here. TrafficTable
    // clears it itself (via its own effect) once the previously-selected row
    // no longer appears in the filtered set — otherwise every filter tweak
    // during triage would kick the user out of the row they're inspecting.
  }, [setSearchParams]);

  // A real filter change starts from the first page.
  const filtersKey = serializeTrafficFilters(serverFilters);
  const prevFiltersKey = useRef(filtersKey);
  useEffect(() => {
    if (prevFiltersKey.current === filtersKey) return;
    prevFiltersKey.current = filtersKey;
    setPage(0);
  }, [filtersKey]);

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
              deviceId={scopeDeviceId}
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
          // The server already filtered this page with the shared classifier,
          // so client-side filtering is a no-op for fetched rows. It stays on
          // for rows that arrive between fetches (live prepends, frame
          // updates), which the same predicate keeps consistent.
          clientSideFilter={true}
          initialFilters={initialFilters ?? undefined}
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
