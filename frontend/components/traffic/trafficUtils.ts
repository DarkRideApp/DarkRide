/**
 * Shared utilities for traffic display across all views:
 * - Traffic page (live/saved)
 * - Session timeline (static review)
 * - Live capture (DeviceView)
 * - API Catalogue / API Explorer
 */

import { detectGraphQL } from '../../../shared/lib/graphql-detect';
import { detectProtobuf } from '../../../shared/lib/protobuf-detect';
import type { TrafficTimings } from '../../../shared/types/api';
import type { TrafficEntry } from './TrafficEntryRow';

// ---------------------------------------------------------------------------
// Method badge colour map
// ---------------------------------------------------------------------------

export const METHOD_BADGE_COLORS: Record<string, { bg: string; color: string }> = {
  GET:     { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
  POST:    { bg: 'rgba(34,197,94,0.15)',   color: '#22c55e' },
  PUT:     { bg: 'rgba(249,115,22,0.15)',  color: '#f97316' },
  DELETE:  { bg: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
  PATCH:   { bg: 'rgba(80,227,194,0.12)',  color: '#50e3c2' },
  OPTIONS: { bg: 'rgba(107,114,128,0.15)', color: '#6b7280' },
  HEAD:    { bg: 'rgba(107,114,128,0.15)', color: '#6b7280' },
  CONNECT: { bg: 'rgba(156,163,175,0.12)', color: '#9ca3af' },
  WS:      { bg: 'rgba(128,90,213,0.15)',  color: '#805ad5' },
  GQL:     { bg: 'rgba(229,53,171,0.15)',  color: '#e535ab' },
  gRPC:    { bg: 'rgba(6,182,212,0.15)',   color: '#06b6d4' },
  PROTO:   { bg: 'rgba(6,182,212,0.15)',   color: '#06b6d4' },
  DNS:     { bg: 'rgba(14,165,233,0.15)',  color: '#0ea5e9' },
};

// ---------------------------------------------------------------------------
// Helpers for detecting entry types
// ---------------------------------------------------------------------------

function isGqlEntry(e: TrafficEntry): boolean {
  return !!detectGraphQL(e.requestMethod, e.requestUrl, e.requestBody);
}

function isProtoEntry(e: TrafficEntry): boolean {
  return !!detectProtobuf(e.requestHeaders, e.responseHeaders);
}

// ---------------------------------------------------------------------------
// Tri-state method filter definitions — shared by TrafficTable & TrafficInspector
// ---------------------------------------------------------------------------

export interface MethodFilterDef {
  key: string;
  label: string;
  color: string;
  match: (e: TrafficEntry) => boolean;
}

export const METHOD_FILTERS: MethodFilterDef[] = [
  { key: 'GET',      label: 'GET',      color: '#3b82f6', match: (e) => e.requestMethod === 'GET' && !isGqlEntry(e) && !isProtoEntry(e) },
  { key: 'POST',     label: 'POST',     color: '#22c55e', match: (e) => e.requestMethod === 'POST' && !isGqlEntry(e) && !isProtoEntry(e) },
  { key: 'PUT',      label: 'PUT',      color: '#f97316', match: (e) => e.requestMethod === 'PUT' && !isProtoEntry(e) },
  { key: 'DELETE',   label: 'DELETE',    color: '#ef4444', match: (e) => e.requestMethod === 'DELETE' && !isProtoEntry(e) },
  { key: 'GQL',      label: 'GQL',      color: '#e535ab', match: isGqlEntry },
  { key: 'PROTO',    label: 'PROTO',    color: '#06b6d4', match: isProtoEntry },
  { key: 'CONNECT',  label: 'CONNECT',  color: '#9ca3af', match: (e) => e.requestMethod === 'CONNECT' && (e.responseStatus !== 0 || e.pending === true) },
  { key: 'OPTIONS',  label: 'OPTIONS',  color: '#6b7280', match: (e) => e.requestMethod === 'OPTIONS' },
  { key: 'WS',       label: 'WS',       color: '#805ad5', match: (e) => e.type === 'websocket' },
  { key: 'DNS',      label: 'DNS',      color: '#0ea5e9', match: (e) => e.requestMethod === 'DNS' },
  { key: 'TLS_FAIL', label: 'TLS Fail', color: '#ef4444', match: (e) => e.requestMethod === 'CONNECT' && e.responseStatus === 0 && e.pending !== true },
];

/** Method filter keys that default to excluded (hidden from ALL view) */
export const DEFAULT_METHOD_EXCLUDES = ['DNS', 'CONNECT', 'TLS_FAIL'];

// ---------------------------------------------------------------------------
// Derives a display method label from a traffic entry
// ---------------------------------------------------------------------------

export function getMethodLabel(entry: Pick<TrafficEntry, 'requestMethod' | 'requestUrl' | 'requestBody' | 'requestHeaders' | 'responseHeaders' | 'type'>): string {
  if (entry.type === 'websocket') return 'WS';
  const gql = detectGraphQL(entry.requestMethod, entry.requestUrl, entry.requestBody);
  if (gql) return 'GQL';
  const proto = detectProtobuf(entry.requestHeaders, entry.responseHeaders);
  if (proto) return proto.isGrpc ? 'gRPC' : 'PROTO';
  return entry.requestMethod;
}

// ---------------------------------------------------------------------------
// Returns a human-readable content-type string for the Type column
// ---------------------------------------------------------------------------

export function getContentType(entry: Pick<TrafficEntry, 'type' | 'requestMethod' | 'requestUrl' | 'requestBody' | 'responseHeaders'>): string {
  if (entry.type === 'websocket') return 'websocket';
  const gql = detectGraphQL(entry.requestMethod, entry.requestUrl, entry.requestBody);
  if (gql) return 'graphql';
  if (!entry.responseHeaders) return 'fetch/xhr';
  try {
    const headers = JSON.parse(entry.responseHeaders);
    const ct: string = headers['content-type'] || headers['Content-Type'] || '';
    if (ct.includes('javascript')) return 'script';
    if (ct.includes('css')) return 'stylesheet';
    if (ct.includes('html')) return 'document';
    if (ct.includes('image/')) return 'image';
    if (ct.includes('font')) return 'font';
    if (ct.includes('json')) return 'json';
    if (ct.includes('xml')) return 'xml';
  } catch {}
  return 'fetch/xhr';
}

// ---------------------------------------------------------------------------
// Formats the response body size for the Size column
// ---------------------------------------------------------------------------

export function getResponseSize(responseBody: string | null | undefined): string {
  if (!responseBody) return '—';
  return formatBytes(getResponseSizeBytes(responseBody));
}

/**
 * Returns the raw byte count for a response body, used by the "> 100 KB" /
 * "has body" / "empty" quick filters. Mirrors the placeholder-parsing logic
 * in getResponseSize but returns a number instead of a formatted string.
 */
export function getResponseSizeBytes(responseBody: string | null | undefined): number {
  if (!responseBody) return 0;

  // Binary content is replaced by mitmproxy with "[binary image/jpeg, 12345 chars]"
  const binaryMatch = responseBody.match(/^\[binary .+?, (\d+) chars\]$/);
  if (binaryMatch) {
    return parseInt(binaryMatch[1], 10);
  }

  // Truncated text ends with "…[truncated, 12345 total]"
  const truncMatch = responseBody.match(/\[truncated, (\d+) total\]$/);
  if (truncMatch) {
    return parseInt(truncMatch[1], 10);
  }

  return new Blob([responseBody]).size;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Per-request duration formatting + colour (Duration column + waterfall)
// ---------------------------------------------------------------------------

/**
 * Format a request duration in ms compactly: `142ms`, `1.2s`, `12s`.
 * Null/undefined (no timing captured — DNS/synthetic/legacy rows) → `—`.
 */
export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs)) return '—';
  if (durationMs < 0) return '—';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const secs = durationMs / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  return `${Math.round(secs)}s`;
}

