import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2, Search, X } from 'lucide-react';

interface Host { hostname: string; count: number }
interface PathRow { path: string; count: number; latestId: number }

interface TrafficTreeProps {
  ws: { sendRestApi: (method: string, path: string) => Promise<any> };
  /** Restrict the tree to one capture session (per-device inspector). */
  sessionId?: number | null;
  /** Currently-active host in the table, highlighted in the tree. */
  activeHost?: string | null;
  onSelectHost: (hostname: string) => void;
  onSelectPath: (hostname: string, path: string, latestId: number) => void;
}

/**
 * TrafficTree — a collapsible host -> path navigator beside the Traffic table
 * (Charles/Burp style). Hosts come from GET /v1/traffic/tree (whole-DB
 * aggregate, not just the current 50-row page); a host's paths load lazily on
 * first expand.
 */
export function TrafficTree({ ws, sessionId, activeHost, onSelectHost, onSelectPath }: TrafficTreeProps) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pathsByHost, setPathsByHost] = useState<Map<string, PathRow[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  const visibleHosts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? hosts.filter(h => h.hostname.toLowerCase().includes(q)) : hosts;
  }, [hosts, filter]);

  const sessionQuery = sessionId != null ? `?sessionId=${sessionId}` : '';

  useEffect(() => {
    setLoading(true);
    ws.sendRestApi('GET', `/v1/traffic/tree${sessionQuery}`)
      .then(res => setHosts(res.body?.data?.hosts ?? []))
      .catch(() => setHosts([]))
      .finally(() => setLoading(false));
  }, [ws, sessionQuery]);

  const loadPaths = useCallback((hostname: string) => {
    setLoadingPaths(prev => new Set(prev).add(hostname));
    const sep = sessionQuery ? '&' : '?';
    ws.sendRestApi('GET', `/v1/traffic/tree${sessionQuery}${sep}hostname=${encodeURIComponent(hostname)}`)
      .then(res => setPathsByHost(prev => new Map(prev).set(hostname, res.body?.data?.paths ?? [])))
      .catch(() => setPathsByHost(prev => new Map(prev).set(hostname, [])))
      .finally(() => setLoadingPaths(prev => { const n = new Set(prev); n.delete(hostname); return n; }));
  }, [ws, sessionQuery]);

  const toggleExpand = useCallback((hostname: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(hostname)) {
        next.delete(hostname);
      } else {
        next.add(hostname);
        if (!pathsByHost.has(hostname)) loadPaths(hostname);
      }
      return next;
    });
  }, [pathsByHost, loadPaths]);

  return (
    <div className="traffic-tree" data-testid="traffic-tree">
      <div className="traffic-tree-header">
        <div className="traffic-tree-header-row">
          <span className="traffic-tree-header-title">Hosts</span>
          {!loading && hosts.length > 0 && (
            <span className="traffic-tree-header-count">
              {filter ? `${visibleHosts.length}/${hosts.length}` : hosts.length}
            </span>
          )}
        </div>
        {!loading && hosts.length > 0 && (
          <div className="traffic-tree-filter-wrap">
            <Search size={12} className="traffic-tree-filter-icon" />
            <input
              className="traffic-tree-filter"
              data-testid="traffic-tree-filter"
              placeholder="Filter hosts…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {filter && (
              <button className="traffic-tree-filter-clear" aria-label="Clear host filter" onClick={() => setFilter('')}>
                <X size={12} />
              </button>
            )}
          </div>
        )}
      </div>
      {loading ? (
        <div className="traffic-tree-empty">Loading…</div>
      ) : hosts.length === 0 ? (
        <div className="traffic-tree-empty">No traffic captured yet.</div>
      ) : visibleHosts.length === 0 ? (
        <div className="traffic-tree-empty">No hosts match "{filter}".</div>
      ) : (
        <div className="traffic-tree-list" role="tree">
          {visibleHosts.map(h => {
            const isOpen = expanded.has(h.hostname);
            const paths = pathsByHost.get(h.hostname);
            const isLoadingPaths = loadingPaths.has(h.hostname);
            return (
              <div key={h.hostname} role="treeitem" aria-expanded={isOpen}>
                <div className={`traffic-tree-host${activeHost === h.hostname ? ' active' : ''}`}>
                  <button
                    className={`traffic-tree-caret${isOpen ? ' open' : ''}`}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${h.hostname}`}
                    aria-expanded={isOpen}
                    onClick={() => toggleExpand(h.hostname)}
                  >
                    <ChevronRight size={12} />
                  </button>
                  <span className="traffic-tree-hostname" onClick={() => onSelectHost(h.hostname)} title={h.hostname}>
                    {h.hostname}
                  </span>
                  <span className="traffic-tree-count">{h.count}</span>
                </div>
                {isOpen && (
                  <div className="traffic-tree-paths" role="group">
                    {isLoadingPaths ? (
                      <div className="traffic-tree-path-loading"><Loader2 size={12} className="spin" /> Loading…</div>
                    ) : (paths && paths.length > 0) ? (
                      paths.map(p => (
                        <div
                          key={p.path}
                          role="treeitem"
                          className="traffic-tree-path"
                          onClick={() => onSelectPath(h.hostname, p.path, p.latestId)}
                          title={p.path}
                        >
                          <span className="traffic-tree-path-label">{p.path}</span>
                          <span className="traffic-tree-count">{p.count}</span>
                        </div>
                      ))
                    ) : (
                      <div className="traffic-tree-path-loading">No paths</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
