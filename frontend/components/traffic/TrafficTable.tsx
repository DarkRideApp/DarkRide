/**
 * TrafficTable — reusable BurpSuite-style traffic table with optional filter bar
 * and bottom detail inspector panel. Used by:
 *
 *  - Traffic.tsx (live / saved page) — passes onFilterChange for server-side refetch
 *  - TrafficInspector.tsx (layout='table' mode) — standalone client-side filtering
 *  - ApiExplorer.tsx (captured requests per endpoint) — showFilterBar={false}
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Filter, X, ChevronUp, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { TrafficDetailPanel } from './TrafficDetailPanel';
import { parseHostname, useTrafficReplay } from './TrafficEntryRow';
import type { TrafficEntry } from './TrafficEntryRow';
import type { WebSocketMessageEntry } from '../../../shared/types/api';
import {
  METHOD_BADGE_COLORS,
  METHOD_FILTERS,
  getMethodLabel,
  getContentType,
  getResponseSize,
  getStatusColor,
  formatDuration,
  getDurationColor,
  applyClientFilters,
  createDefaultFilters,
  type TrafficFilters,
  type MethodFilterState,
  type StatusGroupFilter,
} from './trafficUtils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TrafficTableProps {
  entries: TrafficEntry[];

  /** Show skeleton/spinner state */
  loading?: boolean;

  /** Message when there are no entries (after filtering) */
  emptyMessage?: string;

  /** Show the protocol/status/text filter bar above the table (default: true) */
  showFilterBar?: boolean;

  /**
   * When provided, called whenever the user changes a filter.
   * Useful for consumers that do server-side filtering (e.g. Traffic.tsx).
   * The component still applies client-side filtering on top of what's passed in.
   */
  onFilterChange?: (filters: TrafficFilters) => void;

  /**
   * When provided, the consumer controls whether client-side filtering is applied.
   * Default: true (filter entries in-component).
   * Set to false when the consumer already pre-filters server-side.
   */
  clientSideFilter?: boolean;

  /** Called when "Load full body" is needed for a truncated entry */
  onLoadFullBody?: (id: number) => void;

  /** Called when user triggers a replay action */
  onReplay?: (entry: TrafficEntry) => void;

  /** WebSocket frame data keyed by entry id, for WS entries */
  wsFrames?: Map<number, WebSocketMessageEntry[]>;

  /** Called when WS frames need to be loaded for an entry */
  onLoadWsFrames?: (id: number) => void;

  /** Optional footer / pagination slot rendered below the table */
  footer?: React.ReactNode;

  /** Extra class on the outermost wrapper div */
  className?: string;

  /** Controlled selected entry id. If not provided, TrafficTable manages selection itself. */
  selectedId?: number | null;

  /** Callback when selection changes (for controlled usage) */
  onSelectEntry?: (id: number | null) => void;

  /** Called when user wants to block a hostname globally (API call). Only shown if provided. */
  onBlockHostname?: (hostname: string) => void;

  /** Called when user wants to hide a hostname from the current view (client-side). Only shown if provided. */
  onHideHostname?: (hostname: string) => void;

  /** Enable live-mode UI: auto-scroll toggle + clear button in filter bar */
  liveMode?: boolean;

  /** Called when user clicks "Clear" in live mode */
  onClear?: () => void;

  /**
   * When provided, clicking a sortable column header calls this instead of doing
   * client-side sort. Useful for server-side pagination (Traffic.tsx).
   * sortBy values: 'capturedAt' | 'requestMethod' | 'requestUrl' | 'responseStatus'
   */
  onSortChange?: (sortBy: string, sortDir: 'asc' | 'desc') => void;

  /** Current sort column (for controlled sort indicators when using onSortChange) */
  sortBy?: string;

  /** Current sort direction (for controlled sort indicators when using onSortChange) */
  sortDir?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TrafficTable({
  entries,
  loading = false,
  emptyMessage = 'No traffic captured',
  showFilterBar = true,
  onFilterChange,
  clientSideFilter = true,
  onLoadFullBody,
  onReplay: onReplayProp,
  wsFrames,
  onLoadWsFrames,
  footer,
  className,
  selectedId: controlledSelectedId,
  onSelectEntry,
  onBlockHostname,
  onHideHostname,
  liveMode = false,
  onClear,
  onSortChange,
  sortBy: controlledSortBy,
  sortDir: controlledSortDir,
}: TrafficTableProps) {
  const internalReplay = useTrafficReplay();
  const handleReplay = onReplayProp ?? internalReplay;

  // Auto-scroll state (live mode only)
  const [autoScroll, setAutoScroll] = useState(true);
  const tableWrapRef = useRef<HTMLDivElement>(null);

  // Hidden hostnames — client-side filtering (mirrors TrafficInspector list layout)
  const [hiddenHostnames, setHiddenHostnames] = useState<Map<string, boolean>>(new Map());

  const handleHideHostname = useCallback((hostname: string) => {
    setHiddenHostnames(prev => {
      const next = new Map(prev);
      next.set(hostname, true);
      return next;
    });
    onHideHostname?.(hostname);
  }, [onHideHostname]);

  const handleBlockHostname = useCallback((hostname: string) => {
    onBlockHostname?.(hostname);
    // Also hide locally so it disappears immediately
    handleHideHostname(hostname);
  }, [onBlockHostname, handleHideHostname]);

  const toggleHostnameFilter = useCallback((hostname: string) => {
    setHiddenHostnames(prev => {
      const next = new Map(prev);
      next.set(hostname, !prev.get(hostname));
      return next;
    });
  }, []);

  const removeHostnameFilter = useCallback((hostname: string) => {
    setHiddenHostnames(prev => {
      const next = new Map(prev);
      next.delete(hostname);
      return next;
    });
  }, []);

  const clearAllHostnameFilters = useCallback(() => {
    setHiddenHostnames(new Map());
  }, []);

  // Filter state — always owned internally; onFilterChange lets callers react to changes
  const [filters, setFilters] = useState<TrafficFilters>(createDefaultFilters);

  // Collapsible filter panel state
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    for (const [, state] of filters.methodFilters) {
      if (state !== undefined) count++;
    }
    if (filters.status !== '') count++;
    return count;
  }, [filters.methodFilters, filters.status]);

  // Internal selection state — used when caller is uncontrolled
  const [internalSelectedId, setInternalSelectedId] = useState<number | null>(null);

  const isControlled = controlledSelectedId !== undefined;
  const selectedId = isControlled ? controlledSelectedId : internalSelectedId;

  const handleSelect = useCallback((id: number) => {
    const next = selectedId === id ? null : id;
    if (isControlled) {
      onSelectEntry?.(next);
    } else {
      setInternalSelectedId(next);
    }
  }, [selectedId, isControlled, onSelectEntry]);

  const handleClose = useCallback(() => {
    if (isControlled) {
      onSelectEntry?.(null);
    } else {
      setInternalSelectedId(null);
    }
  }, [isControlled, onSelectEntry]);

  const updateFilters = useCallback((patch: Partial<TrafficFilters>) => {
    setFilters(prev => {
      const next = { ...prev, ...patch };
      onFilterChange?.(next);
      return next;
    });
  }, [onFilterChange]);

  // Sort handling — used when onSortChange is provided (server-side sort)
  const handleHeaderSort = useCallback((column: string) => {
    if (!onSortChange) return;
    const currentDir = controlledSortDir ?? 'desc';
    const newDir: 'asc' | 'desc' = controlledSortBy === column && currentDir === 'desc' ? 'asc' : 'desc';
    onSortChange(column, newDir);
  }, [onSortChange, controlledSortBy, controlledSortDir]);

  const toggleMethodInclude = useCallback((key: string) => {
    setFilters(prev => {
      const next = new Map(prev.methodFilters);
      if (next.get(key) === 'include') next.delete(key);
      else next.set(key, 'include');
      const updated = { ...prev, methodFilters: next };
      onFilterChange?.(updated);
      return updated;
    });
  }, [onFilterChange]);

  const toggleMethodExclude = useCallback((key: string) => {
    setFilters(prev => {
      const next = new Map(prev.methodFilters);
      if (next.get(key) === 'exclude') next.delete(key);
      else next.set(key, 'exclude');
      const updated = { ...prev, methodFilters: next };
      onFilterChange?.(updated);
      return updated;
    });
  }, [onFilterChange]);

  // Apply client-side filters when enabled, then hide hostnames
  const displayEntries = useMemo(() => {
    let result = clientSideFilter ? applyClientFilters(entries, filters) : entries;
    if (hiddenHostnames.size > 0) {
      result = result.filter(e => {
        const hostname = parseHostname(e.requestUrl);
        return !hostname || hiddenHostnames.get(hostname) !== true;
      });
    }
    return result;
  }, [entries, filters, clientSideFilter, hiddenHostnames]);

  const selectedEntry = selectedId != null
    ? displayEntries.find(e => e.id === selectedId) ?? entries.find(e => e.id === selectedId)
    : null;

  // Auto-scroll to bottom when new entries arrive (live mode)
  useEffect(() => {
    if (!liveMode || !autoScroll || !tableWrapRef.current) return;
    tableWrapRef.current.scrollTop = tableWrapRef.current.scrollHeight;
  }, [displayEntries, autoScroll, liveMode]);

  return (
    <div className={`traffic-table-container${className ? ` ${className}` : ''}`}>
      {/* Filter bar */}
      {showFilterBar && (
        <div className="traffic-filter-bar">
          {/* Always-visible row: search + filter toggle + live controls */}
          <div className="traffic-filter-bar-main">
            <div className="traffic-filter-text">
              <Filter size={14} className="traffic-filter-text-icon" />
              <input
                type="text"
                className="traffic-filter-text-input"
                placeholder="Filter by host or regex..."
                value={filters.text}
                onChange={e => updateFilters({ text: e.target.value })}
              />
            </div>
            <button
              className={`traffic-filter-toggle${filtersExpanded ? ' active' : ''}${activeFilterCount > 0 ? ' has-filters' : ''}`}
              onClick={() => setFiltersExpanded(prev => !prev)}
            >
              <SlidersHorizontal size={14} />
              Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </button>
            {/* Live mode controls */}
            {liveMode && (
              <div className="traffic-live-controls">
                <button
                  className={`traffic-live-btn${autoScroll ? ' active' : ''}`}
                  onClick={() => setAutoScroll(prev => !prev)}
                  title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
                >
                  {autoScroll ? 'Scroll: ON' : 'Scroll: OFF'}
                </button>
                {onClear && (
                  <button
                    className="traffic-live-btn"
                    onClick={onClear}
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Collapsible filter panel */}
          {filtersExpanded && (
            <div className="traffic-filter-panel">
              {/* Method filters — tri-state toggle buttons */}
              <div className="traffic-filter-group">
                <span className="traffic-filter-label">Method</span>
                <div className="traffic-method-filters">
                  {METHOD_FILTERS.map(mf => {
                    const state = filters.methodFilters.get(mf.key);
                    return (
                      <span
                        key={mf.key}
                        className="traffic-method-filter"
                        style={{
                          borderColor: state === 'exclude' ? '#ef4444' : state === 'include' ? mf.color : 'transparent',
                        }}
                        data-testid={`filter-method-${mf.key}`}
                      >
                        <button
                          className="traffic-method-filter-btn"
                          onClick={() => toggleMethodInclude(mf.key)}
                          style={{
                            opacity: state ? 1 : 0.4,
                            background: state === 'include' ? mf.color : state === 'exclude' ? 'transparent' : undefined,
                            color: state === 'include' ? '#fff' : state === 'exclude' ? '#ef4444' : undefined,
                            textDecoration: state === 'exclude' ? 'line-through' : undefined,
                          }}
                        >
                          {mf.label}
                        </button>
                        <button
                          className="traffic-method-filter-x"
                          onClick={() => toggleMethodExclude(mf.key)}
                          style={{
                            opacity: state === 'exclude' ? 1 : 0.3,
                            color: state === 'exclude' ? '#ef4444' : undefined,
                          }}
                          title={state === 'exclude' ? `Show ${mf.label}` : `Hide ${mf.label}`}
                        >
                          &#10005;
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Status pills */}
              <div className="traffic-filter-group">
                <span className="traffic-filter-label">Status</span>
                <div className="traffic-status-pills">
                  {([
                    ['', 'ALL'],
                    ['2xx', '2xx'],
                    ['3xx', '3xx'],
                    ['4xx', '4xx'],
                    ['5xx', '5xx'],
                  ] as [StatusGroupFilter, string][]).map(([value, label]) => (
                    <button
                      key={value}
                      className={`traffic-status-pill${filters.status === value ? ' active' : ''} status-${value || 'all'}`}
                      onClick={() => updateFilters({ status: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Hidden hostname chips */}
      {hiddenHostnames.size > 0 && (
        <div className="traffic-hidden-hosts-bar" data-testid="hostname-filter-bar">
          <span className="traffic-hidden-hosts-label">Hidden:</span>
          {Array.from(hiddenHostnames.entries()).map(([hostname, enabled]) => (
            <span
              key={hostname}
              className={`traffic-hidden-host-chip${enabled ? '' : ' disabled'}`}
              data-testid={`hostname-chip-${hostname}`}
            >
              <span className="traffic-hidden-host-name" onClick={() => toggleHostnameFilter(hostname)}>
                {hostname}
              </span>
              <button
                className="traffic-hidden-host-remove"
                onClick={() => removeHostnameFilter(hostname)}
                data-testid={`hostname-chip-remove-${hostname}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <button
            className="traffic-hidden-hosts-clear"
            onClick={clearAllHostnameFilters}
            data-testid="hostname-filter-clear-all"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Table area + detail panel */}
      <div className="traffic-main">
        {loading ? (
          <div className="traffic-table-loading">
            <span className="traffic-table-loading-text">Loading...</span>
          </div>
        ) : displayEntries.length === 0 ? (
          <div className="empty-state" style={{ padding: 48 }}>{emptyMessage}</div>
        ) : (
          <>
            <div className="traffic-table-wrap" ref={tableWrapRef}>
              <table className="traffic-table" data-testid="traffic-table">
                <thead>
                  <tr>
                    {onSortChange ? (
                      <>
                        <th
                          style={{ width: 80, cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => handleHeaderSort('requestMethod')}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            Method
                            {controlledSortBy === 'requestMethod'
                              ? (controlledSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                              : <ChevronDown size={12} style={{ opacity: 0.3 }} />}
                          </span>
                        </th>
                        <th
                          style={{ cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => handleHeaderSort('requestUrl')}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            Host / Path
                            {controlledSortBy === 'requestUrl'
                              ? (controlledSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                              : <ChevronDown size={12} style={{ opacity: 0.3 }} />}
                          </span>
                        </th>
                        <th
                          style={{ width: 64, cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => handleHeaderSort('responseStatus')}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            Status
                            {controlledSortBy === 'responseStatus'
                              ? (controlledSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                              : <ChevronDown size={12} style={{ opacity: 0.3 }} />}
                          </span>
                        </th>
                        <th style={{ width: 90 }}>Type</th>
                        <th style={{ width: 80 }}>Size</th>
                        <th
                          style={{ width: 76, textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => handleHeaderSort('durationMs')}
                          data-testid="traffic-header-duration"
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
                            Duration
                            {controlledSortBy === 'durationMs'
                              ? (controlledSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                              : <ChevronDown size={12} style={{ opacity: 0.3 }} />}
                          </span>
                        </th>
                        <th
                          style={{ width: 72, textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => handleHeaderSort('capturedAt')}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
                            Time
                            {controlledSortBy === 'capturedAt' || !controlledSortBy
                              ? (controlledSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                              : <ChevronDown size={12} style={{ opacity: 0.3 }} />}
                          </span>
                        </th>
                      </>
                    ) : (
                      <>
                        <th style={{ width: 80 }}>Method</th>
                        <th>Host / Path</th>
                        <th style={{ width: 64 }}>Status</th>
                        <th style={{ width: 90 }}>Type</th>
                        <th style={{ width: 80 }}>Size</th>
                        <th style={{ width: 76, textAlign: 'right' }}>Duration</th>
                        <th style={{ width: 72, textAlign: 'right' }}>Time</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {displayEntries.map(entry => {
                    const methodLabel = getMethodLabel(entry);
                    const badge = METHOD_BADGE_COLORS[methodLabel]
                      ?? METHOD_BADGE_COLORS[entry.requestMethod]
                      ?? { bg: 'rgba(139,149,176,0.1)', color: '#8b95b0' };
                    const hostname = parseHostname(entry.requestUrl);
                    const path = (() => {
                      try {
                        const u = new URL(entry.requestUrl);
                        return u.pathname + u.search;
                      } catch {
                        return entry.requestUrl;
                      }
                    })();
                    const isSelected = selectedId === entry.id;
                    const isWs = entry.type === 'websocket';
                    const contentType = getContentType(entry);
                    const size = getResponseSize(entry.responseBody);
                    const time = (() => {
                      try {
                        return new Date(entry.capturedAt).toLocaleTimeString('en-US', { hour12: false });
                      } catch {
                        return '';
                      }
                    })();

                    return (
                      <tr
                        key={entry.id}
                        className={isSelected ? 'selected' : ''}
                        onClick={() => handleSelect(entry.id)}
                        data-testid={`traffic-row-${entry.id}`}
                      >
                        <td>
                          <span
                            className="traffic-method-badge"
                            style={{ background: badge.bg, color: badge.color }}
                          >
                            {methodLabel}
                          </span>
                        </td>
                        <td className="traffic-cell-path">
                          <span className="traffic-hostname">{hostname}</span>
                          <span className="traffic-path">
                            {path.length > 80 ? path.slice(0, 80) + '…' : path}
                          </span>
                        </td>
                        <td>
                          <span
                            className="traffic-status"
                            style={{
                              color: getStatusColor(entry.responseStatus),
                              fontWeight: 700,
                            }}
                          >
                            {isWs
                              ? `${entry.wsMessageCount ?? 0}f`
                              : entry.pending
                                ? '…'
                                : entry.responseStatus === 0
                                  ? 'TLS'
                                  : (entry.responseStatus ?? '—')}
                          </span>
                        </td>
                        <td className="traffic-cell-type">{contentType}</td>
                        <td className="traffic-cell-size">{size}</td>
                        <td
                          className="traffic-cell-duration"
                          style={{ textAlign: 'right', color: getDurationColor(entry.durationMs) }}
                          data-testid={`traffic-duration-${entry.id}`}
                        >
                          {isWs ? '—' : formatDuration(entry.durationMs)}
                        </td>
                        <td className="traffic-cell-time">{time}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {selectedEntry && (
              <TrafficDetailPanel
                entry={selectedEntry}
                onClose={handleClose}
                onReplay={handleReplay}
                onLoadFullBody={onLoadFullBody}
                wsFrames={wsFrames?.get(selectedEntry.id)}
                onLoadWsFrames={onLoadWsFrames}
                onBlockHostname={onBlockHostname ? handleBlockHostname : undefined}
                onHideHostname={handleHideHostname}
              />
            )}
          </>
        )}
      </div>

      {footer}
    </div>
  );
}