/**
 * Colour a duration like Charles/DevTools: slow requests stand out.
 * >3s red, >1s amber, otherwise a neutral readable colour. Returns undefined
 * for missing timing so the cell can render the em-dash in the muted default.
 */
export function getDurationColor(durationMs: number | null | undefined): string | undefined {
  if (durationMs == null || durationMs < 0) return undefined;
  if (durationMs > 3000) return '#fca5a5'; // red — matches status 5xx
  if (durationMs > 1000) return '#ffb95f'; // amber — matches status 3xx
  return '#8b95b0'; // neutral, readable on the dark theme
}

/**
 * Normalise a timings value (JSON string from REST, object from WS, or null)
 * into a TrafficTimings object, or null if there is no usable breakdown.
 */
export function normalizeTimings(
  timings: TrafficTimings | string | null | undefined,
): TrafficTimings | null {
  if (timings == null) return null;
  let obj: any = timings;
  if (typeof timings === 'string') {
    try { obj = JSON.parse(timings); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const result: TrafficTimings = {
    dns: num(obj.dns),
    connect: num(obj.connect),
    tls: num(obj.tls),
    ttfb: num(obj.ttfb),
    download: num(obj.download),
  };
  // Only meaningful if at least one segment is a real (>=0) number.
  const hasAny = Object.values(result).some((v) => v != null && v >= 0);
  return hasAny ? result : null;
}

/** Ordered segment metadata for the timing waterfall (label + colour). */
export const TIMING_SEGMENTS: Array<{ key: keyof TrafficTimings; label: string; color: string }> = [
  { key: 'dns',      label: 'DNS',      color: '#0ea5e9' },
  { key: 'connect',  label: 'Connect',  color: '#22c55e' },
  { key: 'tls',      label: 'TLS',      color: '#a855f7' },
  { key: 'ttfb',     label: 'Wait',     color: '#f59e0b' },
  { key: 'download', label: 'Download', color: '#3b82f6' },
];

// ---------------------------------------------------------------------------
// Returns a CSS colour string for a HTTP status code
// ---------------------------------------------------------------------------

export function getStatusColor(status: number | null | undefined): string {
  if (status == null) return '#5a6478';
  if (status === 0)   return '#fca5a5';
  if (status >= 500)  return '#fca5a5';
  if (status >= 400)  return '#f97316';
  if (status >= 300)  return '#ffb95f';
  if (status >= 200)  return '#4ade80';
  return '#5a6478';
}

// ---------------------------------------------------------------------------
// Filter types shared across consumers
// ---------------------------------------------------------------------------

export type MethodFilterState = 'include' | 'exclude';
export type StatusGroupFilter = '2xx' | '3xx' | '4xx' | '5xx';
export type SizeFilter = '' | 'gt100kb' | 'hasBody' | 'empty';

/** Response-size quick filters shown in the filter panel. */
export const SIZE_FILTERS: { key: SizeFilter; label: string }[] = [
  { key: '', label: 'Any' },
  { key: 'gt100kb', label: '> 100 KB' },
  { key: 'hasBody', label: 'Has body' },
  { key: 'empty', label: 'Empty' },
];

/**
 * Content-type category definitions, built on top of getContentType()'s
 * output. `match` takes the already-resolved content-type string (e.g.
 * 'json', 'document', 'websocket') and returns whether it belongs to the
 * category. 'other' is a catch-all for anything not otherwise categorised.
 */
export interface ContentTypeFilterDef {
  key: string;
  label: string;
  match: (contentType: string) => boolean;
}

const CATEGORISED_CONTENT_TYPES = new Set(['json', 'document', 'script', 'stylesheet', 'image', 'font', 'xml']);

export const CONTENT_TYPE_FILTERS: ContentTypeFilterDef[] = [
  { key: 'json',  label: 'JSON', match: ct => ct === 'json' },
  { key: 'html',  label: 'HTML', match: ct => ct === 'document' },
  { key: 'js',    label: 'JS',   match: ct => ct === 'script' },
  { key: 'css',   label: 'CSS',  match: ct => ct === 'stylesheet' },
  { key: 'image', label: 'Image', match: ct => ct === 'image' },
  { key: 'font',  label: 'Font', match: ct => ct === 'font' },
  { key: 'xml',   label: 'XML',  match: ct => ct === 'xml' },
  { key: 'other', label: 'Other', match: ct => !CATEGORISED_CONTENT_TYPES.has(ct) },
];

export interface TrafficFilters {
  /** Tri-state method filters. Keys match METHOD_FILTERS[].key. Missing = neutral. */
  methodFilters: Map<string, MethodFilterState>;
  /** Status-group pills. Multi-select (OR). Empty set = ALL. */
  status: Set<StatusGroupFilter>;
  /** Exact status codes (e.g. "404", "429"). Non-empty takes priority over `status`. */
  exactStatuses: Set<string>;
  /** Fast client-side host/URL regex filter (unchanged from the original filter bar). */
  text: string;
  /** "Search all" — matches URL + request/response body + headers. Sent to the
   * server as the `search` param by consumers that do server-side fetching;
   * also applied client-side as a fallback for consumers that don't. */
  search: string;
  /** Selected content-type category keys (CONTENT_TYPE_FILTERS[].key). Empty = all. */
  contentTypes: Set<string>;
  /** Response-size quick filter. '' = no filter. */
  size: SizeFilter;
}

export function createDefaultFilters(): TrafficFilters {
  return {
    methodFilters: new Map(DEFAULT_METHOD_EXCLUDES.map(k => [k, 'exclude' as MethodFilterState])),
    status: new Set(),
    exactStatuses: new Set(),
    text: '',
    search: '',
    contentTypes: new Set(),
    size: '',
  };
}

// ---------------------------------------------------------------------------
// Client-side filtering logic (used by TrafficTable and TrafficInspector)
// ---------------------------------------------------------------------------

export function applyClientFilters(entries: TrafficEntry[], filters: TrafficFilters): TrafficEntry[] {
  let result = entries;

  // Method filters — tri-state include/exclude
  if (filters.methodFilters.size > 0) {
    const includes = METHOD_FILTERS.filter(mf => filters.methodFilters.get(mf.key) === 'include');
    const excludes = METHOD_FILTERS.filter(mf => filters.methodFilters.get(mf.key) === 'exclude');

    if (includes.length > 0) {
      // If any are explicitly included, only show entries matching at least one include
      result = result.filter(e => includes.some(mf => mf.match(e)));
    }
    if (excludes.length > 0) {
      // Hide entries matching any exclude
      result = result.filter(e => !excludes.some(mf => mf.match(e)));
    }
  }

  // Status filter — exact codes take priority over the status-group pills
  // when any exact code is set; otherwise the group pills apply (multi-select OR).
  if (filters.exactStatuses.size > 0) {
    result = result.filter(e => e.responseStatus != null && filters.exactStatuses.has(String(e.responseStatus)));
  } else if (filters.status.size > 0) {
    result = result.filter(e => {
      if (e.responseStatus == null) return false;
      const century = `${Math.floor(e.responseStatus / 100)}xx` as StatusGroupFilter;
      return filters.status.has(century);
    });
  }

  // Content-type filter — OR across selected categories
  if (filters.contentTypes.size > 0) {
    result = result.filter(e => {
      const ct = getContentType(e);
      for (const key of filters.contentTypes) {
        const def = CONTENT_TYPE_FILTERS.find(d => d.key === key);
        if (def && def.match(ct)) return true;
      }
      return false;
    });
  }

  // Response-size quick filter
  if (filters.size) {
    result = result.filter(e => {
      const bytes = getResponseSizeBytes(e.responseBody);
      if (filters.size === 'gt100kb') return bytes > 100 * 1024;
      if (filters.size === 'hasBody') return bytes > 0;
      if (filters.size === 'empty') return bytes === 0;
      return true;
    });
  }

  // Text / regex filter on URL — the fast "Host / URL" filter
  if (filters.text) {
    try {
      const re = new RegExp(filters.text, 'i');
      result = result.filter(e => re.test(e.requestUrl));
    } catch {
      const lower = filters.text.toLowerCase();
      result = result.filter(e => e.requestUrl.toLowerCase().includes(lower));
    }
  }

  // "Search all" — client-side fallback for consumers that don't push
  // `search` down to the server (e.g. TrafficInspector, ApiExplorer).
  // Matches URL + request/response body + headers, case-insensitively.
  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter(e =>
      e.requestUrl.toLowerCase().includes(q) ||
      (e.requestBody ?? '').toLowerCase().includes(q) ||
      (e.responseBody ?? '').toLowerCase().includes(q) ||
      (e.requestHeaders ?? '').toLowerCase().includes(q) ||
      (e.responseHeaders ?? '').toLowerCase().includes(q)
    );
  }

  return result;
}

/**
 * Derives the `status` query param (a century string like '400') to send to
 * GET /v1/traffic/list from the current filters. The server only supports a
 * single century band per request (see backend/api/traffic.ts), so:
 *  - one or more exact status codes that all share a century: use it
 *  - exact codes spanning multiple centuries: no server-side narrowing
 *    (client-side filtering still applies to whatever page comes back)
 *  - otherwise, a single selected status-group pill maps directly
 *  - zero or 2+ status groups selected: no server-side narrowing
 */
export function deriveServerStatusCentury(filters: Pick<TrafficFilters, 'status' | 'exactStatuses'>): string {
  const centuryOf = (code: number) => `${Math.floor(code / 100)}00`;

  if (filters.exactStatuses.size > 0) {
    const codes = Array.from(filters.exactStatuses)
      .map(c => parseInt(c, 10))
      .filter(n => !isNaN(n));
    if (codes.length === 0) return '';
    const century = centuryOf(codes[0]);
    return codes.every(c => centuryOf(c) === century) ? century : '';
  }

  if (filters.status.size === 1) {
    const group = Array.from(filters.status)[0];
    const map: Record<StatusGroupFilter, string> = { '2xx': '200', '3xx': '300', '4xx': '400', '5xx': '500' };
    return map[group];
  }

  return '';
}

// ---------------------------------------------------------------------------
// Saved filter presets — persisted to localStorage, namespaced per-app.
// Maps/Sets don't survive JSON.stringify, so presets store plain
// arrays/tuples and get converted back to TrafficFilters on load.
// ---------------------------------------------------------------------------

export interface SerializedTrafficFilters {
  methodFilters: [string, MethodFilterState][];
  status: StatusGroupFilter[];
  exactStatuses: string[];
  text: string;
  search: string;
  contentTypes: string[];
  size: SizeFilter;
}

export interface FilterPreset {
  name: string;
  filters: SerializedTrafficFilters;
}

export function filtersToPreset(name: string, filters: TrafficFilters): FilterPreset {
  return {
    name,
    filters: {
      methodFilters: Array.from(filters.methodFilters.entries()),
      status: Array.from(filters.status),
      exactStatuses: Array.from(filters.exactStatuses),
      text: filters.text,
      search: filters.search,
      contentTypes: Array.from(filters.contentTypes),
      size: filters.size,
    },
  };
}

export function presetToFilters(preset: FilterPreset): TrafficFilters {
  return {
    methodFilters: new Map(preset.filters.methodFilters),
    status: new Set(preset.filters.status),
    exactStatuses: new Set(preset.filters.exactStatuses),
    text: preset.filters.text,
    search: preset.filters.search,
    contentTypes: new Set(preset.filters.contentTypes),
    size: preset.filters.size,
  };
}

const PRESETS_STORAGE_KEY = 'darkride:traffic-filters';

/** Loads saved presets from localStorage. Returns [] if none, or on corrupt data. */
export function loadFilterPresets(): FilterPreset[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Persists the full preset list to localStorage. */
export function saveFilterPresets(presets: FilterPreset[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* localStorage unavailable/full — presets simply won't persist */
  }
}

/** Built-in presets offered alongside any user-saved ones. Not persisted to localStorage. */
export const BUILTIN_PRESETS: FilterPreset[] = [
  {
    name: 'Errors only',
    filters: {
      methodFilters: DEFAULT_METHOD_EXCLUDES.map(k => [k, 'exclude' as MethodFilterState]),
      status: ['4xx', '5xx'],
      exactStatuses: [],
      text: '',
      search: '',
      contentTypes: [],
      size: '',
    },
  },
  {
    name: 'APIs only',
    filters: {
      methodFilters: DEFAULT_METHOD_EXCLUDES.map(k => [k, 'exclude' as MethodFilterState]),
      status: [],
      exactStatuses: [],
      text: '',
      search: '',
      contentTypes: ['json'],
      size: '',
    },
  },
];

// ---------------------------------------------------------------------------
// Shared helper functions (used by TrafficDetailPanel & TrafficEntryRow)
// ---------------------------------------------------------------------------

export function parseHeadersObject(headersJson: string | null): Record<string, string> {
  if (!headersJson) return {};
  try {
    const parsed = JSON.parse(headersJson);
    if (Array.isArray(parsed)) {
      // mitmproxy sometimes sends headers as [{name, value}, ...] array
      const result: Record<string, string> = {};
      for (const item of parsed) {
        if (item && typeof item === 'object' && typeof item.name === 'string') {
          const key = item.name;
          const val = typeof item.value === 'string' ? item.value : String(item.value ?? '');
          // Combine duplicate header names with comma (RFC 7230 §3.2.2)
          result[key] = result[key] ? `${result[key]}, ${val}` : val;
        }
      }
      return result;
    }
    if (typeof parsed === 'object' && parsed !== null) {
      // Ensure all values are strings (guard against nested objects)
      const result: Record<string, string> = {};
      for (const [key, val] of Object.entries(parsed)) {
        result[key] = typeof val === 'string' ? val : String(val ?? '');
      }
      return result;
    }
  } catch {}
  return {};
}

export function isBodyTruncated(body: string | null): boolean {
  if (!body) return false;
  return body.endsWith('\u2026[truncated]') || body.endsWith('...[truncated]');
}

export function generateCurl(entry: Pick<TrafficEntry, 'requestMethod' | 'requestUrl' | 'requestHeaders' | 'requestBody'>): string {
  const escapeSingleQuotes = (s: string) => s.replace(/'/g, "'\\''");
  const parts = [`curl -X ${entry.requestMethod} '${escapeSingleQuotes(entry.requestUrl)}'`];
  const headers = parseHeadersObject(entry.requestHeaders);
  for (const [key, val] of Object.entries(headers)) {
    parts.push(`-H '${key}: ${escapeSingleQuotes(val)}'`);
  }
  if (entry.requestBody) {
    parts.push(`-d '${escapeSingleQuotes(entry.requestBody)}'`);
  }
  return parts.join(' \\\n  ');
}

export function generateFetch(entry: Pick<TrafficEntry, 'requestMethod' | 'requestUrl' | 'requestHeaders' | 'requestBody'>): string {
  const headers = parseHeadersObject(entry.requestHeaders);
  const opts: string[] = [`  method: '${entry.requestMethod}'`];
  if (Object.keys(headers).length > 0) {
    opts.push(`  headers: ${JSON.stringify(headers, null, 4)}`);
  }
  if (entry.requestBody) {
    opts.push(`  body: ${JSON.stringify(entry.requestBody)}`);
  }
  return `fetch('${entry.requestUrl}', {\n${opts.join(',\n')}\n})`;
}

// ---------------------------------------------------------------------------
// Column visibility preferences
// ---------------------------------------------------------------------------

export type ColumnKey = 'method' | 'path' | 'status' | 'type' | 'size' | 'duration' | 'time';

export const COLUMNS: Array<{ key: ColumnKey; label: string; alwaysOn?: boolean }> = [
  { key: 'method', label: 'Method' },
  { key: 'path', label: 'Host / Path', alwaysOn: true },
  { key: 'status', label: 'Status' },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Size' },
  { key: 'duration', label: 'Duration' },
  { key: 'time', label: 'Time' },
];

const COLUMN_PREFS_KEY = 'darkride:traffic-columns';

/** Load the set of visible column keys. Defaults to all; always-on columns are
 *  force-included even if a saved set omits them. */
export function loadColumnPrefs(): Set<ColumnKey> {
  const all = new Set<ColumnKey>(COLUMNS.map(c => c.key));
  try {
    const raw = localStorage.getItem(COLUMN_PREFS_KEY);
    if (!raw) return all;
    const keys = JSON.parse(raw) as ColumnKey[];
    const set = new Set<ColumnKey>(keys.filter(k => COLUMNS.some(c => c.key === k)));
    COLUMNS.filter(c => c.alwaysOn).forEach(c => set.add(c.key));
    return set.size ? set : all;
  } catch {
    return all;
  }
}

/** Persist visible column keys (always-on columns are kept regardless). */
export function saveColumnPrefs(set: Set<ColumnKey>): void {
  const withAlways = new Set<ColumnKey>(set);
  COLUMNS.filter(c => c.alwaysOn).forEach(c => withAlways.add(c.key));
  try {
    localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify([...withAlways]));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}
