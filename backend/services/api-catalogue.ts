import { eq, and, sql, desc, like, gte, lte, isNull } from 'drizzle-orm';
import { apiEndpoints, apiEndpointGroups, apiEndpointSessions, apiEndpointGroupPatterns, apiEndpointQueryParams, capturedTraffic } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { detectGraphQL } from '../../shared/lib/graphql-detect';
import { broadcastToAll } from '../websocket/index';

const MAX_SAMPLE_BODY = 2048;

// ---- Pattern matching cache ----

interface CompiledPattern {
  groupId: number;
  patternId: number;
  regex: RegExp;
}

let patternCache: CompiledPattern[] = [];

export function compilePattern(pattern: string, patternType: string): RegExp {
  if (patternType === 'regex') {
    return new RegExp(pattern);
  }
  if (patternType === 'wildcard') {
    // *.example.com → ^.*\.example\.com$
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  }
  // exact
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`);
}

export function refreshPatternCache(db: AppDatabase): void {
  const rows = db.select({
    id: apiEndpointGroupPatterns.id,
    groupId: apiEndpointGroupPatterns.groupId,
    pattern: apiEndpointGroupPatterns.pattern,
    patternType: apiEndpointGroupPatterns.patternType,
  })
    .from(apiEndpointGroupPatterns)
    .all();

  patternCache = [];
  for (const row of rows) {
    try {
      patternCache.push({
        groupId: row.groupId,
        patternId: row.id,
        regex: compilePattern(row.pattern, row.patternType),
      });
    } catch {
      // skip invalid patterns
    }
  }
}

export function findGroupForHostname(hostname: string): number | null {
  for (const entry of patternCache) {
    if (entry.regex.test(hostname)) {
      return entry.groupId;
    }
  }
  return null;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Normalise a URL path by replacing dynamic segments with placeholders.
 * Query string is stripped.
 */
export function normaliseUrlPath(rawPath: string): string {
  // Strip query string and fragment
  const pathOnly = rawPath.split('?')[0].split('#')[0];

  return pathOnly
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      // UUID: 8-4-4-4-12 hex
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{id}';
      // Pure numeric
      if (/^\d+$/.test(seg)) return '{id}';
      // Long hex (32+ chars)
      if (/^[0-9a-f]{32,}$/i.test(seg)) return '{hash}';
      // ISO timestamp-like
      if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(seg)) return '{timestamp}';
      return seg;
    })
    .join('/');
}

/** Return true if the traffic entry should NOT be catalogued. */
export function shouldSkipForCatalogue(method: string, responseStatus: number | null): boolean {
  if (method === 'DNS') return true;
  if (method === 'CONNECT') return true;
  if (responseStatus === 101) return true; // WebSocket upgrade
  return false;
}

export interface UpsertEndpointParams {
  method: string;
  requestUrl: string;
  sessionId: number | null;
  requestHeaders: string | null;
  requestBody: string | null;
  responseStatus: number | null;
  responseHeaders: string | null;
  responseBody: string | null;
  capturedAt: Date;
}

export function upsertEndpoint(db: AppDatabase, params: UpsertEndpointParams): void {
  let hostname: string;
  let rawPath: string;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.requestUrl);
    hostname = parsedUrl.hostname;
    rawPath = parsedUrl.pathname;
  } catch {
    return; // invalid URL, skip
  }

  // Extract query params with their values
  const queryParamEntries: Array<{ name: string; value: string }> = [];
  parsedUrl.searchParams.forEach((value, name) => {
    queryParamEntries.push({ name, value });
  });

  let pathPattern = normaliseUrlPath(rawPath);
  const now = params.capturedAt;

  // Detect GraphQL — each operation gets its own catalogue entry
  const gql = detectGraphQL(params.method, params.requestUrl, params.requestBody);
  const method = gql ? `GQL_${gql.operationType.toUpperCase()}` : params.method;
  if (gql) {
    const opName = gql.operationName || '(anonymous)';
    pathPattern = `${pathPattern} [${opName}]`;
  }

  // Try insert first (unique constraint catches dupes)
  const result = db.run(
    sql`INSERT OR IGNORE INTO api_endpoints (method, hostname, path_pattern, first_seen, last_seen, request_count, sample_request_headers, sample_request_body, sample_response_status, sample_response_headers, sample_response_body)
        VALUES (${method}, ${hostname}, ${pathPattern}, ${now.getTime()}, ${now.getTime()}, 1, ${truncate(params.requestHeaders, MAX_SAMPLE_BODY)}, ${truncate(params.requestBody, MAX_SAMPLE_BODY)}, ${params.responseStatus}, ${truncate(params.responseHeaders, MAX_SAMPLE_BODY)}, ${truncate(params.responseBody, MAX_SAMPLE_BODY)})`
  );

  let endpointId: number;

  if (result.changes === 0) {
    // Row already existed — fetch it once for regression check and later use
    const existing = db.select({ id: apiEndpoints.id, sampleResponseStatus: apiEndpoints.sampleResponseStatus })
      .from(apiEndpoints)
      .where(and(
        eq(apiEndpoints.method, method),
        eq(apiEndpoints.hostname, hostname),
        eq(apiEndpoints.pathPattern, pathPattern),
      ))
      .all()[0];

    if (!existing) return;
    endpointId = existing.id;

    // Check for status code class regression (e.g. 2xx → 4xx/5xx)
    // Ignore variations within the same class (200→304, 200→201) to avoid false positives
    if (params.responseStatus != null && existing.sampleResponseStatus != null) {
      const previousClass = Math.floor(existing.sampleResponseStatus / 100);
      const currentClass = Math.floor(params.responseStatus / 100);
      if (previousClass !== currentClass && currentClass >= 4) {
        broadcastToAll({
          type: 'api:regression',
          endpointId: existing.id,
          method,
          hostname,
          pathPattern,
          previousStatus: existing.sampleResponseStatus,
          currentStatus: params.responseStatus,
        });
      }
    }

    // Bump last_seen, request_count, and update sample_response_status so regression only fires once per change
    db.run(
      sql`UPDATE api_endpoints SET last_seen = ${now.getTime()}, request_count = request_count + 1, sample_response_status = ${params.responseStatus}
          WHERE method = ${method} AND hostname = ${hostname} AND path_pattern = ${pathPattern}`
    );
  } else {
    // New endpoint — auto-assign group via pattern cache
    const matchedGroupId = findGroupForHostname(hostname);
    if (matchedGroupId != null) {
      db.run(
        sql`UPDATE api_endpoints SET group_id = ${matchedGroupId}
            WHERE method = ${method} AND hostname = ${hostname} AND path_pattern = ${pathPattern} AND group_id IS NULL`
      );
    }

    // Get the endpoint ID for session linking and query param tracking
    const newRow = db.select({ id: apiEndpoints.id })
      .from(apiEndpoints)
      .where(and(
        eq(apiEndpoints.method, method),
        eq(apiEndpoints.hostname, hostname),
        eq(apiEndpoints.pathPattern, pathPattern),
      ))
      .all()[0];

    if (!newRow) return;
    endpointId = newRow.id;
  }

  // Link to session if applicable
  if (params.sessionId != null) {
    db.run(
      sql`INSERT OR IGNORE INTO api_endpoint_sessions (endpoint_id, session_id) VALUES (${endpointId}, ${params.sessionId})`
    );
  }

  // Track query params
  for (const { name, value } of queryParamEntries) {
    const existing = db.select()
      .from(apiEndpointQueryParams)
      .where(and(
        eq(apiEndpointQueryParams.endpointId, endpointId),
        eq(apiEndpointQueryParams.paramName, name),
      ))
      .all()[0];

    if (existing) {
      const samples: string[] = JSON.parse(existing.sampleValues);
      if (!samples.includes(value) && samples.length < 10) {
        samples.push(value);
      }
      db.update(apiEndpointQueryParams)
        .set({
          occurrenceCount: existing.occurrenceCount + 1,
          lastSeen: new Date(),
          sampleValues: JSON.stringify(samples),
        })
        .where(eq(apiEndpointQueryParams.id, existing.id))
        .run();
    } else {
      db.insert(apiEndpointQueryParams).values({
        endpointId,
        paramName: name,
        sampleValues: JSON.stringify(value ? [value] : []),
        occurrenceCount: 1,
        firstSeen: new Date(),
        lastSeen: new Date(),
      }).run();
    }
  }
}

// ---- Query / CRUD functions ----

export interface EndpointListFilters {
  method?: string;
  hostname?: string;
  pathPattern?: string;
  groupId?: number | 'ungrouped';
  sessionId?: number;
  statusCode?: number;
  from?: number; // unix ms
  to?: number;   // unix ms
  bodySearch?: string;
  limit?: number;
  offset?: number;
}

export function listEndpoints(db: AppDatabase, filters: EndpointListFilters) {
  const conditions: any[] = [];

  if (filters.method) {
    conditions.push(eq(apiEndpoints.method, filters.method.toUpperCase()));
  }
  if (filters.hostname) {
    conditions.push(like(apiEndpoints.hostname, `%${filters.hostname}%`));
  }
  if (filters.pathPattern) {
    conditions.push(like(apiEndpoints.pathPattern, `%${filters.pathPattern}%`));
  }
  if (filters.groupId === 'ungrouped') {
    conditions.push(isNull(apiEndpoints.groupId));
  } else if (filters.groupId != null) {
    conditions.push(eq(apiEndpoints.groupId, filters.groupId));
  }
  if (filters.statusCode != null) {
    conditions.push(eq(apiEndpoints.sampleResponseStatus, filters.statusCode));
  }
  if (filters.from != null) {
    conditions.push(gte(apiEndpoints.lastSeen, new Date(filters.from)));
  }
  if (filters.to != null) {
    conditions.push(lte(apiEndpoints.lastSeen, new Date(filters.to)));
  }
  if (filters.bodySearch) {
    conditions.push(sql`(${apiEndpoints.sampleRequestBody} LIKE ${'%' + filters.bodySearch + '%'} OR ${apiEndpoints.sampleResponseBody} LIKE ${'%' + filters.bodySearch + '%'})`);
  }

  const where = conditions.length > 0
    ? conditions.length === 1 ? conditions[0] : and(...conditions)
    : undefined;

  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  // If filtering by sessionId, join through apiEndpointSessions
  if (filters.sessionId != null) {
    const sessionConditions = [...conditions, eq(apiEndpointSessions.sessionId, filters.sessionId)];
    const sessionWhere = sessionConditions.length === 1 ? sessionConditions[0] : and(...sessionConditions);

    const countResult = db.select({ count: sql<number>`count(DISTINCT ${apiEndpoints.id})` })
      .from(apiEndpoints)
      .innerJoin(apiEndpointSessions, eq(apiEndpoints.id, apiEndpointSessions.endpointId))
      .leftJoin(apiEndpointGroups, eq(apiEndpoints.groupId, apiEndpointGroups.id))
      .where(sessionWhere)
      .all();
    const total = countResult[0]?.count || 0;

    const items = db.select({
      id: apiEndpoints.id,
      method: apiEndpoints.method,
      hostname: apiEndpoints.hostname,
      pathPattern: apiEndpoints.pathPattern,
      firstSeen: apiEndpoints.firstSeen,
      lastSeen: apiEndpoints.lastSeen,
      requestCount: apiEndpoints.requestCount,
      sampleResponseStatus: apiEndpoints.sampleResponseStatus,
      groupId: apiEndpoints.groupId,
      groupName: apiEndpointGroups.name,
    })
      .from(apiEndpoints)
      .innerJoin(apiEndpointSessions, eq(apiEndpoints.id, apiEndpointSessions.endpointId))
      .leftJoin(apiEndpointGroups, eq(apiEndpoints.groupId, apiEndpointGroups.id))
      .where(sessionWhere)
      .orderBy(desc(apiEndpoints.lastSeen))
      .limit(limit)
      .offset(offset)
      .all();

    return { items, total, limit, offset };
  }

  // Normal query (no session filter)
  const countQuery = db.select({ count: sql<number>`count(*)` }).from(apiEndpoints);
  const total = (where ? countQuery.where(where) : countQuery).all()[0]?.count || 0;

  const query = db.select({
    id: apiEndpoints.id,
    method: apiEndpoints.method,
    hostname: apiEndpoints.hostname,
    pathPattern: apiEndpoints.pathPattern,
    firstSeen: apiEndpoints.firstSeen,
    lastSeen: apiEndpoints.lastSeen,
    requestCount: apiEndpoints.requestCount,
    sampleResponseStatus: apiEndpoints.sampleResponseStatus,
    groupId: apiEndpoints.groupId,
    groupName: apiEndpointGroups.name,
  })
    .from(apiEndpoints)
    .leftJoin(apiEndpointGroups, eq(apiEndpoints.groupId, apiEndpointGroups.id));

  const items = (where ? query.where(where) : query)
    .orderBy(desc(apiEndpoints.lastSeen))
    .limit(limit)
    .offset(offset)
    .all();

  return { items, total, limit, offset };
}

export function getEndpoint(db: AppDatabase, id: number) {
  const endpoint = db.select({
    id: apiEndpoints.id,
    method: apiEndpoints.method,
    hostname: apiEndpoints.hostname,
    pathPattern: apiEndpoints.pathPattern,
    firstSeen: apiEndpoints.firstSeen,
    lastSeen: apiEndpoints.lastSeen,
    requestCount: apiEndpoints.requestCount,
    sampleRequestHeaders: apiEndpoints.sampleRequestHeaders,
    sampleRequestBody: apiEndpoints.sampleRequestBody,
    sampleResponseStatus: apiEndpoints.sampleResponseStatus,
    sampleResponseHeaders: apiEndpoints.sampleResponseHeaders,
    sampleResponseBody: apiEndpoints.sampleResponseBody,
    groupId: apiEndpoints.groupId,
    groupName: apiEndpointGroups.name,
    responseSpec: apiEndpoints.responseSpec,
  })
    .from(apiEndpoints)
    .leftJoin(apiEndpointGroups, eq(apiEndpoints.groupId, apiEndpointGroups.id))
    .where(eq(apiEndpoints.id, id))
    .all()[0] || null;

  if (!endpoint) return null;

  const queryParams = db.select()
    .from(apiEndpointQueryParams)
    .where(eq(apiEndpointQueryParams.endpointId, id))
    .orderBy(apiEndpointQueryParams.paramName)
    .all()
    .map(p => ({
      name: p.paramName,
      sampleValues: JSON.parse(p.sampleValues),
      occurrenceCount: p.occurrenceCount,
    }));

  const parsedSpec = endpoint.responseSpec ? (() => {
    try { return JSON.parse(endpoint.responseSpec); } catch { return null; }
  })() : null;

  return { ...endpoint, responseSpec: parsedSpec, queryParams };
}

export function deleteEndpoint(db: AppDatabase, id: number): boolean {
  db.delete(apiEndpointSessions).where(eq(apiEndpointSessions.endpointId, id)).run();
  db.delete(apiEndpointQueryParams).where(eq(apiEndpointQueryParams.endpointId, id)).run();
  const result = db.delete(apiEndpoints).where(eq(apiEndpoints.id, id)).run();
  return result.changes > 0;
}

export function clearEndpoints(db: AppDatabase): void {
  db.delete(apiEndpointSessions).run();
  db.delete(apiEndpointQueryParams).run();
  db.delete(apiEndpoints).run();
}

export function assignGroup(db: AppDatabase, endpointId: number, groupId: number | null): boolean {
  const result = db.update(apiEndpoints)
    .set({ groupId })
    .where(eq(apiEndpoints.id, endpointId))
    .run();
  return result.changes > 0;
}

export function getEndpointSessions(db: AppDatabase, endpointId: number) {
  return db.run(
    sql`SELECT s.id, s.name, s.status, s.started_at, s.completed_at, s.device_id
        FROM automation_sessions s
        INNER JOIN api_endpoint_sessions aes ON aes.session_id = s.id
        WHERE aes.endpoint_id = ${endpointId}
        ORDER BY s.started_at DESC`
  );
}

export function getEndpointSessionsRaw(db: AppDatabase, endpointId: number): any[] {
  // Use raw SQL for the join query since Drizzle cross-table selects can be verbose
  const stmt = (db as any).all(
    sql`SELECT s.id, s.name, s.status, s.started_at as startedAt, s.completed_at as completedAt, s.device_id as deviceId
        FROM automation_sessions s
        INNER JOIN api_endpoint_sessions aes ON aes.session_id = s.id
        WHERE aes.endpoint_id = ${endpointId}
        ORDER BY s.started_at DESC
        LIMIT 50`
  );
  return stmt;
}

// ---- Group CRUD ----

export function listGroups(db: AppDatabase) {
  // Get groups
  const groups = db.select({
    id: apiEndpointGroups.id,
    name: apiEndpointGroups.name,
    description: apiEndpointGroups.description,
    notes: apiEndpointGroups.notes,
    createdAt: apiEndpointGroups.createdAt,
  })
    .from(apiEndpointGroups)
    .all();

  // Count endpoints per group via raw SQL (Drizzle sql`` subquery interpolation is unreliable)
  const countRows = (db as any).all(sql`SELECT group_id, count(*) as cnt FROM api_endpoints WHERE group_id IS NOT NULL GROUP BY group_id`);
  const countMap = new Map<number, number>();
  for (const row of countRows) {
    countMap.set(row.group_id, row.cnt);
  }
  const groupsWithCounts = groups.map(g => ({ ...g, endpointCount: countMap.get(g.id) || 0 }));

  // Attach patterns per group
  const allPatterns = db.select({
    id: apiEndpointGroupPatterns.id,
    groupId: apiEndpointGroupPatterns.groupId,
    pattern: apiEndpointGroupPatterns.pattern,
    patternType: apiEndpointGroupPatterns.patternType,
    createdAt: apiEndpointGroupPatterns.createdAt,
  })
    .from(apiEndpointGroupPatterns)
    .all();

  const patternMap = new Map<number, typeof allPatterns>();
  for (const p of allPatterns) {
    const list = patternMap.get(p.groupId) || [];
    list.push(p);
    patternMap.set(p.groupId, list);
  }

  return groupsWithCounts.map(g => ({
    ...g,
    patterns: patternMap.get(g.id) || [],
  }));
}

export function createGroup(db: AppDatabase, name: string, description?: string, notes?: string) {
  const result = db.insert(apiEndpointGroups)
    .values({ name, description: description || null, notes: notes || null, createdAt: new Date() })
    .run();
  return { id: Number(result.lastInsertRowid), name, description: description || null, notes: notes || null };
}

export function updateGroup(db: AppDatabase, id: number, data: { name?: string; description?: string; notes?: string }): boolean {
  const updates: any = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.notes !== undefined) updates.notes = data.notes;
  if (Object.keys(updates).length === 0) return false;
  const result = db.update(apiEndpointGroups).set(updates).where(eq(apiEndpointGroups.id, id)).run();
  return result.changes > 0;
}

export function deleteGroup(db: AppDatabase, id: number): boolean {
  // Nullify FK references in endpoints
  db.update(apiEndpoints).set({ groupId: null }).where(eq(apiEndpoints.groupId, id)).run();
  // Delete associated patterns
  db.delete(apiEndpointGroupPatterns).where(eq(apiEndpointGroupPatterns.groupId, id)).run();
  const result = db.delete(apiEndpointGroups).where(eq(apiEndpointGroups.id, id)).run();
  if (result.changes > 0) {
    refreshPatternCache(db);
  }
  return result.changes > 0;
}

export function assignHostnameToGroup(db: AppDatabase, hostname: string, groupId: number): number {
  const result = db.update(apiEndpoints)
    .set({ groupId })
    .where(eq(apiEndpoints.hostname, hostname))
    .run();
  return result.changes;
}

// ---- Pattern CRUD ----

export function listGroupPatterns(db: AppDatabase, groupId: number) {
  return db.select({
    id: apiEndpointGroupPatterns.id,
    groupId: apiEndpointGroupPatterns.groupId,
    pattern: apiEndpointGroupPatterns.pattern,
    patternType: apiEndpointGroupPatterns.patternType,
    createdAt: apiEndpointGroupPatterns.createdAt,
  })
    .from(apiEndpointGroupPatterns)
    .where(eq(apiEndpointGroupPatterns.groupId, groupId))
    .all();
}

export function addGroupPattern(db: AppDatabase, groupId: number, pattern: string, patternType: string) {
  const result = db.insert(apiEndpointGroupPatterns)
    .values({ groupId, pattern, patternType, createdAt: new Date() })
    .run();
  refreshPatternCache(db);
  return { id: Number(result.lastInsertRowid), groupId, pattern, patternType };
}

export function removeGroupPattern(db: AppDatabase, patternId: number): boolean {
  const result = db.delete(apiEndpointGroupPatterns)
    .where(eq(apiEndpointGroupPatterns.id, patternId))
    .run();
  if (result.changes > 0) {
    refreshPatternCache(db);
  }
  return result.changes > 0;
}

export function applyGroupPatterns(db: AppDatabase, groupId: number): number {
  const patterns = listGroupPatterns(db, groupId);
  if (patterns.length === 0) return 0;

  // Get ungrouped endpoints
  const ungrouped = db.select({ id: apiEndpoints.id, hostname: apiEndpoints.hostname })
    .from(apiEndpoints)
    .where(isNull(apiEndpoints.groupId))
    .all();

  const compiled = patterns.map(p => {
    try { return compilePattern(p.pattern, p.patternType); }
    catch { return null; }
  }).filter((r): r is RegExp => r !== null);

  let count = 0;
  for (const ep of ungrouped) {
    if (compiled.some(regex => regex.test(ep.hostname))) {
      db.update(apiEndpoints)
        .set({ groupId })
        .where(and(eq(apiEndpoints.id, ep.id), isNull(apiEndpoints.groupId)))
        .run();
      count++;
    }
  }
  return count;
}

export function listHostnames(db: AppDatabase): string[] {
  const rows = db.selectDistinct({ hostname: apiEndpoints.hostname })
    .from(apiEndpoints)
    .orderBy(apiEndpoints.hostname)
    .all();
  return rows.map(r => r.hostname);
}

/**
 * Fetch response bodies for traffic that matches an endpoint's method/hostname/path pattern.
 * Returns up to `limit` non-null response bodies.
 */
export function getEndpointResponseBodies(db: AppDatabase, endpointId: number, limit = 100): string[] {
  const endpoint = db.select({
    method: apiEndpoints.method,
    hostname: apiEndpoints.hostname,
    pathPattern: apiEndpoints.pathPattern,
  })
    .from(apiEndpoints)
    .where(eq(apiEndpoints.id, endpointId))
    .all()[0];

  if (!endpoint) return [];

  // Build a LIKE pattern that matches URLs for this hostname + path pattern.
  // Path pattern may contain placeholders like {id}, {hash}, {timestamp}.
  // We use the hostname as a reliable filter since URL contains scheme+hostname+path.
  const rows = (db as any).all(
    sql`SELECT response_body FROM captured_traffic
        WHERE request_method = ${endpoint.method}
          AND request_url LIKE ${'%' + endpoint.hostname + '%'}
          AND response_body IS NOT NULL
        ORDER BY captured_at DESC
        LIMIT ${limit}`
  ) as Array<{ response_body: string }>;

  return rows.map(r => r.response_body).filter(Boolean);
}

/**
 * Store an inferred response spec as JSON on the endpoint record.
 */
export function storeResponseSpec(db: AppDatabase, endpointId: number, spec: object | null): boolean {
  const result = db.update(apiEndpoints)
    .set({ responseSpec: spec ? JSON.stringify(spec) : null })
    .where(eq(apiEndpoints.id, endpointId))
    .run();
  return result.changes > 0;
}
