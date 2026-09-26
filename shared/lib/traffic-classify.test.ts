import { describe, it, expect } from 'vitest';
import {
  classifyContent,
  responseSizeBytes,
  contentFilterMatches,
  compileUrlFilter,
  deriveTrafficColumns,
  matchesMethodFilter,
  CONTENT_FILTER_KEYS,
  METHOD_FILTER_KEYS,
} from './traffic-classify';

const gqlBody = JSON.stringify({ query: 'query Me { me { id } }' });
const headers = (h: Record<string, string>) => JSON.stringify(h);

describe('classifyContent', () => {
  it('websocket rows are websocket regardless of headers', () => {
    expect(classifyContent({ type: 'websocket', requestMethod: 'GET', requestUrl: 'wss://x', requestBody: null, responseHeaders: headers({ 'content-type': 'application/json' }) })).toBe('websocket');
  });

  it('GraphQL wins over a JSON response content type', () => {
    expect(classifyContent({ type: 'http', requestMethod: 'POST', requestUrl: 'https://x/graphql', requestBody: gqlBody, responseHeaders: headers({ 'content-type': 'application/json' }) })).toBe('graphql');
  });

  it.each([
    ['application/javascript', 'script'],
    ['text/css', 'stylesheet'],
    ['text/html; charset=utf-8', 'document'],
    ['image/png', 'image'],
    ['font/woff2', 'font'],
    ['application/json', 'json'],
    ['application/xml', 'xml'],
    ['application/octet-stream', 'fetch/xhr'],
  ])('%s -> %s', (ct, expected) => {
    expect(classifyContent({ type: 'http', requestMethod: 'GET', requestUrl: 'https://x', requestBody: null, responseHeaders: headers({ 'content-type': ct }) })).toBe(expected);
  });

  it('matches header name and value case-insensitively', () => {
    expect(classifyContent({ type: 'http', requestMethod: 'GET', requestUrl: 'https://x', requestBody: null, responseHeaders: headers({ 'CONTENT-TYPE': 'Application/JSON' }) })).toBe('json');
  });

  it('missing or malformed headers are fetch/xhr', () => {
    expect(classifyContent({ type: 'http', requestMethod: 'GET', requestUrl: 'https://x', requestBody: null, responseHeaders: null })).toBe('fetch/xhr');
    expect(classifyContent({ type: 'http', requestMethod: 'GET', requestUrl: 'https://x', requestBody: null, responseHeaders: '{not json' })).toBe('fetch/xhr');
  });
});

describe('contentFilterMatches', () => {
  it('maps filter keys to categories, with "other" catching everything uncategorised', () => {
    expect(contentFilterMatches('json', 'json')).toBe(true);
    expect(contentFilterMatches('html', 'document')).toBe(true);
    expect(contentFilterMatches('js', 'script')).toBe(true);
    expect(contentFilterMatches('css', 'stylesheet')).toBe(true);
    expect(contentFilterMatches('other', 'graphql')).toBe(true);
    expect(contentFilterMatches('other', 'websocket')).toBe(true);
    expect(contentFilterMatches('other', 'fetch/xhr')).toBe(true);
    expect(contentFilterMatches('other', 'json')).toBe(false);
    expect(contentFilterMatches('json', 'graphql')).toBe(false);
  });

  it('knows every filter key', () => {
    expect([...CONTENT_FILTER_KEYS].sort()).toEqual(['css', 'font', 'html', 'image', 'js', 'json', 'other', 'xml']);
  });
});

describe('responseSizeBytes', () => {
  it('reads the original size from a binary placeholder', () => {
    expect(responseSizeBytes('[binary image/jpeg, 512000 chars]')).toBe(512000);
  });

  it('reads the original size from a truncation marker', () => {
    expect(responseSizeBytes('{"a":1…[truncated, 250000 total]')).toBe(250000);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(responseSizeBytes('é')).toBe(2);
    expect(responseSizeBytes('😀')).toBe(4);
  });

  it('empty and null are 0', () => {
    expect(responseSizeBytes(null)).toBe(0);
    expect(responseSizeBytes(undefined)).toBe(0);
    expect(responseSizeBytes('')).toBe(0);
  });
});

describe('compileUrlFilter', () => {
  it('matches as a case-insensitive regex', () => {
    const m = compileUrlFilter('api\\.example\\.com/v[0-9]+/');
    expect(m('https://API.example.com/v2/users')).toBe(true);
    expect(m('https://api.example.com/users')).toBe(false);
  });

  it('falls back to a case-insensitive substring for an invalid pattern', () => {
    const m = compileUrlFilter('users(');
    expect(m('https://x/USERS(1)')).toBe(true);
    expect(m('https://x/users')).toBe(false);
  });

  it('runs a catastrophic-backtracking pattern in linear time', () => {
    const m = compileUrlFilter('^(a+)+$');
    const url = 'a'.repeat(50_000) + '!';
    const start = Date.now();
    expect(m(url)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('matchesMethodFilter', () => {
  const base = { type: 'http', requestMethod: 'GET', requestUrl: 'https://x', requestBody: null, requestHeaders: null, responseHeaders: null, responseStatus: 200 };
  const gql = { ...base, requestMethod: 'POST', requestBody: gqlBody };
  const proto = { ...base, requestMethod: 'POST', requestHeaders: headers({ 'content-type': 'application/x-protobuf' }) };

  it('GET/POST exclude GraphQL and protobuf', () => {
    expect(matchesMethodFilter(base, 'GET')).toBe(true);
    expect(matchesMethodFilter(gql, 'POST')).toBe(false);
    expect(matchesMethodFilter(gql, 'GQL')).toBe(true);
    expect(matchesMethodFilter(proto, 'POST')).toBe(false);
    expect(matchesMethodFilter(proto, 'PROTO')).toBe(true);
  });

  it('CONNECT with status 0 is a TLS failure unless still pending', () => {
    const failed = { ...base, requestMethod: 'CONNECT', responseStatus: 0 };
    expect(matchesMethodFilter(failed, 'TLS_FAIL')).toBe(true);
    expect(matchesMethodFilter(failed, 'CONNECT')).toBe(false);
    expect(matchesMethodFilter({ ...failed, pending: true }, 'CONNECT')).toBe(true);
    expect(matchesMethodFilter({ ...failed, pending: true }, 'TLS_FAIL')).toBe(false);
    expect(matchesMethodFilter({ ...base, requestMethod: 'CONNECT', responseStatus: null }, 'CONNECT')).toBe(true);
  });

  it('knows every method filter key', () => {
    expect(METHOD_FILTER_KEYS).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'GQL', 'PROTO', 'CONNECT', 'OPTIONS', 'WS', 'DNS', 'TLS_FAIL']);
  });
});

describe('deriveTrafficColumns', () => {
  it('computes the stored filter columns from a raw row', () => {
    expect(deriveTrafficColumns({
      type: 'http', requestMethod: 'POST', requestUrl: 'https://x/graphql', requestBody: gqlBody,
      requestHeaders: null, responseHeaders: headers({ 'content-type': 'application/json' }),
      responseBody: '[binary application/json, 300000 chars]',
    })).toEqual({ responseCategory: 'graphql', responseSizeBytes: 300000, isGraphql: true, isProtobuf: false });
  });
});
