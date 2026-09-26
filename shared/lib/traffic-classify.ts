/**
 * Traffic classification — the single definition of the Traffic table's deep
 * filters, shared by the frontend (live rows, Type/Size columns) and the
 * backend (stored filter columns + GET /v1/traffic/list). Keeping one copy is
 * what guarantees a filter returns the same rows server-side as it shows
 * client-side.
 */
import { RE2JS } from 're2js';
import { detectGraphQL } from './graphql-detect';
import { detectProtobuf } from './protobuf-detect';

/** Category shown in the Type column and stored in captured_traffic.response_category. */
export type ContentCategory =
  | 'websocket' | 'graphql' | 'script' | 'stylesheet' | 'document'
  | 'image' | 'font' | 'json' | 'xml' | 'fetch/xhr';

export interface ClassifiableEntry {
  type?: string | null;
  requestMethod: string;
  requestUrl: string;
  requestBody?: string | null;
  responseHeaders?: string | null;
}

function responseContentTypeHeader(responseHeaders: string | null | undefined): string {
  if (!responseHeaders) return '';
  try {
    const parsed = JSON.parse(responseHeaders);
    if (typeof parsed !== 'object' || parsed === null) return '';
    for (const [key, value] of Object.entries(parsed)) {
      if (key.toLowerCase() === 'content-type') return String(value).toLowerCase();
    }
  } catch { /* malformed headers classify as fetch/xhr */ }
  return '';
}

export function classifyContent(entry: ClassifiableEntry): ContentCategory {
  if (entry.type === 'websocket') return 'websocket';
  if (detectGraphQL(entry.requestMethod, entry.requestUrl, entry.requestBody ?? null)) return 'graphql';
  const ct = responseContentTypeHeader(entry.responseHeaders);
  if (ct.includes('javascript')) return 'script';
  if (ct.includes('css')) return 'stylesheet';
  if (ct.includes('html')) return 'document';
  if (ct.includes('image/')) return 'image';
  if (ct.includes('font')) return 'font';
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  return 'fetch/xhr';
}

/** Content-type filter pill key -> the category it selects. "other" is everything else. */
export const CONTENT_FILTER_CATEGORY: Record<string, ContentCategory> = {
  json: 'json',
  html: 'document',
  js: 'script',
  css: 'stylesheet',
  image: 'image',
  font: 'font',
  xml: 'xml',
};
export const CATEGORISED_CONTENT_TYPES: ReadonlySet<string> = new Set(Object.values(CONTENT_FILTER_CATEGORY));
export const CONTENT_FILTER_KEYS: ReadonlySet<string> = new Set([...Object.keys(CONTENT_FILTER_CATEGORY), 'other']);

export function contentFilterMatches(key: string, category: string): boolean {
  if (key === 'other') return !CATEGORISED_CONTENT_TYPES.has(category);
  return CONTENT_FILTER_CATEGORY[key] === category;
}

const BINARY_PLACEHOLDER = /^\[binary .+?, (\d+) chars\]$/;
const TRUNCATION_MARKER = /\[truncated, (\d+) total\]$/;
const utf8 = new TextEncoder();

/**
 * Original response size in bytes. Capture stores binary bodies as
 * "[binary image/jpeg, 12345 chars]" and long text with a
 * "…[truncated, 12345 total]" suffix, so the stored string length is not the
 * response size.
 */
export function responseSizeBytes(responseBody: string | null | undefined): number {
  if (!responseBody) return 0;
  const binary = responseBody.match(BINARY_PLACEHOLDER);
  if (binary) return parseInt(binary[1], 10);
  const truncated = responseBody.match(TRUNCATION_MARKER);
  if (truncated) return parseInt(truncated[1], 10);
  return utf8.encode(responseBody).length;
}

export type SizeFilter = '' | 'gt100kb' | 'hasBody' | 'empty';
export const SIZE_FILTER_KEYS: ReadonlySet<string> = new Set(['gt100kb', 'hasBody', 'empty']);
export const LARGE_RESPONSE_BYTES = 100 * 1024;

export function sizeFilterMatches(size: SizeFilter, bytes: number): boolean {
  if (size === 'gt100kb') return bytes > LARGE_RESPONSE_BYTES;
  if (size === 'hasBody') return bytes > 0;
  if (size === 'empty') return bytes === 0;
  return true;
}

/**
 * The "Host / URL" filter: a case-insensitive regex, or a case-insensitive
 * substring when the pattern does not compile. RE2 semantics (linear time)
 * so a pathological pattern cannot stall the server's event loop; patterns
 * RE2 rejects (lookaround, backreferences) fall back to substring on both
 * sides alike.
 */
export function compileUrlFilter(pattern: string): (url: string) => boolean {
  try {
    const re = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
    return (url) => re.matcher(url).find();
  } catch {
    const lower = pattern.toLowerCase();
    return (url) => url.toLowerCase().includes(lower);
  }
}

export const METHOD_FILTER_KEYS = ['GET', 'POST', 'PUT', 'DELETE', 'GQL', 'PROTO', 'CONNECT', 'OPTIONS', 'WS', 'DNS', 'TLS_FAIL'] as const;
export type MethodFilterKey = typeof METHOD_FILTER_KEYS[number];

export interface MethodMatchable extends ClassifiableEntry {
  requestHeaders?: string | null;
  responseStatus?: number | null;
  /** Live rows still waiting on a response. Never true for stored rows. */
  pending?: boolean;
}

export function isGraphqlEntry(e: MethodMatchable): boolean {
  return !!detectGraphQL(e.requestMethod, e.requestUrl, e.requestBody ?? null);
}

export function isProtobufEntry(e: MethodMatchable): boolean {
  return !!detectProtobuf(e.requestHeaders ?? null, e.responseHeaders ?? null);
}

export function matchesMethodFilter(e: MethodMatchable, key: string): boolean {
  switch (key) {
    case 'GET': return e.requestMethod === 'GET' && !isGraphqlEntry(e) && !isProtobufEntry(e);
    case 'POST': return e.requestMethod === 'POST' && !isGraphqlEntry(e) && !isProtobufEntry(e);
    case 'PUT': return e.requestMethod === 'PUT' && !isProtobufEntry(e);
    case 'DELETE': return e.requestMethod === 'DELETE' && !isProtobufEntry(e);
    case 'GQL': return isGraphqlEntry(e);
    case 'PROTO': return isProtobufEntry(e);
    case 'CONNECT': return e.requestMethod === 'CONNECT' && (e.responseStatus !== 0 || e.pending === true);
    case 'OPTIONS': return e.requestMethod === 'OPTIONS';
    case 'WS': return e.type === 'websocket';
    case 'DNS': return e.requestMethod === 'DNS';
    case 'TLS_FAIL': return e.requestMethod === 'CONNECT' && e.responseStatus === 0 && e.pending !== true;
    default: return false;
  }
}

/** Columns stored on captured_traffic so the list endpoint can filter in SQL. */
export interface DerivedTrafficColumns {
  responseCategory: ContentCategory;
  responseSizeBytes: number;
  isGraphql: boolean;
  isProtobuf: boolean;
}

export function deriveTrafficColumns(row: MethodMatchable & { responseBody?: string | null }): DerivedTrafficColumns {
  return {
    responseCategory: classifyContent(row),
    responseSizeBytes: responseSizeBytes(row.responseBody),
    isGraphql: isGraphqlEntry(row),
    isProtobuf: isProtobufEntry(row),
  };
}
