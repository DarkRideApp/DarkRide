/**
 * TrafficTable — reusable BurpSuite-style traffic table with optional filter bar
 * and bottom detail inspector panel. Used by:
 *
 *  - Traffic.tsx (live / saved page) — passes onFilterChange for server-side refetch
 *  - TrafficInspector.tsx (layout='table' mode) — standalone client-side filtering
 *  - ApiExplorer.tsx (captured requests per endpoint) — showFilterBar={false}
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Filter, X, ChevronUp, ChevronDown, SlidersHorizontal, Search, Save } from 'lucide-react';
import { TrafficDetailPanel } from './TrafficDetailPanel';
import { parseHostname, useTrafficReplay } from './TrafficEntryRow';
import type { TrafficEntry } from './TrafficEntryRow';
import type { WebSocketMessageEntry } from '../../../shared/types/api';
import {
  METHOD_BADGE_COLORS,
  METHOD_FILTERS,
  CONTENT_TYPE_FILTERS,
  SIZE_FILTERS,
  getMethodLabel,
  getContentType,
  getResponseSize,
  getStatusColor,
  formatDuration,
  getDurationColor,
  applyClientFilters,
  createDefaultFilters,
  filtersToPreset,
  presetToFilters,
  loadFilterPresets,
  saveFilterPresets,
  BUILTIN_PRESETS,
  type TrafficFilters,
  type MethodFilterState,
  type StatusGroupFilter,
  type SizeFilter,
  type FilterPreset,
} from './trafficUtils';

/** Slugifies a preset name into a stable data-testid / DOM key. */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const ALL_STATUS_GROUPS: StatusGroupFilter[] = ['2xx', '3xx', '4xx', '5xx'];

