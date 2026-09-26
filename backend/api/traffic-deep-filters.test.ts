/**
 * Deep filters on GET /v1/traffic/list (method include/exclude, status
 * groups + exact codes, content type, response size, URL regex).
 *
 * The core check is parity: for every filter, the server must return exactly
 * the rows the shared classifier (shared/lib/traffic-classify.ts, which the
 * frontend also uses) says match. Before the stored-column design, the server
 * measured stored placeholder strings instead of original sizes, skipped
 * GraphQL detection, and loaded every row with full bodies into memory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerTrafficEndpoints, resetFilterRules, wsFlowMap } from './traffic';
import { importSessionHar } from '../services/session-import';
import { createTestDb } from '../test-utils/create-test-db';
import {
  classifyContent, compileUrlFilter, contentFilterMatches, matchesMethodFilter,
  responseSizeBytes, sizeFilterMatches, METHOD_FILTER_KEYS, CONTENT_FILTER_KEYS, type SizeFilter,
} from '../../shared/lib/traffic-classify';

vi.mock('../websocket/index', () => ({ broadcastToAll: vi.fn() }));

const { capturedTraffic } = schema;
type Db = BetterSQLite3Database<typeof schema>;

const gqlBody = JSON.stringify({ query: 'query Viewer { viewer { id } }' });

/** A corpus that exercises every classification edge the client handles. */
const CORPUS: Array<{ request: any; response?: any }> = [
  { request: { method: 'GET', url: 'https://api.example.com/v1/users' }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"users":[]}' } },
  { request: { method: 'POST', url: 'https://api.example.com/graphql', body: gqlBody }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"data":{}}' } },
  { request: { method: 'GET', url: 'https://cdn.example.com/hero.jpg' }, response: { status: 200, headers: { 'Content-Type': 'image/jpeg' }, body: '[binary image/jpeg, 512000 chars]' } },
  { request: { method: 'GET', url: 'https://api.example.com/v1/export' }, response: { status: 200, headers: { 'CONTENT-TYPE': 'Application/JSON' }, body: '{"rows":[…[truncated, 250000 total]' } },
  { request: { method: 'GET', url: 'https://api.example.com/v1/big-text' }, response: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(120 * 1024) } },
  { request: { method: 'GET', url: 'https://www.example.com/' }, response: { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html></html>' } },
  { request: { method: 'GET', url: 'https://www.example.com/app.js' }, response: { status: 304, headers: { 'content-type': 'application/javascript' }, body: null } },
  { request: { method: 'GET', url: 'https://www.example.com/site.css' }, response: { status: 200, headers: { 'content-type': 'text/css' }, body: 'body{}' } },
  { request: { method: 'GET', url: 'https://fonts.example.com/a.woff2' }, response: { status: 200, headers: { 'content-type': 'font/woff2' }, body: '[binary font/woff2, 20000 chars]' } },
  { request: { method: 'GET', url: 'https://api.example.com/feed.xml' }, response: { status: 500, headers: { 'content-type': 'application/xml' }, body: '<err/>' } },
  { request: { method: 'POST', url: 'https://api.example.com/v1/rpc', headers: { 'content-type': 'application/x-protobuf' }, body: 'bin' }, response: { status: 200, headers: { 'content-type': 'application/x-protobuf' }, body: '[binary application/x-protobuf, 900 chars]' } },
  { request: { method: 'PUT', url: 'https://api.example.com/v1/users/1', body: '{}' }, response: { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"nope"}' } },
  { request: { method: 'DELETE', url: 'https://api.example.com/v1/users/2' }, response: { status: 204, headers: {}, body: null } },
  { request: { method: 'OPTIONS', url: 'https://api.example.com/v1/users' }, response: { status: 204, headers: {}, body: null } },
  { request: { method: 'CONNECT', url: 'https://pinned.example.com:443' }, response: { status: 0 } },
  { request: { method: 'CONNECT', url: 'https://ok.example.com:443' }, response: { status: 200 } },
  { request: { method: 'DNS', url: 'dns://api.example.com' }, response: { status: 200 } },
  { request: { method: 'POST', url: 'https://api.example.com/v1/login', body: '{"u":"a"}' }, response: { status: 401, headers: { 'content-type': 'application/json' }, body: '{"e":"é😀"}' } },
  { request: { method: 'GET', url: 'https://api.example.com/v1/no-headers' } },
];

async function seed(app: express.Express): Promise<void> {
  for (const entry of CORPUS) {
    const res = await request(app).post('/v1/traffic/ingest').send(entry);
    expect(res.body, JSON.stringify(entry.request)).toMatchObject({ filtered: false });
  }
  await request(app).post('/v1/traffic/ws-start').send({ flowId: 'ws-1', url: 'wss://live.example.com/socket', headers: {} });
}

interface Filters {
  methodInclude?: string[];
  methodExclude?: string[];
  statusCodes?: number[];
  statusGroups?: string[];
  contentTypes?: string[];
  size?: SizeFilter;
  urlFilter?: string;
}

/** The oracle: what the shared classifier (and so the frontend) says matches. */
function oracle(row: any, f: Filters): boolean {
  if (f.methodInclude?.length && !f.methodInclude.some(k => matchesMethodFilter(row, k))) return false;
  if (f.methodExclude?.some(k => matchesMethodFilter(row, k))) return false;
  if (f.statusCodes?.length) {
    if (row.responseStatus == null || !f.statusCodes.includes(row.responseStatus)) return false;
  } else if (f.statusGroups?.length) {
    if (row.responseStatus == null || !f.statusGroups.includes(`${Math.floor(row.responseStatus / 100)}xx`)) return false;
  }
  if (f.contentTypes?.length) {
    const cat = classifyContent(row);
    if (!f.contentTypes.some(k => contentFilterMatches(k, cat))) return false;
  }
  if (f.size && !sizeFilterMatches(f.size, responseSizeBytes(row.responseBody))) return false;
  if (f.urlFilter && !compileUrlFilter(f.urlFilter)(row.requestUrl)) return false;
  return true;
}

function toQuery(f: Filters, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  if (f.methodInclude?.length) p.set('methodInclude', f.methodInclude.join(','));
  if (f.methodExclude?.length) p.set('methodExclude', f.methodExclude.join(','));
  if (f.statusCodes?.length) p.set('statusCodes', f.statusCodes.join(','));
  if (f.statusGroups?.length) p.set('statusGroups', f.statusGroups.join(','));
  if (f.contentTypes?.length) p.set('contentTypes', f.contentTypes.join(','));
  if (f.size) p.set('size', f.size);
  if (f.urlFilter) p.set('urlFilter', f.urlFilter);
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

const CASES: Array<[string, Filters]> = [
  ...METHOD_FILTER_KEYS.map((k): [string, Filters] => [`include ${k}`, { methodInclude: [k] }]),
  ...METHOD_FILTER_KEYS.map((k): [string, Filters] => [`exclude ${k}`, { methodExclude: [k] }]),
  ['default excludes (DNS, CONNECT, TLS_FAIL)', { methodExclude: ['DNS', 'CONNECT', 'TLS_FAIL'] }],
  ['include GET+GQL, exclude PROTO', { methodInclude: ['GET', 'GQL'], methodExclude: ['PROTO'] }],
  ['status 4xx', { statusGroups: ['4xx'] }],
  ['status 2xx+5xx', { statusGroups: ['2xx', '5xx'] }],
  ['exact 404,500 beats groups', { statusCodes: [404, 500], statusGroups: ['2xx'] }],
  ...[...CONTENT_FILTER_KEYS].map((k): [string, Filters] => [`content ${k}`, { contentTypes: [k] }]),
  ['content json+other', { contentTypes: ['json', 'other'] }],
  ['size > 100 KB', { size: 'gt100kb' }],
  ['size has body', { size: 'hasBody' }],
  ['size empty', { size: 'empty' }],
  ['url regex', { urlFilter: 'api\\.example\\.com/v1/users' }],
  ['url regex case-insensitive', { urlFilter: 'EXAMPLE\\.COM/V1' }],
  ['url invalid regex -> substring', { urlFilter: 'users(' }],
  ['url lookahead (RE2 rejects) -> substring', { urlFilter: '(?=users)' }],
  ['combined', { methodExclude: ['DNS', 'CONNECT', 'TLS_FAIL'], statusGroups: ['2xx'], contentTypes: ['json', 'image'], size: 'hasBody', urlFilter: 'example' }],
];

describe('GET /v1/traffic/list deep filters', () => {
  let db: Db;
  let app: express.Express;

  beforeEach(async () => {
    db = createTestDb();
    resetFilterRules();
    wsFlowMap.clear();
    clearEndpoints();
    registerTrafficEndpoints(db as any);
    app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use(getApiRouter());
    await seed(app);
  });

  it.each(CASES)('parity with the shared classifier: %s', async (_name, f) => {
    const all = db.select().from(capturedTraffic).all();
    const expected = all.filter(r => oracle(r, f)).map(r => r.id).sort((a, b) => a - b);

    const res = await request(app).get(`/v1/traffic/list?${toQuery(f, { limit: 1000 })}`);
    expect(res.status).toBe(200);
    const got = (res.body.data.items as any[]).map(r => r.id).sort((a, b) => a - b);
    expect(got).toEqual(expected);
    expect(res.body.data.total).toBe(expected.length);
  });

  it('counts a 500 KB binary image as > 100 KB (finding: stored placeholder is ~35 bytes)', async () => {
    const res = await request(app).get('/v1/traffic/list?size=gt100kb&limit=100');
    const urls = (res.body.data.items as any[]).map(r => r.requestUrl);
    expect(urls).toContain('https://cdn.example.com/hero.jpg');
    expect(urls).toContain('https://api.example.com/v1/export');
    expect(urls).not.toContain('https://www.example.com/site.css');
  });

  it('puts GraphQL under "other", not "json"', async () => {
    const json = await request(app).get('/v1/traffic/list?contentTypes=json&limit=100');
    const other = await request(app).get('/v1/traffic/list?contentTypes=other&limit=100');
    expect((json.body.data.items as any[]).map(r => r.requestUrl)).not.toContain('https://api.example.com/graphql');
    expect((other.body.data.items as any[]).map(r => r.requestUrl)).toContain('https://api.example.com/graphql');
  });

  it('paginates filtered results in SQL with an exact total', async () => {
    const f: Filters = { methodExclude: ['DNS', 'CONNECT', 'TLS_FAIL'], size: 'hasBody' };
    const expected = db.select().from(capturedTraffic).all().filter(r => oracle(r, f)).length;
    const seen = new Set<number>();
    for (let offset = 0; offset < expected + 2; offset += 2) {
      const res = await request(app).get(`/v1/traffic/list?${toQuery(f, { limit: 2, offset })}`);
      expect(res.body.data.total).toBe(expected);
      expect(res.body.data.items.length).toBeLessThanOrEqual(2);
      for (const r of res.body.data.items) seen.add(r.id);
    }
    expect(seen.size).toBe(expected);
  });

  it('never loads the table without a LIMIT for deep filters', async () => {
    const client = (db as any).$client;
    const prepare = vi.spyOn(client, 'prepare');
    await request(app).get(`/v1/traffic/list?${toQuery(CASES[CASES.length - 1][1], { limit: 5 })}`);
    const selects = prepare.mock.calls
      .map(([s]) => String(s).toLowerCase())
      .filter(s => s.includes('from "captured_traffic"') && !s.includes('count('));
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).toMatch(/\blimit\b/);
    prepare.mockRestore();
  });

  it('a catastrophic-backtracking URL pattern returns quickly', async () => {
    const start = Date.now();
    const res = await request(app).get(`/v1/traffic/list?urlFilter=${encodeURIComponent('^(a|aa)+$')}&limit=10`);
    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('ignores unknown filter keys instead of matching nothing', async () => {
    const total = db.select().from(capturedTraffic).all().length;
    const res = await request(app).get('/v1/traffic/list?methodInclude=BOGUS&contentTypes=nope&size=huge&statusGroups=9xx&limit=1000');
    expect(res.body.data.total).toBe(total);
  });
});

describe('stored filter columns', () => {
  let db: Db;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    resetFilterRules();
    wsFlowMap.clear();
    clearEndpoints();
    registerTrafficEndpoints(db as any);
    app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use(getApiRouter());
  });

  it('ingest writes category, original size and GQL/proto flags', async () => {
    await request(app).post('/v1/traffic/ingest').send(CORPUS[1]);
    await request(app).post('/v1/traffic/ingest').send(CORPUS[2]);
    const [gql, img] = db.select().from(capturedTraffic).all();
    expect(gql).toMatchObject({ responseCategory: 'graphql', isGraphql: true, isProtobuf: false });
    expect(img).toMatchObject({ responseCategory: 'image', responseSizeBytes: 512000 });
  });

  it('ws-start writes the websocket category', async () => {
    await request(app).post('/v1/traffic/ws-start').send({ flowId: 'f', url: 'wss://x/ws', headers: {} });
    expect(db.select().from(capturedTraffic).all()[0]).toMatchObject({ responseCategory: 'websocket', responseSizeBytes: 0 });
  });

  it('HAR import writes the columns', () => {
    importSessionHar(db as any, { log: { entries: [{
      startedDateTime: new Date().toISOString(),
      request: { method: 'GET', url: 'https://x/a.png', headers: [] },
      response: { status: 200, headers: [{ name: 'Content-Type', value: 'image/png' }], content: { text: '[binary image/png, 4096 chars]' } },
    }] } }, 'har');
    expect(db.select().from(capturedTraffic).all()[0]).toMatchObject({ responseCategory: 'image', responseSizeBytes: 4096, isGraphql: false });
  });
});
