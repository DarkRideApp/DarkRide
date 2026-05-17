import { describe, it, expect, beforeEach, vi } from 'vitest';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';

// Mock broadcastToAll
vi.mock('../websocket/index', () => ({
  broadcastToAll: vi.fn(),
}));

import { broadcastToAll } from '../websocket/index';
import {
  normaliseUrlPath,
  shouldSkipForCatalogue,
  upsertEndpoint,
  listEndpoints,
  getEndpoint,
  deleteEndpoint,
  clearEndpoints,
  assignGroup,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  assignHostnameToGroup,
  listHostnames,
  compilePattern,
  refreshPatternCache,
  findGroupForHostname,
  addGroupPattern,
  removeGroupPattern,
  listGroupPatterns,
  applyGroupPatterns,
} from './api-catalogue';

describe('normaliseUrlPath', () => {
  it('should replace UUIDs with {id}', () => {
    expect(normaliseUrlPath('/api/users/550e8400-e29b-41d4-a716-446655440000/profile'))
      .toBe('/api/users/{id}/profile');
  });

  it('should replace numeric segments with {id}', () => {
    expect(normaliseUrlPath('/api/posts/12345/comments/67'))
      .toBe('/api/posts/{id}/comments/{id}');
  });

  it('should replace long hex with {hash}', () => {
    expect(normaliseUrlPath('/api/files/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4/download'))
      .toBe('/api/files/{hash}/download');
  });

  it('should replace ISO timestamps', () => {
    expect(normaliseUrlPath('/api/events/2024-03-15T10:30/data'))
      .toBe('/api/events/{timestamp}/data');
  });

  it('should keep literal segments', () => {
    expect(normaliseUrlPath('/api/v1/users/search'))
      .toBe('/api/v1/users/search');
  });

  it('should strip query string', () => {
    expect(normaliseUrlPath('/api/users?page=1&limit=10'))
      .toBe('/api/users');
  });

  it('should strip fragment', () => {
    expect(normaliseUrlPath('/api/docs#section'))
      .toBe('/api/docs');
  });

  it('should handle root path', () => {
    expect(normaliseUrlPath('/')).toBe('/');
  });

  it('should handle mixed dynamic segments', () => {
    expect(normaliseUrlPath('/api/123/items/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('/api/{id}/items/{id}');
  });
});

describe('shouldSkipForCatalogue', () => {
  it('should skip DNS entries', () => {
    expect(shouldSkipForCatalogue('DNS', 200)).toBe(true);
  });

  it('should skip CONNECT entries', () => {
    expect(shouldSkipForCatalogue('CONNECT', 0)).toBe(true);
  });

  it('should skip WebSocket upgrades (101)', () => {
    expect(shouldSkipForCatalogue('GET', 101)).toBe(true);
  });

  it('should not skip normal HTTP', () => {
    expect(shouldSkipForCatalogue('GET', 200)).toBe(false);
    expect(shouldSkipForCatalogue('POST', 404)).toBe(false);
  });
});

describe('upsertEndpoint', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should insert a new endpoint', () => {
    upsertEndpoint(db as any, {
      method: 'GET',
      requestUrl: 'https://api.example.com/v1/users/123',
      sessionId: null,
      requestHeaders: '{"accept":"application/json"}',
      requestBody: null,
      responseStatus: 200,
      responseHeaders: '{"content-type":"application/json"}',
      responseBody: '{"id":123}',
      capturedAt: new Date(),
    });

    const result = listEndpoints(db as any, {});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].method).toBe('GET');
    expect(result.items[0].hostname).toBe('api.example.com');
    expect(result.items[0].pathPattern).toBe('/v1/users/{id}');
    expect(result.items[0].requestCount).toBe(1);
  });

  it('should increment count for duplicate endpoint', () => {
    const params = {
      method: 'GET',
      requestUrl: 'https://api.example.com/v1/users/123',
      sessionId: null,
      requestHeaders: null,
      requestBody: null,
      responseStatus: 200,
      responseHeaders: null,
      responseBody: null,
      capturedAt: new Date(),
    };

    upsertEndpoint(db as any, params);
    upsertEndpoint(db as any, { ...params, requestUrl: 'https://api.example.com/v1/users/456' });

    const result = listEndpoints(db as any, {});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].requestCount).toBe(2);
  });

  it('should link to session', () => {
    // Insert a session
    (db as any).run(
      require('drizzle-orm').sql`INSERT INTO automation_sessions (status, trigger_type, started_at) VALUES ('success', 'manual', ${Date.now()})`
    );

    upsertEndpoint(db as any, {
      method: 'POST',
      requestUrl: 'https://api.example.com/v1/data',
      sessionId: 1,
      requestHeaders: null,
      requestBody: '{"key":"value"}',
      responseStatus: 201,
      responseHeaders: null,
      responseBody: null,
      capturedAt: new Date(),
    });

    const result = listEndpoints(db as any, { sessionId: 1 });
    expect(result.items).toHaveLength(1);
  });

  it('should skip invalid URLs', () => {
    upsertEndpoint(db as any, {
      method: 'GET',
      requestUrl: 'not-a-url',
      sessionId: null,
      requestHeaders: null,
      requestBody: null,
      responseStatus: 200,
      responseHeaders: null,
      responseBody: null,
      capturedAt: new Date(),
    });

    const result = listEndpoints(db as any, {});
    expect(result.items).toHaveLength(0);
  });

  it('should truncate large bodies', () => {
    const largeBody = 'x'.repeat(5000);
    upsertEndpoint(db as any, {
      method: 'GET',
      requestUrl: 'https://api.example.com/big',
      sessionId: null,
      requestHeaders: null,
      requestBody: largeBody,
      responseStatus: 200,
      responseHeaders: null,
      responseBody: largeBody,
      capturedAt: new Date(),
    });

    const detail = getEndpoint(db as any, 1);
    expect(detail).not.toBeNull();
    expect(detail!.sampleRequestBody!.length).toBe(2048);
    expect(detail!.sampleResponseBody!.length).toBe(2048);
  });
});