const SEARCH_DEBOUNCE_MS = 300;

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
    count += filters.status.size;
    count += filters.exactStatuses.size;
    count += filters.contentTypes.size;
    if (filters.size) count++;
    if (filters.search) count++;
    return count;
  }, [filters.methodFilters, filters.status, filters.exactStatuses, filters.contentTypes, filters.size, filters.search]);

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
    setFilters(prev => ({ ...prev, ...patch }));
  }, []);

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
      return { ...prev, methodFilters: next };
    });
  }, []);

  const toggleMethodExclude = useCallback((key: string) => {
    setFilters(prev => {
      const next = new Map(prev.methodFilters);
      if (next.get(key) === 'exclude') next.delete(key);
      else next.set(key, 'exclude');
      return { ...prev, methodFilters: next };
    });
  }, []);

  // Status-group pills are multi-select (OR). Clicking "ALL" clears the set.
  const toggleStatusGroup = useCallback((value: StatusGroupFilter) => {
    setFilters(prev => {
      const next = new Set(prev.status);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, status: next };
    });
  }, []);

  const toggleContentType = useCallback((key: string) => {
    setFilters(prev => {
      const next = new Set(prev.contentTypes);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, contentTypes: next };
    });
  }, []);

  // Exact status codes — free-text entry, Enter to add, chip to remove
  const [exactStatusInput, setExactStatusInput] = useState('');

  const addExactStatus = useCallback((code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setFilters(prev => {
      const next = new Set(prev.exactStatuses);
      next.add(trimmed);
      return { ...prev, exactStatuses: next };
    });
  }, []);

  const removeExactStatus = useCallback((code: string) => {
    setFilters(prev => {
      const next = new Set(prev.exactStatuses);
      next.delete(code);
      return { ...prev, exactStatuses: next };
    });
  }, []);

  // "Search all" — debounced so we don't push a server refetch on every keystroke
  const [searchInput, setSearchInput] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchInputChange = useCallback((value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      updateFilters({ search: value });
    }, SEARCH_DEBOUNCE_MS);
  }, [updateFilters]);

  useEffect(() => () => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
  }, []);

  // Saved filter presets — user-saved ones persist to localStorage; built-ins are static.
  const [userPresets, setUserPresets] = useState<FilterPreset[]>(() => loadFilterPresets());
  const allPresets = useMemo(() => [...BUILTIN_PRESETS, ...userPresets], [userPresets]);

  const [showSavePresetForm, setShowSavePresetForm] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');

  const applyPreset = useCallback((preset: FilterPreset) => {
    const restored = presetToFilters(preset);
    setSearchInput(restored.search);
    setExactStatusInput('');
    setFilters(restored);
  }, []);

  const handleSavePreset = useCallback(() => {
    const name = presetNameInput.trim();
    if (!name) return;
    setFilters(prev => {
      const preset = filtersToPreset(name, prev);
      setUserPresets(prevPresets => {
        const next = [...prevPresets.filter(p => p.name !== name), preset];
        saveFilterPresets(next);
        return next;
      });
      return prev;
    });
    setPresetNameInput('');
    setShowSavePresetForm(false);
  }, [presetNameInput]);

  // "Clear all" (from the active-filter chip bar) resets everything, including
  // the default method excludes (DNS/CONNECT/TLS Fail) — a full blank slate,
  // distinct from createDefaultFilters() which is the app's starting point.
  const clearAllFilters = useCallback(() => {
    const cleared: TrafficFilters = {
      methodFilters: new Map(),
      status: new Set(),
      exactStatuses: new Set(),
      text: '',
      search: '',
      contentTypes: new Set(),
      size: '',
    };
    setSearchInput('');
    setExactStatusInput('');
    setFilters(cleared);
  }, []);

  // Notify the caller whenever the (settled) filter state changes. Centralising
  // this in an effect — rather than calling onFilterChange inline from inside
  // every setFilters updater above — avoids "Cannot update a component while
  // rendering a different component" warnings when a consumer's onFilterChange
  // itself triggers state updates (e.g. Traffic.tsx re-deriving server params).
  useEffect(() => {
    onFilterChange?.(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

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

  // Virtualize the row list so DOM cost is bounded by the viewport, not the row
  // count. Below the threshold we render every row (no measurement flicker on
  // small lists, and the common 50-row page stays visually identical).
  const VIRTUALIZE_THRESHOLD = 50;
  const virtualizeOn = displayEntries.length > VIRTUALIZE_THRESHOLD;
  // Rows are uniform single-line height, so one fixed size drives the whole
  // list. Measure the first rendered row once (exact height incl. font/zoom)
  // and fall back to 39px (td padding 10px*2 + ~18px line) before first paint.
  const [rowHeight, setRowHeight] = useState(39);
  const measureRowRef = useCallback((el: HTMLTableRowElement | null) => {
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0) setRowHeight(prev => (Math.abs(prev - h) > 0.5 ? h : prev));
  }, []);
  const rowVirtualizer = useVirtualizer({
    count: virtualizeOn ? displayEntries.length : 0,
    getScrollElement: () => tableWrapRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const selectedEntry = selectedId != null
    ? displayEntries.find(e => e.id === selectedId) ?? entries.find(e => e.id === selectedId)
    : null;

  // Selection stability: a filter change should NOT blindly clear the
  // selected row. Keep it selected as long as it still appears in the
  // (post-filter) displayEntries; only clear it once it drops out.
  useEffect(() => {
    if (selectedId == null) return;
    const stillPresent = displayEntries.some(e => e.id === selectedId);
    if (!stillPresent) {
      handleClose();
    }
    // Only re-check when the filtered set changes — handleClose/selectedId
    // are stable-enough refs pulled fresh each render via closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayEntries]);

  // Auto-scroll to the newest row (bottom) when entries arrive in live mode.
  useEffect(() => {
    if (!liveMode || !autoScroll || displayEntries.length === 0) return;
    if (virtualizeOn) {
      rowVirtualizer.scrollToIndex(displayEntries.length - 1, { align: 'end' });
    } else if (tableWrapRef.current) {
      tableWrapRef.current.scrollTop = tableWrapRef.current.scrollHeight;
    }
  }, [displayEntries, autoScroll, liveMode, virtualizeOn, rowVirtualizer]);

  // Active-filter chips — one per active filter dimension, mirroring the
  // hidden-hostname chip pattern. Lets the user see and clear filters
  // individually without opening the collapsed panel.
  interface ActiveChip { id: string; label: string; onRemove: () => void }
  const activeChips = useMemo((): ActiveChip[] => {
    const chips: ActiveChip[] = [];
    for (const [key, state] of filters.methodFilters) {
      const def = METHOD_FILTERS.find(mf => mf.key === key);
      const label = def?.label ?? key;
      chips.push({
        id: `method-${key}-${state}`,
        label: state === 'include' ? `${label}` : `¬${label}`,
        onRemove: () => (state === 'include' ? toggleMethodInclude(key) : toggleMethodExclude(key)),
      });
    }
    for (const value of filters.status) {
      chips.push({ id: `status-${value}`, label: `Status ${value}`, onRemove: () => toggleStatusGroup(value) });
    }
    for (const code of filters.exactStatuses) {
      chips.push({ id: `exact-status-${code}`, label: `= ${code}`, onRemove: () => removeExactStatus(code) });
    }
    for (const key of filters.contentTypes) {
      const def = CONTENT_TYPE_FILTERS.find(d => d.key === key);
      chips.push({ id: `contenttype-${key}`, label: def?.label ?? key, onRemove: () => toggleContentType(key) });
    }
    if (filters.size) {
      const def = SIZE_FILTERS.find(s => s.key === filters.size);
      chips.push({ id: 'size', label: def?.label ?? filters.size, onRemove: () => updateFilters({ size: '' }) });
    }
    if (filters.search) {
      chips.push({ id: 'search', label: `Search: ${filters.search}`, onRemove: () => { setSearchInput(''); updateFilters({ search: '' }); } });
    }
    if (filters.text) {
      chips.push({ id: 'text', label: `Host: ${filters.text}`, onRemove: () => updateFilters({ text: '' }) });
    }
    return chips;
  }, [filters, toggleMethodInclude, toggleMethodExclude, toggleStatusGroup, removeExactStatus, toggleContentType, updateFilters]);

  // One data row. `measureRef` is attached to the first virtualized row so the
  // uniform row height can be read once; the fast path omits it.
  const renderRow = (
    entry: TrafficEntry,
    measureRef?: (el: HTMLTableRowElement | null) => void,
  ) => {
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
        ref={measureRef}
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
  };

  return (
    <div className={`traffic-table-container${className ? ` ${className}` : ''}`}>
      {/* Filter bar */}
      {showFilterBar && (
        <div className="traffic-filter-bar">
          {/* Always-visible row: host filter + search-all + filter toggle + live controls */}
          <div className="traffic-filter-bar-main">
            <div className="traffic-filter-inputs">
              <div className="traffic-filter-text" title="Fast client-side filter: matches the request URL (host + path) as plain text or a regex">
                <Filter size={14} className="traffic-filter-text-icon" />
                <input
                  type="text"
                  className="traffic-filter-text-input"
                  placeholder="Filter by host or regex..."
                  value={filters.text}
                  onChange={e => updateFilters({ text: e.target.value })}
                />
              </div>
              <div className="traffic-filter-search" title="Search across the full request/response — URL, body, and headers">
                <Search size={14} className="traffic-filter-search-icon" />
                <input
                  type="text"
                  className="traffic-filter-text-input"
                  placeholder="Search all (URL, body, headers)..."
                  value={searchInput}
                  onChange={e => handleSearchInputChange(e.target.value)}
                  data-testid="traffic-search-all-input"
                />
              </div>
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

              {/* Status pills — multi-select (OR); ALL clears the set */}
              <div className="traffic-filter-group">
                <span className="traffic-filter-label">Status</span>
                <div className="traffic-status-pills">
                  <button
                    className={`traffic-status-pill${filters.status.size === 0 ? ' active' : ''} status-all`}
                    onClick={() => updateFilters({ status: new Set() })}
                  >
                    ALL
                  </button>
                  {ALL_STATUS_GROUPS.map(value => (
                    <button
                      key={value}
                      className={`traffic-status-pill${filters.status.has(value) ? ' active' : ''} status-${value}`}
                      onClick={() => toggleStatusGroup(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>

              {/* Exact status codes — supplements the century pills above */}
              <div className="traffic-filter-group">
                <span className="traffic-filter-label">Exact status</span>
                <div className="traffic-exact-status">
                  <input
                    type="text"
                    inputMode="numeric"
                    className="traffic-exact-status-input"
                    placeholder="e.g. 404"
                    value={exactStatusInput}
                    data-testid="filter-exact-status-input"
                    onChange={e => setExactStatusInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && exactStatusInput) {
                        addExactStatus(exactStatusInput);
                        setExactStatusInput('');
                      }
                    }}
                  />
                  {Array.from(filters.exactStatuses).map(code => (
                    <span key={code} className="traffic-exact-status-chip" data-testid={`exact-status-chip-${code}`}>
                      {code}
                      <button onClick={() => removeExactStatus(code)} title={`Remove ${code}`}>
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>

              {/* Content-type pills */}
              <div className="traffic-filter-group">
                <span className="traffic-filter-label">Type</span>
                <div className="traffic-content-type-pills">
                  {CONTENT_TYPE_FILTERS.map(ct => (
                    <button
                      key={ct.key}
                      className={`traffic-content-type-pill${filters.contentTypes.has(ct.key) ? ' active' : ''}`}
                      data-testid={`filter-contenttype-${ct.key}`}
                      onClick={() => toggleContentType(ct.key)}
                    >
                      {ct.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Response-size quick filters */}
              <div className="traffic-filter-group">
                <span className="traffic-filter-label">Size</span>
                <div className="traffic-size-pills">
                  {SIZE_FILTERS.map(({ key, label }) => (
                    <button
                      key={key || 'any'}
                      className={`traffic-size-pill${filters.size === key ? ' active' : ''}`}
                      data-testid={`filter-size-${key || 'any'}`}
                      onClick={() => updateFilters({ size: key as SizeFilter })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Saved filter presets */}
              <div className="traffic-filter-group traffic-filter-presets">
                <span className="traffic-filter-label">Presets</span>
                <div className="traffic-preset-pills">
                  {allPresets.map(preset => (
                    <button
                      key={preset.name}
                      className="traffic-preset-pill"
                      data-testid={`preset-${slugify(preset.name)}`}
                      onClick={() => applyPreset(preset)}
                      title={`Apply "${preset.name}"`}
                    >
                      {preset.name}
                    </button>
                  ))}
                  {!showSavePresetForm ? (
                    <button
                      className="traffic-preset-save-btn"
                      data-testid="preset-save-btn"
                      onClick={() => setShowSavePresetForm(true)}
                      title="Save current filters as a preset"
                    >
                      <Save size={11} /> Save current
                    </button>
                  ) : (
                    <span className="traffic-preset-save-form">
                      <input
                        type="text"
                        className="traffic-preset-save-input"
                        placeholder="Preset name..."
                        value={presetNameInput}
                        data-testid="preset-name-input"
                        onChange={e => setPresetNameInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleSavePreset(); }}
                        autoFocus
                      />
                      <button
                        className="traffic-preset-save-confirm"
                        data-testid="preset-save-confirm"
                        onClick={handleSavePreset}
                      >
                        Save
                      </button>
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Active-filter chips — visible whenever any filter is active, independent
          of whether the collapsible panel is expanded, so filters stay legible
          and individually removable at a glance. */}
      {activeChips.length > 0 && (
        <div className="traffic-active-filters-bar" data-testid="active-filters-bar">
          <span className="traffic-active-filters-label">Active:</span>
          {activeChips.map(chip => (
            <span key={chip.id} className="traffic-active-filter-chip" data-testid={`active-filter-chip-${chip.id}`}>
              {chip.label}
              <button onClick={chip.onRemove} title="Remove filter">
                <X size={10} />
              </button>
            </span>
          ))}
          <button
            className="traffic-active-filters-clear"
            onClick={clearAllFilters}
            data-testid="active-filters-clear-all"
          >
            Clear all
          </button>
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
                  {virtualizeOn ? (() => {
                    const items = rowVirtualizer.getVirtualItems();
                    const total = rowVirtualizer.getTotalSize();
                    const padTop = items.length ? items[0].start : 0;
                    const padBottom = items.length ? total - items[items.length - 1].end : 0;
                    return (
                      <>
                        <tr data-testid="traffic-vspacer-top" aria-hidden="true">
                          <td colSpan={7} style={{ height: padTop, padding: 0, border: 0 }} />
                        </tr>
                        {items.map((vi, i) => renderRow(displayEntries[vi.index], i === 0 ? measureRowRef : undefined))}
                        <tr data-testid="traffic-vspacer-bottom" aria-hidden="true">
                          <td colSpan={7} style={{ height: padBottom, padding: 0, border: 0 }} />
                        </tr>
                      </>
                    );
                  })() : (
                    displayEntries.map(entry => renderRow(entry))
                  )}
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
