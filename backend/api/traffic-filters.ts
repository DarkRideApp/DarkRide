import { and, eq, gte, inArray, isNotNull, lt, not, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../db';
import { capturedTraffic } from '../db/schema';
import {
  CATEGORISED_CONTENT_TYPES,
  CONTENT_FILTER_CATEGORY,
  CONTENT_FILTER_KEYS,
  METHOD_FILTER_KEYS,
  SIZE_FILTER_KEYS,
  LARGE_RESPONSE_BYTES,
  compileUrlFilter,
  type SizeFilter,
} from '../../shared/lib/traffic-classify';

/**
 * Deep filters for GET /v1/traffic/list, translated to SQL over the stored
 * classification columns (migration 0099). The semantics mirror
 * shared/lib/traffic-classify.ts, which the frontend applies to live rows;
 * backend/api/traffic-deep-filters.test.ts checks the two agree row for row.
 */
export interface DeepTrafficFilters {
  methodInclude: string[];
  methodExclude: string[];
  statusCodes: number[];
  statusGroups: string[];
  contentTypes: string[];
  size: SizeFilter;
  urlFilter: string;
}

const STATUS_GROUP_KEYS = new Set(['1xx', '2xx', '3xx', '4xx', '5xx']);
const METHOD_KEYS: ReadonlySet<string> = new Set(METHOD_FILTER_KEYS);

function csv(value: unknown, allowed?: ReadonlySet<string>): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const parts = value.split(',').map(v => v.trim()).filter(v => v && (!allowed || allowed.has(v)));
  return Array.from(new Set(parts));
}

/** Parse the query string. Unknown keys are dropped so they never match "nothing". */
export function parseDeepFilters(query: Record<string, unknown>): DeepTrafficFilters {
  const size = typeof query.size === 'string' && SIZE_FILTER_KEYS.has(query.size) ? query.size as SizeFilter : '';
  return {
    methodInclude: csv(query.methodInclude, METHOD_KEYS),
    methodExclude: csv(query.methodExclude, METHOD_KEYS),
    statusCodes: csv(query.statusCodes)
      .map(Number)
      .filter(n => Number.isInteger(n) && n >= 0 && n <= 999),
    statusGroups: csv(query.statusGroups, STATUS_GROUP_KEYS),
    contentTypes: csv(query.contentTypes, CONTENT_FILTER_KEYS),
    size,
    urlFilter: typeof query.urlFilter === 'string' ? query.urlFilter : '',
  };
}

const t = capturedTraffic;
const notGraphql = sql`coalesce(${t.isGraphql}, 0) = 0`;
const notProtobuf = sql`coalesce(${t.isProtobuf}, 0) = 0`;

/**
 * SQL for one method pill. Mirrors matchesMethodFilter() for stored rows
 * (never pending). Every branch is NULL-safe so NOT(...) for an exclude keeps
 * rows whose flags are still NULL (pre-backfill) instead of dropping them.
 */
function methodCondition(key: string): SQL {
  switch (key) {
    case 'GET': return and(eq(t.requestMethod, 'GET'), notGraphql, notProtobuf)!;
    case 'POST': return and(eq(t.requestMethod, 'POST'), notGraphql, notProtobuf)!;
    case 'PUT': return and(eq(t.requestMethod, 'PUT'), notProtobuf)!;
    case 'DELETE': return and(eq(t.requestMethod, 'DELETE'), notProtobuf)!;
    case 'GQL': return sql`coalesce(${t.isGraphql}, 0) = 1`;
    case 'PROTO': return sql`coalesce(${t.isProtobuf}, 0) = 1`;
    // NULL status counts as "not 0", matching the client's `!== 0`.
    case 'CONNECT': return and(eq(t.requestMethod, 'CONNECT'), sql`${t.responseStatus} IS NOT 0`)!;
    case 'OPTIONS': return eq(t.requestMethod, 'OPTIONS');
    case 'WS': return sql`${t.type} IS 'websocket'`;
    case 'DNS': return eq(t.requestMethod, 'DNS');
    case 'TLS_FAIL': return and(eq(t.requestMethod, 'CONNECT'), sql`${t.responseStatus} IS 0`)!;
    default: throw new Error(`unknown method filter ${key}`);
  }
}

const URL_MATCH_FN = 'darkride_url_match';
const registered = new WeakSet<object>();
const matcherCache = new Map<string, (url: string) => boolean>();

/**
 * Register the URL-filter SQL function on this connection. It runs the shared
 * RE2 matcher, so matching is linear time and identical to the frontend.
 */
function ensureUrlMatchFunction(db: AppDatabase): void {
  const client = (db as unknown as { $client: { function: Function } }).$client;
  if (registered.has(client)) return;
  client.function(URL_MATCH_FN, { deterministic: true }, (pattern: string, url: string | null) => {
    if (url == null) return 0;
    let match = matcherCache.get(pattern);
    if (!match) {
      if (matcherCache.size >= 32) matcherCache.clear();
      match = compileUrlFilter(pattern);
      matcherCache.set(pattern, match);
    }
    return match(url) ? 1 : 0;
  });
  registered.add(client);
}

export function deepFilterConditions(db: AppDatabase, f: DeepTrafficFilters): SQL[] {
  const conditions: SQL[] = [];

  if (f.methodInclude.length > 0) conditions.push(or(...f.methodInclude.map(methodCondition))!);
  for (const key of f.methodExclude) conditions.push(not(methodCondition(key)));

  // Exact codes take priority over the group pills, as on the client.
  if (f.statusCodes.length > 0) {
    conditions.push(inArray(t.responseStatus, f.statusCodes));
  } else if (f.statusGroups.length > 0) {
    conditions.push(or(...f.statusGroups.map(g => {
      const century = parseInt(g, 10);
      return and(gte(t.responseStatus, century * 100), lt(t.responseStatus, (century + 1) * 100))!;
    }))!);
  }

  if (f.contentTypes.length > 0) {
    const categories = f.contentTypes.filter(k => k !== 'other').map(k => CONTENT_FILTER_CATEGORY[k]);
    const parts: SQL[] = [];
    if (categories.length > 0) parts.push(inArray(t.responseCategory, categories));
    if (f.contentTypes.includes('other')) {
      parts.push(and(isNotNull(t.responseCategory), notInArray(t.responseCategory, [...CATEGORISED_CONTENT_TYPES]))!);
    }
    conditions.push(parts.length === 1 ? parts[0] : or(...parts)!);
  }

  if (f.size === 'gt100kb') conditions.push(sql`${t.responseSizeBytes} > ${LARGE_RESPONSE_BYTES}`);
  else if (f.size === 'hasBody') conditions.push(sql`${t.responseSizeBytes} > 0`);
  else if (f.size === 'empty') conditions.push(eq(t.responseSizeBytes, 0));

  if (f.urlFilter) {
    ensureUrlMatchFunction(db);
    conditions.push(sql`${sql.raw(URL_MATCH_FN)}(${f.urlFilter}, ${t.requestUrl}) = 1`);
  }

  return conditions;
}