describe('CRUD operations', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
    // Seed some endpoints
    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://api.example.com/v1/users', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });
    upsertEndpoint(db as any, {
      method: 'POST', requestUrl: 'https://api.example.com/v1/users', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 201,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });
    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://other.api.com/data', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });
  });

  it('should list endpoints with filters', () => {
    const allResults = listEndpoints(db as any, {});
    expect(allResults.total).toBe(3);

    const getOnly = listEndpoints(db as any, { method: 'GET' });
    expect(getOnly.total).toBe(2);

    const hostnameFilter = listEndpoints(db as any, { hostname: 'other' });
    expect(hostnameFilter.total).toBe(1);
  });

  it('should delete an endpoint', () => {
    expect(deleteEndpoint(db as any, 1)).toBe(true);
    expect(listEndpoints(db as any, {}).total).toBe(2);
  });

  it('should clear all endpoints', () => {
    clearEndpoints(db as any);
    expect(listEndpoints(db as any, {}).total).toBe(0);
  });

  it('should list hostnames', () => {
    const hostnames = listHostnames(db as any);
    expect(hostnames).toContain('api.example.com');
    expect(hostnames).toContain('other.api.com');
    expect(hostnames).toHaveLength(2);
  });
});

describe('Groups', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should create and list groups', () => {
    createGroup(db as any, 'Auth API', 'Authentication endpoints');
    createGroup(db as any, 'Data API');

    const groups = listGroups(db as any);
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe('Auth API');
    expect(groups[0].description).toBe('Authentication endpoints');
  });

  it('should update a group', () => {
    createGroup(db as any, 'Test');
    expect(updateGroup(db as any, 1, { name: 'Updated', description: 'New desc' })).toBe(true);

    const groups = listGroups(db as any);
    expect(groups[0].name).toBe('Updated');
  });

  it('should delete a group and nullify FKs', () => {
    createGroup(db as any, 'Test');
    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://api.example.com/test', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });
    assignGroup(db as any, 1, 1);

    const before = getEndpoint(db as any, 1);
    expect(before?.groupId).toBe(1);

    deleteGroup(db as any, 1);

    const after = getEndpoint(db as any, 1);
    expect(after?.groupId).toBeNull();
    expect(listGroups(db as any)).toHaveLength(0);
  });

  it('should assign hostname to group', () => {
    createGroup(db as any, 'Example');
    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://api.example.com/a', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });
    upsertEndpoint(db as any, {
      method: 'POST', requestUrl: 'https://api.example.com/b', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });
    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://other.com/c', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });

    const count = assignHostnameToGroup(db as any, 'api.example.com', 1);
    expect(count).toBe(2);

    const filtered = listEndpoints(db as any, { groupId: 1 });
    expect(filtered.total).toBe(2);
  });

  it('should include patterns in listGroups', () => {
    createGroup(db as any, 'Test');
    addGroupPattern(db as any, 1, 'api.example.com', 'exact');
    addGroupPattern(db as any, 1, '*.test.com', 'wildcard');

    const groups = listGroups(db as any);
    expect(groups[0].patterns).toHaveLength(2);
    expect(groups[0].patterns[0].pattern).toBe('api.example.com');
    expect(groups[0].patterns[1].patternType).toBe('wildcard');
  });

  it('should delete patterns when deleting group', () => {
    createGroup(db as any, 'Test');
    addGroupPattern(db as any, 1, 'api.example.com', 'exact');

    deleteGroup(db as any, 1);

    // Pattern cache should be cleared
    expect(findGroupForHostname('api.example.com')).toBeNull();
  });
});

