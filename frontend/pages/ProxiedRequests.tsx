import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { StatCard } from '@darkrideapp/plugin-sdk/react';
import { StatusBadge } from '@darkrideapp/plugin-sdk/react';
import { useSortableTable } from '@darkrideapp/plugin-sdk/react';
import { SortableHeader } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';

interface ActiveRequest {
  id: string;
  url: string;
  method: string;
  proxyType: string;
  proxyLabel: string;
  createdAt: string;
  startedAt: string | null;
}

interface HistoryEntry {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
  proxyType: string;
  proxyLabel: string;
  status: 'completed' | 'failed';
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  responseBodyBase64: string | null;
  timingMs: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string;
}

function tryPrettyJson(str: string | null): string {
  if (!str) return '';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function formatHeaders(headers: Record<string, string> | null): string {
  if (!headers) return '';
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

export function ProxiedRequests() {
  useDocumentTitle('HTTP Requests');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const [active, setActive] = useState<ActiveRequest[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [stats, setStats] = useState({ queued: 0, active: 0, completed: 0, failed: 0 });
  const [, setTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Live elapsed timer for active requests
  useEffect(() => {
    timerRef.current = setInterval(() => setTick(t => t + 1), 100);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Hydrate on mount
  useEffect(() => {
    if (!ws.connected) return;

    ws.sendRestApi('GET', '/v1/proxied-request/history?limit=50').then(res => {
      const data = res.body?.data;
      if (Array.isArray(data)) {
        setHistory(data);
        const completed = data.filter((e: HistoryEntry) => e.status === 'completed').length;
        const failed = data.filter((e: HistoryEntry) => e.status === 'failed').length;
        setStats(s => ({ ...s, completed, failed }));
      }
    }).catch(() => {});

    ws.sendRestApi('GET', '/v1/proxied-request/status').then(res => {
      const data = res.body?.data;
      if (data) {
        setStats(s => ({ ...s, queued: data.queueLength || 0, active: data.activeCount || 0 }));
      }
    }).catch(() => {});
  }, [ws, ws.connected]);

  // Subscribe to WebSocket events
  useEffect(() => {
    const unsubQueued = ws.subscribe('proxied-request-queued', (msg: any) => {
      setActive(prev => [...prev, {
        id: msg.id,
        url: msg.url,
        method: msg.method,
        proxyType: msg.proxyType,
        proxyLabel: msg.proxyLabel,
        createdAt: msg.createdAt,
        startedAt: null,
      }]);
      setStats(s => ({ ...s, queued: s.queued + 1 }));
    });

    const unsubStarted = ws.subscribe('proxied-request-started', (msg: any) => {
      setActive(prev => prev.map(r =>
        r.id === msg.id ? { ...r, startedAt: msg.startedAt } : r
      ));
      setStats(s => ({ ...s, queued: Math.max(0, s.queued - 1), active: s.active + 1 }));
    });

    const unsubCompleted = ws.subscribe('proxied-request-completed', (msg: any) => {
      setActive(prev => prev.filter(r => r.id !== msg.id));
      setStats(s => ({
        ...s,
        active: Math.max(0, s.active - 1),
        completed: s.completed + 1,
      }));
      // Fetch the full history entry
      ws.sendRestApi('GET', '/v1/proxied-request/history?limit=1').then(res => {
        const data = res.body?.data;
        if (Array.isArray(data) && data.length > 0) {
          setHistory(prev => {
            const existing = prev.find(e => e.id === data[0].id);
            if (existing) return prev;
            return [data[0], ...prev].slice(0, 200);
          });
        }
      }).catch(() => {});
    });

    const unsubFailed = ws.subscribe('proxied-request-failed', (msg: any) => {
      setActive(prev => prev.filter(r => r.id !== msg.id));
      setStats(s => ({
        ...s,
        active: Math.max(0, s.active - 1),
        failed: s.failed + 1,
      }));
      ws.sendRestApi('GET', '/v1/proxied-request/history?limit=1').then(res => {
        const data = res.body?.data;
        if (Array.isArray(data) && data.length > 0) {
          setHistory(prev => {
            const existing = prev.find(e => e.id === data[0].id);
            if (existing) return prev;
            return [data[0], ...prev].slice(0, 200);
          });
        }
      }).catch(() => {});
    });

    return () => {
      unsubQueued();
      unsubStarted();
      unsubCompleted();
      unsubFailed();
    };
  }, [ws]);

  const { sorted: sortedHistory, sortKey: historySortKey, sortDir: historySortDir, onSort: onHistorySort } = useSortableTable(history, 'completedAt', 'desc');

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => prev === id ? null : id);
  }, []);

  const getElapsedMs = (startedAt: string | null, createdAt: string): number => {
    const ref = startedAt || createdAt;
    return Date.now() - new Date(ref).getTime();
  };

  const formatElapsed = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  if (auth && !auth.hasScope('core.traffic:read')) return <AccessDenied scope="core.traffic:read" />;

  return (
    <div data-testid="proxied-requests-page">
      <PageHeader
        title="HTTP Requests"
        subtitle="Server-side outbound requests routed through your configured proxies"
      />

      <div className="card proxied-requests-overview" data-testid="overview-section">
        <div className="proxied-requests-overview-grid">
          <div>
            <div className="proxied-requests-overview-heading">What is this?</div>
            <p className="proxied-requests-overview-text">
              HTTP Requests are outbound calls made <strong>from the DarkRide server</strong> through
              your proxy pool. Use them in automations
              via <code>device.httpGet()</code> / <code>device.httpPost()</code>, or call
              the <code>POST /v1/proxied-request</code> API directly.
              Each request is routed through a proxy from
              the <a href="/ui/proxies">Proxies</a> page, NordVPN SOCKS5, or an inline proxy URL.
            </p>
          </div>
          <div>
            <div className="proxied-requests-overview-heading">How is this different from Traffic?</div>
            <p className="proxied-requests-overview-text">
              <a href="/ui/traffic">Traffic</a> captures requests made <strong>by apps on the
              device</strong> (intercepted via mitmproxy). HTTP Requests are the
              opposite direction &mdash; calls made <strong>by the server on behalf of
              your automation</strong>, useful for API calls, scraping, or data fetching
              through different proxy IPs.
            </p>
          </div>
        </div>
      </div>

      <div className="card-grid" data-testid="stats-grid">
        <StatCard value={stats.queued} label="Queue" detail="Pending requests" />
        <StatCard value={stats.active} label="Active" detail="In-flight requests" />
        <StatCard
          value={stats.completed + stats.failed}
          label="Completed"
          detail={`${stats.completed} success / ${stats.failed} failed`}
        />
      </div>

      {active.length > 0 && (
        <div data-testid="active-requests">
          <h2 style={{ margin: '24px 0 12px' }}>Active Requests</h2>
          <div className="proxied-active-cards">
            {active.map(r => (
              <div key={r.id} className="proxied-active-card" data-testid={`active-${r.id}`}>
                <div className="pulse-dot" />
                <div className="active-card-info">
                  <div className="active-card-url">
                    <strong>{r.method}</strong> {r.url}
                  </div>
                  <div className="active-card-meta">
                    {r.proxyLabel}
                  </div>
                </div>
                <div className="active-card-timer">
                  {formatElapsed(getElapsedMs(r.startedAt, r.createdAt))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <h2 style={{ margin: '24px 0 12px' }}>Request History</h2>
      {history.length === 0 ? (
        <div className="empty-state" data-testid="empty-history">
          <div className="empty-message">No requests yet</div>
          <div className="empty-description">
            Requests will appear here when automations call <code style={{
              fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)',
              padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border-color)',
            }}>device.httpGet()</code> or <code style={{
              fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)',
              padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border-color)',
            }}>device.httpPost()</code>, or when you use the API directly.
          </div>
        </div>
      ) : (
        <div className="table-card"><table className="data-table" data-testid="history-table">
          <thead>
            <tr>
              <SortableHeader label="Status" sortKey="status" currentSort={historySortKey} dir={historySortDir} onSort={onHistorySort} />
              <SortableHeader label="Method" sortKey="method" currentSort={historySortKey} dir={historySortDir} onSort={onHistorySort} />
              <SortableHeader label="URL" sortKey="url" currentSort={historySortKey} dir={historySortDir} onSort={onHistorySort} />
              <th className="hide-mobile">Proxy</th>
              <SortableHeader label="Response" sortKey="responseStatus" currentSort={historySortKey} dir={historySortDir} onSort={onHistorySort} />
              <SortableHeader label="Timing" sortKey="timingMs" currentSort={historySortKey} dir={historySortDir} onSort={onHistorySort} style={{ }} />
              <SortableHeader label="Time" sortKey="completedAt" currentSort={historySortKey} dir={historySortDir} onSort={onHistorySort} style={{ }} />
            </tr>
          </thead>
          <tbody>
            {sortedHistory.map(e => (
              <React.Fragment key={e.id}>
                <tr className="clickable-row" onClick={() => toggleExpand(e.id)} data-testid={`row-${e.id}`}>
                  <td>
                    <StatusBadge status={e.status === 'completed' ? 'success' : 'failed'} />
                  </td>
                  <td><strong>{e.method}</strong></td>
                  <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.url}
                  </td>
                  <td className="hide-mobile">{e.proxyLabel}</td>
                  <td>{e.responseStatus ?? '—'}</td>
                  <td className="hide-mobile">{e.timingMs != null ? `${e.timingMs}ms` : '—'}</td>
                  <td className="hide-mobile">{new Date(e.completedAt).toLocaleString()}</td>
                </tr>
                {expandedId === e.id && (
                  <tr>
                    <td colSpan={7}>
                      <div className="traffic-detail" data-testid={`detail-${e.id}`}>
                        {e.error && (
                          <>
                            <h4>Error</h4>
                            <pre style={{ color: 'var(--danger)' }}>{e.error}</pre>
                          </>
                        )}
                        <h4>Request Headers</h4>
                        <pre>{formatHeaders(e.headers)}</pre>
                        {e.body && (
                          <>
                            <h4>Request Body</h4>
                            <pre>{tryPrettyJson(e.body)}</pre>
                          </>
                        )}
                        {e.responseHeaders && (
                          <>
                            <h4>Response Headers</h4>
                            <pre>{formatHeaders(e.responseHeaders)}</pre>
                          </>
                        )}
                        {e.responseBody != null ? (
                          <>
                            <h4>Response Body</h4>
                            <pre>{tryPrettyJson(e.responseBody)}</pre>
                          </>
                        ) : e.responseBodyBase64 ? (
                          <>
                            <h4>Response Body</h4>
                            <pre>(binary, {Math.ceil((e.responseBodyBase64.length * 3) / 4)} bytes base64)</pre>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
