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

  // Binary content is replaced by mitmproxy with "[binary image/jpeg, 12345 chars]"
  const binaryMatch = responseBody.match(/^\[binary .+?, (\d+) chars\]$/);
  if (binaryMatch) {
    return formatBytes(parseInt(binaryMatch[1], 10));
  }

  // Truncated text ends with "…[truncated, 12345 total]"
  const truncMatch = responseBody.match(/\[truncated, (\d+) total\]$/);
  if (truncMatch) {
    return formatBytes(parseInt(truncMatch[1], 10));
  }

  return formatBytes(new Blob([responseBody]).size);
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
export type StatusGroupFilter = '' | '2xx' | '3xx' | '4xx' | '5xx';

export interface TrafficFilters {
  /** Tri-state method filters. Keys match METHOD_FILTERS[].key. Missing = neutral. */
  methodFilters: Map<string, MethodFilterState>;
  status: StatusGroupFilter;
  text: string;
}

export function createDefaultFilters(): TrafficFilters {
  return {
    methodFilters: new Map(DEFAULT_METHOD_EXCLUDES.map(k => [k, 'exclude' as MethodFilterState])),
    status: '',
    text: '',
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

  // Status group filter
  if (filters.status) {
    const century = parseInt(filters.status[0], 10);
    result = result.filter(e => {
      if (e.responseStatus == null) return false;
      return Math.floor(e.responseStatus / 100) === century;
    });
  }

  // Text / regex filter on URL
  if (filters.text) {
    try {
      const re = new RegExp(filters.text, 'i');
      result = result.filter(e => re.test(e.requestUrl));
    } catch {
      const lower = filters.text.toLowerCase();
      result = result.filter(e => e.requestUrl.toLowerCase().includes(lower));
    }
  }

  return result;
}

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
