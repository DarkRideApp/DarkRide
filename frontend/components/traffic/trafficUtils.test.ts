import { describe, it, expect, beforeEach } from 'vitest';
import type { TrafficEntry } from './TrafficEntryRow';
import {
  createDefaultFilters,
  applyClientFilters,
  getResponseSizeBytes,
  CONTENT_TYPE_FILTERS,
  filtersToPreset,
  presetToFilters,
  loadFilterPresets,
  saveFilterPresets,
  BUILTIN_PRESETS,
  COLUMNS,
  loadColumnPrefs,
  saveColumnPrefs,
  trafficFiltersToListParams,
  isDefaultTrafficFilters,
  getContentType,
  type TrafficFilters,
} from './trafficUtils';

const makeEntry = (overrides: Partial<TrafficEntry> = {}): TrafficEntry => ({
  id: 1,
  sessionId: null,
  deviceId: null,
  requestMethod: 'GET',
  requestUrl: 'https://example.com/api',
  requestHeaders: null,
  requestBody: null,
  responseStatus: 200,
  responseHeaders: null,
  responseBody: null,
  capturedAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

// Filters with all default excludes removed so DNS/CONNECT/TLS_FAIL don't
// interfere with entries that use CONNECT/DNS in these tests.
function bareFilters(): TrafficFilters {
  const f = createDefaultFilters();
  f.methodFilters.clear();
  return f;
}

describe('getResponseSizeBytes', () => {
  it('returns 0 for null/undefined/empty body', () => {
    expect(getResponseSizeBytes(null)).toBe(0);
    expect(getResponseSizeBytes(undefined)).toBe(0);
    expect(getResponseSizeBytes('')).toBe(0);
  });

  it('parses the byte count out of a binary placeholder', () => {
    expect(getResponseSizeBytes('[binary image/jpeg, 12345 chars]')).toBe(12345);
  });

  it('parses the byte count out of a truncated placeholder', () => {
    expect(getResponseSizeBytes('some text…[truncated, 99999 total]')).toBe(99999);
  });

  it('falls back to the UTF-8 byte length of plain text', () => {
    expect(getResponseSizeBytes('hello')).toBe(5);
  });
});

describe('CONTENT_TYPE_FILTERS', () => {
  it('classifies known content types into their own bucket and everything else as other', () => {
    const buckets = CONTENT_TYPE_FILTERS.map(d => d.key);
    expect(buckets).toEqual(['json', 'html', 'js', 'css', 'image', 'font', 'xml', 'other']);

    const other = CONTENT_TYPE_FILTERS.find(d => d.key === 'other')!;
    expect(other.match('json')).toBe(false);
    expect(other.match('fetch/xhr')).toBe(true);
    expect(other.match('websocket')).toBe(true);
  });
});

describe('applyClientFilters — content type', () => {
  it('narrows rows to the selected content-type buckets', () => {
    const jsonEntry = makeEntry({ id: 1, responseHeaders: JSON.stringify({ 'content-type': 'application/json' }) });
    const htmlEntry = makeEntry({ id: 2, responseHeaders: JSON.stringify({ 'content-type': 'text/html' }) });
    const imgEntry = makeEntry({ id: 3, responseHeaders: JSON.stringify({ 'content-type': 'image/png' }) });

    const filters = bareFilters();
    filters.contentTypes = new Set(['json']);

    const result = applyClientFilters([jsonEntry, htmlEntry, imgEntry], filters);
    expect(result.map(e => e.id)).toEqual([1]);
  });

  it('supports multiple selected buckets (OR)', () => {
    const jsonEntry = makeEntry({ id: 1, responseHeaders: JSON.stringify({ 'content-type': 'application/json' }) });
    const htmlEntry = makeEntry({ id: 2, responseHeaders: JSON.stringify({ 'content-type': 'text/html' }) });
    const imgEntry = makeEntry({ id: 3, responseHeaders: JSON.stringify({ 'content-type': 'image/png' }) });

    const filters = bareFilters();
    filters.contentTypes = new Set(['json', 'image']);

    const result = applyClientFilters([jsonEntry, htmlEntry, imgEntry], filters);
    expect(result.map(e => e.id).sort()).toEqual([1, 3]);
  });
});

describe('applyClientFilters — size', () => {
  it('filters to responses larger than 100KB', () => {
    const big = makeEntry({ id: 1, responseBody: '[binary image/jpeg, 200000 chars]' });
    const small = makeEntry({ id: 2, responseBody: 'ok' });

    const filters = bareFilters();
    filters.size = 'gt100kb';

    const result = applyClientFilters([big, small], filters);
    expect(result.map(e => e.id)).toEqual([1]);
  });

  it('filters to entries that have a body', () => {
    const withBody = makeEntry({ id: 1, responseBody: 'hello' });
    const noBody = makeEntry({ id: 2, responseBody: null });

    const filters = bareFilters();
    filters.size = 'hasBody';

    const result = applyClientFilters([withBody, noBody], filters);
    expect(result.map(e => e.id)).toEqual([1]);
  });

  it('filters to entries with an empty body', () => {
    const withBody = makeEntry({ id: 1, responseBody: 'hello' });
    const noBody = makeEntry({ id: 2, responseBody: null });

    const filters = bareFilters();
    filters.size = 'empty';

    const result = applyClientFilters([withBody, noBody], filters);
    expect(result.map(e => e.id)).toEqual([2]);
  });
});

describe('applyClientFilters — exact status', () => {
  it('filters to exact status codes, taking priority over the status group', () => {
    const e404 = makeEntry({ id: 1, responseStatus: 404 });
    const e429 = makeEntry({ id: 2, responseStatus: 429 });
    const e200 = makeEntry({ id: 3, responseStatus: 200 });

    const filters = bareFilters();
    filters.status = new Set(['2xx']); // would normally only match e200
    filters.exactStatuses = new Set(['404', '429']);

    const result = applyClientFilters([e404, e429, e200], filters);
    expect(result.map(e => e.id).sort()).toEqual([1, 2]);
  });
});

describe('applyClientFilters — status group (multi-select)', () => {
  it('matches any selected century band', () => {
    const e404 = makeEntry({ id: 1, responseStatus: 404 });
    const e500 = makeEntry({ id: 2, responseStatus: 500 });
    const e200 = makeEntry({ id: 3, responseStatus: 200 });

    const filters = bareFilters();
    filters.status = new Set(['4xx', '5xx']);

    const result = applyClientFilters([e404, e500, e200], filters);
    expect(result.map(e => e.id).sort()).toEqual([1, 2]);
  });
});

describe('applyClientFilters — search (client fallback)', () => {
  it('matches url, body, and header content case-insensitively', () => {
    const byUrl = makeEntry({ id: 1, requestUrl: 'https://example.com/secret-token' });
    const byBody = makeEntry({ id: 2, requestBody: 'contains SECRET-TOKEN here' });
    const byHeader = makeEntry({ id: 3, requestHeaders: JSON.stringify({ 'x-token': 'secret-token' }) });
    const noMatch = makeEntry({ id: 4 });

    const filters = bareFilters();
    filters.search = 'secret-token';

    const result = applyClientFilters([byUrl, byBody, byHeader, noMatch], filters);
    expect(result.map(e => e.id).sort()).toEqual([1, 2, 3]);
  });
});

describe('trafficFiltersToListParams', () => {
  const params = (f: ReturnType<typeof createDefaultFilters>) => Object.fromEntries(trafficFiltersToListParams(f));

  it('default filters send only the default method excludes', () => {
    expect(params(createDefaultFilters())).toEqual({ methodExclude: 'DNS,CONNECT,TLS_FAIL' });
  });

  it('maps every deep filter to its server param', () => {
    const f = createDefaultFilters();
    f.methodFilters = new Map([['GQL', 'include'], ['GET', 'include'], ['DNS', 'exclude']]);
    f.status = new Set(['4xx', '5xx']);
    f.contentTypes = new Set(['json', 'other']);
    f.size = 'gt100kb';
    f.text = 'api\\.example';
    f.search = 'token';
    expect(params(f)).toEqual({
      methodInclude: 'GQL,GET',
      methodExclude: 'DNS',
      statusGroups: '4xx,5xx',
      contentTypes: 'json,other',
      size: 'gt100kb',
      urlFilter: 'api\\.example',
      search: 'token',
    });
  });

  it('exact status codes are sent instead of the group pills', () => {
    const f = createDefaultFilters();
    f.status = new Set(['2xx']);
    f.exactStatuses = new Set(['404', '429']);
    const p = params(f);
    expect(p.statusCodes).toBe('404,429');
    expect(p.statusGroups).toBeUndefined();
  });
});

describe('isDefaultTrafficFilters', () => {
  it('is true only for the untouched default', () => {
    expect(isDefaultTrafficFilters(createDefaultFilters())).toBe(true);
    const groups = createDefaultFilters();
    groups.status = new Set(['4xx']);
    expect(isDefaultTrafficFilters(groups)).toBe(false);
    const noExcludes = createDefaultFilters();
    noExcludes.methodFilters = new Map();
    expect(isDefaultTrafficFilters(noExcludes)).toBe(false);
  });
});

describe('client/server classification parity', () => {
  it('uses the shared classifier: GraphQL is graphql, header case is ignored', () => {
    const gql = { type: 'http', requestMethod: 'POST', requestUrl: 'https://x/graphql', requestBody: JSON.stringify({ query: 'query A { a }' }), responseHeaders: JSON.stringify({ 'content-type': 'application/json' }) };
    expect(getContentType(gql as any)).toBe('graphql');
    expect(getContentType({ type: 'http', requestMethod: 'GET', requestUrl: 'https://x', requestBody: null, responseHeaders: JSON.stringify({ 'CONTENT-TYPE': 'Application/JSON' }) } as any)).toBe('json');
  });

  it('counts UTF-8 bytes', () => {
    expect(getResponseSizeBytes('é')).toBe(2);
  });
});

describe('filter presets', () => {
  const STORAGE_KEY = 'darkride:traffic-filters';

  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a TrafficFilters object through serialize/deserialize', () => {
    const original = createDefaultFilters();
    original.status = new Set(['4xx', '5xx']);
    original.exactStatuses = new Set(['404']);
    original.contentTypes = new Set(['json']);
    original.size = 'gt100kb';
    original.text = 'api.example.com';
    original.search = 'token';

    const preset = filtersToPreset('My preset', original);
    const restored = presetToFilters(preset);

    expect(restored.status).toEqual(original.status);
    expect(restored.exactStatuses).toEqual(original.exactStatuses);
    expect(restored.contentTypes).toEqual(original.contentTypes);
    expect(restored.size).toBe(original.size);
    expect(restored.text).toBe(original.text);
    expect(restored.search).toBe(original.search);
    expect(Array.from(restored.methodFilters.entries())).toEqual(Array.from(original.methodFilters.entries()));
  });

  it('persists presets to localStorage under the namespaced key and reloads them', () => {
    const preset = filtersToPreset('Saved one', createDefaultFilters());
    saveFilterPresets([preset]);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual([preset]);

    const loaded = loadFilterPresets();
    expect(loaded).toEqual([preset]);
  });

  it('returns an empty array when nothing has been saved yet', () => {
    expect(loadFilterPresets()).toEqual([]);
  });

  it('ignores corrupt localStorage content instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json{{{');
    expect(loadFilterPresets()).toEqual([]);
  });

  it('ships built-in presets for Errors only and APIs only', () => {
    const names = BUILTIN_PRESETS.map(p => p.name);
    expect(names).toContain('Errors only');
    expect(names).toContain('APIs only');

    const errors = BUILTIN_PRESETS.find(p => p.name === 'Errors only')!;
    expect(new Set(errors.filters.status)).toEqual(new Set(['4xx', '5xx']));

    const apis = BUILTIN_PRESETS.find(p => p.name === 'APIs only')!;
    expect(apis.filters.contentTypes).toEqual(['json']);
  });
});

describe('column prefs', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to all columns visible', () => {
    expect(loadColumnPrefs().size).toBe(COLUMNS.length);
  });

  it('round-trips a saved set, always keeping the always-on column', () => {
    saveColumnPrefs(new Set(['path', 'status']));
    const got = loadColumnPrefs();
    expect(got.has('status')).toBe(true);
    expect(got.has('size')).toBe(false);
    expect(got.has('path')).toBe(true); // always-on
  });

  it('re-adds the always-on column even if a saved set omits it', () => {
    localStorage.setItem('darkride:traffic-columns', JSON.stringify(['status']));
    expect(loadColumnPrefs().has('path')).toBe(true);
  });
});