describe('Pattern matching', () => {
  it('should compile exact patterns', () => {
    const re = compilePattern('api.example.com', 'exact');
    expect(re.test('api.example.com')).toBe(true);
    expect(re.test('other.example.com')).toBe(false);
  });

  it('should compile wildcard patterns', () => {
    const re = compilePattern('*.example.com', 'wildcard');
    expect(re.test('api.example.com')).toBe(true);
    expect(re.test('sub.api.example.com')).toBe(true);
    expect(re.test('example.com')).toBe(false);
    expect(re.test('other.com')).toBe(false);
  });

  it('should compile regex patterns', () => {
    const re = compilePattern('^api\\d+\\.example\\.com$', 'regex');
    expect(re.test('api1.example.com')).toBe(true);
    expect(re.test('api99.example.com')).toBe(true);
    expect(re.test('api.example.com')).toBe(false);
  });
});

describe('Pattern CRUD & auto-assign', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
    // Reset pattern cache
    refreshPatternCache(db as any);
  });

  it('should add and list patterns', () => {
    createGroup(db as any, 'Test');
    addGroupPattern(db as any, 1, 'api.example.com', 'exact');
    addGroupPattern(db as any, 1, '*.test.com', 'wildcard');

    const patterns = listGroupPatterns(db as any, 1);
    expect(patterns).toHaveLength(2);
  });

  it('should remove a pattern', () => {
    createGroup(db as any, 'Test');
    const p = addGroupPattern(db as any, 1, 'api.example.com', 'exact');
    expect(removeGroupPattern(db as any, p.id)).toBe(true);

    const patterns = listGroupPatterns(db as any, 1);
    expect(patterns).toHaveLength(0);
  });

  it('should refresh cache and match hostnames', () => {
    createGroup(db as any, 'Test');
    addGroupPattern(db as any, 1, '*.example.com', 'wildcard');

    expect(findGroupForHostname('api.example.com')).toBe(1);
    expect(findGroupForHostname('other.com')).toBeNull();
  });

  it('should auto-assign group on new endpoint upsert', () => {
    createGroup(db as any, 'Example');
    addGroupPattern(db as any, 1, '*.example.com', 'wildcard');

    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://api.example.com/v1/data', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });

    const ep = getEndpoint(db as any, 1);
    expect(ep?.groupId).toBe(1);
  });

  it('should not overwrite manual group assignment on upsert', () => {
    createGroup(db as any, 'Auto');
    createGroup(db as any, 'Manual');

    // Insert endpoint first (no patterns in cache yet)
    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://api.example.com/v1/data', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });
    // Manually assign to group 2
    assignGroup(db as any, 1, 2);

    // Now add pattern for group 1 — upsert same endpoint (already exists, bumps count)
    addGroupPattern(db as any, 1, '*.example.com', 'wildcard');
    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://api.example.com/v1/data', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });

    const ep = getEndpoint(db as any, 1);
    expect(ep?.groupId).toBe(2); // Manual assignment preserved — existing endpoint takes update path
  });

  it('should apply patterns to existing ungrouped endpoints', () => {
    createGroup(db as any, 'Test');
    // Insert endpoints before adding patterns
    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://api.example.com/a', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });
    upsertEndpoint(db as any, {
      method: 'GET', requestUrl: 'https://other.com/b', sessionId: null,
      requestHeaders: null, requestBody: null, responseStatus: 200,
      responseHeaders: null, responseBody: null, capturedAt: new Date(),
    });

    addGroupPattern(db as any, 1, '*.example.com', 'wildcard');
    const count = applyGroupPatterns(db as any, 1);
    expect(count).toBe(1);

    const filtered = listEndpoints(db as any, { groupId: 1 });
    expect(filtered.total).toBe(1);
  });
});

describe('Status code regression detection', () => {
  let db: BetterSQLite3Database<typeof schema>;
  const mockBroadcast = broadcastToAll as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createTestDb();
    mockBroadcast.mockClear();
  });

  const baseParams = {
    method: 'GET',
    requestUrl: 'https://api.example.com/v1/status',
    sessionId: null,
    requestHeaders: null,
    requestBody: null,
    responseHeaders: null,
    responseBody: null,
    capturedAt: new Date(),
  };

  it('should broadcast api:regression when status class degrades (2xx → 5xx)', () => {
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 200 });
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 500 });

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'api:regression',
      previousStatus: 200,
      currentStatus: 500,
    }));
  });

  it('should broadcast api:regression when status class degrades (2xx → 4xx)', () => {
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 200 });
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 404 });

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'api:regression',
      previousStatus: 200,
      currentStatus: 404,
    }));
  });

  it('should NOT broadcast for same-class variations (200 → 304)', () => {
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 200 });
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 304 });

    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('should NOT broadcast for same-class variations (200 → 201)', () => {
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 200 });
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 201 });

    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('should NOT broadcast for same-class variations (200 → 204)', () => {
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 200 });
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 204 });

    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('should NOT broadcast when downgrading from error to success (5xx → 2xx)', () => {
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 500 });
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 200 });

    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('should NOT broadcast on first insert (no previous status)', () => {
    upsertEndpoint(db as any, { ...baseParams, responseStatus: 500 });

    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});
