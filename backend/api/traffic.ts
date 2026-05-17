import { eq, and, or, gte, lt, like, desc, asc, sql } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { capturedTraffic, websocketMessages, hiddenDomains } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { broadcastToAll } from '../websocket/index';
import { registerFilteredChannel } from '../websocket/channel-registry';
import { upsertEndpoint, shouldSkipForCatalogue } from '../services/api-catalogue';
import { createLoggers } from '../logs';
import type { TrafficEntryMessage, TrafficRequestStartedMessage, WebSocketFrameMessage, WebSocketConnectionClosedMessage } from '../../shared/types/websocket';
import type { TrafficHookRegistry } from '../services/traffic-hook-registry';

const { log, error: logError } = createLoggers('traffic-api');

// ---- Traffic Filtering Rules (in-memory) ----

export interface TrafficFilterRule {
  id: number;
  hostname?: string;
  path?: string;
  maxContentSize?: number;
  contentType?: string;
}

let nextRuleId = 1;
const filterRules: TrafficFilterRule[] = [];

export function getFilterRules(): TrafficFilterRule[] {
  return filterRules;
}

export function addFilterRule(rule: Omit<TrafficFilterRule, 'id'>): TrafficFilterRule {
  const newRule: TrafficFilterRule = { id: nextRuleId++, ...rule };
  filterRules.push(newRule);
  return newRule;
}

export function removeFilterRule(id: number): boolean {
  const idx = filterRules.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  filterRules.splice(idx, 1);
  return true;
}

/** Reset rules state (for testing). */
export function resetFilterRules(): void {
  filterRules.length = 0;
  nextRuleId = 1;
}

/**
 * Check if a traffic entry should be ignored based on active filter rules.
 * All conditions in a rule must match for the traffic to be ignored.
 */
export function shouldIgnoreTraffic(entry: {
  url: string;
  responseBody?: string | null;
  contentType?: string | null;
}): boolean {
  if (filterRules.length === 0) return false;

  for (const rule of filterRules) {
    let allMatch = true;

    if (rule.hostname) {
      try {
        const urlObj = new URL(entry.url);
        const pattern = rule.hostname;
        if (pattern.startsWith('*.')) {
          const domain = pattern.slice(2);
          if (!urlObj.hostname.endsWith(domain) && urlObj.hostname !== domain.slice(0)) {
            allMatch = false;
          }
        } else {
          const hostnameRegex = new RegExp(pattern);
          if (!hostnameRegex.test(urlObj.hostname)) {
            allMatch = false;
          }
        }
      } catch {
        allMatch = false;
      }
    }

    if (rule.path && allMatch) {
      try {
        const urlObj = new URL(entry.url);
        const pathRegex = new RegExp(rule.path);
        if (!pathRegex.test(urlObj.pathname)) {
          allMatch = false;
        }
      } catch {
        allMatch = false;
      }
    }

    if (rule.maxContentSize !== undefined && allMatch) {
      const bodySize = entry.responseBody ? Buffer.byteLength(entry.responseBody, 'utf8') : 0;
      if (bodySize <= rule.maxContentSize) {
        allMatch = false;
      }
    }

    if (rule.contentType && allMatch) {
      if (!entry.contentType || !entry.contentType.includes(rule.contentType)) {
        allMatch = false;
      }
    }

    if (allMatch) return true;
  }

  return false;
}

export const wsFlowMap = new Map<string, number>();

/** Remove all entries from wsFlowMap, e.g. when a capture session ends. */
export function clearWsFlowMap(deviceId?: string): void {
  if (!deviceId) {
    wsFlowMap.clear();
    return;
  }
  // Flow IDs from mitmproxy are UUIDs with no device prefix,
  // so clear all when a device-specific clear is requested.
  // In practice stopCapture calls this without a filter.
  wsFlowMap.clear();
}

// ---- Helpers ----

/** Parse matchedRules JSON string from DB row into array, if present. */
function parseMatchedRules(row: any): any {
  if (!row.matchedRules) return row;
  try {
    return { ...row, matchedRules: JSON.parse(row.matchedRules) };
  } catch {
    return row;
  }
}

/** Strip the binary blob from a traffic row for JSON serialisation. */
function stripBinaryFields(row: any): any {
  const { responseBodyBinary, ...rest } = row;
  return {
    ...rest,
    hasImage: !!responseBodyBinary,
  };
}

// ---- API Registration ----

export function registerTrafficEndpoints(db: AppDatabase, hookRegistry?: TrafficHookRegistry): void {
  // High-frequency channels — only deliver to clients that explicitly
  // subscribed (Traffic page, TrafficInspector, DeviceView, Frida).
  // Pages that don't care (Settings, Plugins, Dashboard, etc.) stop
  // receiving the bytes during active capture.
  registerFilteredChannel('traffic-entry');
  registerFilteredChannel('traffic-request-started');
  registerFilteredChannel('ws-frame');
  registerFilteredChannel('ws-connection-closed');

  // POST /v1/traffic/intercept — real-time traffic interception for automation hooks
  registerEndpoint('POST', '/v1/traffic/intercept', async (req, res) => {
    try {
      const { deviceId, phase } = req.body;

      // Fast path: no registry or no hooks
      if (!hookRegistry || !deviceId || !hookRegistry.hasHooks(deviceId)) {
        res.json({ action: 'pass' });
        return;
      }

      const result = await hookRegistry.processIntercept(req.body);
      res.json(result);
    } catch (err: any) {
      logError(`Intercept endpoint error: ${err.message}`);
      res.json({ action: 'pass' });
    }
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/traffic/request-started — notify that a request has started (pending)
  registerEndpoint('POST', '/v1/traffic/request-started', (req, res) => {
    const { flowId, deviceId, sessionId, method, url, headers } = req.body;

    if (!flowId || !url) {
      res.status(400).json({ success: false, error: 'flowId and url are required' });
      return;
    }

    // Check hidden domains — skip broadcast for hidden hostnames
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      const hiddenRows = db.select({ domain: hiddenDomains.domain }).from(hiddenDomains).all();
      for (const row of hiddenRows) {
        const domain = row.domain.toLowerCase();
        if (hostname === domain || hostname.endsWith('.' + domain)) {
          res.json({ success: true, hidden: true });
          return;
        }
      }
    } catch {
      // Invalid URL — proceed anyway
    }

    const message: TrafficRequestStartedMessage = {
      type: 'traffic-request-started',
      flowId,
      deviceId: deviceId || null,
      sessionId: sessionId ?? null,
      requestMethod: method || 'GET',
      requestUrl: url,
      requestHeaders: headers ? JSON.stringify(headers) : null,
      timestamp: new Date().toISOString(),
    };
    broadcastToAll(message);

    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/traffic/ingest — webhook from mitmproxy bridge
  registerEndpoint('POST', '/v1/traffic/ingest', (req, res) => {
    const { request: reqData, response: resData } = req.body;

    if (!reqData || !reqData.method || !reqData.url) {
      res.status(400).json({ success: false, error: 'Invalid traffic data' });
      return;
    }

    // Extract content-type from request headers for filtering
    const headers = reqData.headers || {};
    const contentType = headers['content-type'] || headers['Content-Type'] || null;

    // Apply filter rules
    if (shouldIgnoreTraffic({
      url: reqData.url,
      responseBody: resData?.body,
      contentType,
    })) {
      res.json({ success: true, filtered: true });
      return;
    }

    const sessionId = req.body.sessionId || null;
    const deviceId = req.body.deviceId || null;
    const requestMethod = reqData.method;
    const requestUrl = reqData.url;
    const requestHeaders = reqData.headers ? JSON.stringify(reqData.headers) : null;
    const requestBody = reqData.body || null;
    const responseStatus = resData?.status ?? null;
    const responseHeaders = resData?.headers ? JSON.stringify(resData.headers) : null;
    const responseBody = resData?.body || null;
    const responseBodyBase64 = resData?.bodyBase64 || null;
    const responseContentType = resData?.contentType || null;
    const capturedAt = new Date();
    const matchedRulesRaw = req.body.matchedRules;
    const matchedRules = (Array.isArray(matchedRulesRaw) && matchedRulesRaw.length > 0)
      ? JSON.stringify(matchedRulesRaw)
      : null;

    // Decode base64 image body to Buffer for blob storage
    const responseBodyBinary = responseBodyBase64
      ? Buffer.from(responseBodyBase64, 'base64')
      : null;

    let hostname: string | null = null;
    try { hostname = new URL(requestUrl).hostname; } catch {}

    const result = db.insert(capturedTraffic)
      .values({
        sessionId,
        deviceId,
        requestMethod,
        requestUrl,
        hostname,
        requestHeaders,
        requestBody,
        responseStatus,
        responseHeaders,
        responseBody,
        responseBodyBinary,
        responseContentType,
        matchedRules,
        capturedAt,
      })
      .run();

    const insertedId = Number(result.lastInsertRowid);

    // Upsert into API catalogue
    if (!shouldSkipForCatalogue(requestMethod, responseStatus)) {
      try {
        upsertEndpoint(db, { method: requestMethod, requestUrl, sessionId, requestHeaders, requestBody, responseStatus, responseHeaders, responseBody, capturedAt });
      } catch { /* catalogue errors should not break traffic ingest */ }
    }

    // Broadcast to WebSocket clients — truncate responseBody to 10KB
    const MAX_BROADCAST_BODY = 10 * 1024;
    let broadcastResponseBody = responseBody;
    if (broadcastResponseBody && broadcastResponseBody.length > MAX_BROADCAST_BODY) {
      broadcastResponseBody = broadcastResponseBody.slice(0, MAX_BROADCAST_BODY) + '…[truncated]';
    }

    const trafficMessage: TrafficEntryMessage = {
      type: 'traffic-entry',
      entry: {
        id: insertedId,
        sessionId,
        deviceId,
        requestMethod,
        requestUrl,
        requestHeaders,
        requestBody,
        responseStatus,
        responseHeaders,
        responseBody: broadcastResponseBody,
        capturedAt: capturedAt.toISOString(),
        flowId: req.body.id || undefined,
        matchedRules: matchedRulesRaw && matchedRulesRaw.length > 0 ? matchedRulesRaw : undefined,
        responseContentType,
        hasImage: !!responseBodyBinary,
      },
    };
    broadcastToAll(trafficMessage);

    res.json({ success: true, filtered: false });
  }, { requires: ['core.traffic:manage'] });

  // GET /v1/traffic/list — list traffic with filtering & pagination
  registerEndpoint('GET', '/v1/traffic/list', (req, res) => {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const deviceId = req.query.deviceId as string | undefined;
    const sessionId = req.query.sessionId ? parseInt(req.query.sessionId as string, 10) : undefined;
    const hostname = req.query.hostname as string | undefined;
    const method = req.query.method as string | undefined;
    const status = req.query.status ? parseInt(req.query.status as string, 10) : undefined;
    const pathFilter = req.query.path as string | undefined;
    const typeFilter = req.query.type as string | undefined;
    const sortBy = req.query.sortBy as string | undefined;
    const sortDir = (req.query.sortDir as string | undefined) === 'asc' ? 'asc' : 'desc';
    const search = req.query.search as string | undefined;

    const conditions: any[] = [];

    if (deviceId) {
      conditions.push(eq(capturedTraffic.deviceId, deviceId));
    }
    if (sessionId !== undefined && !isNaN(sessionId)) {
      conditions.push(eq(capturedTraffic.sessionId, sessionId));
    }
    if (method) {
      conditions.push(eq(capturedTraffic.requestMethod, method.toUpperCase()));
    }
    if (status !== undefined && !isNaN(status)) {
      // Treat the passed value as a century (200→2xx, 300→3xx, etc.)
      const century = Math.floor(status / 100);
      conditions.push(
        and(
          gte(capturedTraffic.responseStatus, century * 100),
          lt(capturedTraffic.responseStatus, (century + 1) * 100),
        ),
      );
    }
    if (typeFilter) {
      conditions.push(eq(capturedTraffic.type, typeFilter));
    }
    if (search) {
      const pattern = `%${search}%`;
      conditions.push(or(
        like(capturedTraffic.requestUrl, pattern),
        like(capturedTraffic.requestBody, pattern),
        like(capturedTraffic.responseBody, pattern),
        like(capturedTraffic.requestHeaders, pattern),
        like(capturedTraffic.responseHeaders, pattern),
      ));
    }

    // When hostname filter contains only simple chars (alphanumeric, dots, hyphens),
    // push it down to SQL via LIKE on the indexed hostname column.
    const REGEX_META = /[\\^$.|?*+()[\]{}]/;
    let hostnameInSql = false;
    if (hostname && !REGEX_META.test(hostname)) {
      conditions.push(like(capturedTraffic.hostname, `%${hostname}%`));
      hostnameInSql = true;
    }

    const whereClause = conditions.length > 0
      ? conditions.length === 1
        ? conditions[0]
        : and(...conditions)
      : undefined;

    // When no JS-only filters are needed, use SQL-level sorting & pagination
    const needsJsFilter = (!!hostname && !hostnameInSql) || !!pathFilter;

    if (!needsJsFilter) {
      const countQuery = db.select({ count: sql<number>`count(*)` }).from(capturedTraffic);
      const total = (whereClause ? countQuery.where(whereClause) : countQuery).all()[0].count;

      const dirFn = sortDir === 'asc' ? asc : desc;
      const orderExpr = sortBy === 'bodySize'
        ? desc(sql`length(response_body)`)
        : sortBy === 'requestMethod'
          ? dirFn(capturedTraffic.requestMethod)
          : sortBy === 'requestUrl'
            ? dirFn(capturedTraffic.requestUrl)
            : sortBy === 'responseStatus'
              ? dirFn(capturedTraffic.responseStatus)
              : dirFn(capturedTraffic.capturedAt);

      const dataQuery = db.select().from(capturedTraffic);
      const results = (whereClause ? dataQuery.where(whereClause) : dataQuery)
        .orderBy(orderExpr)
        .limit(limit)
        .offset(offset)
        .all();

      res.json({ data: { items: results.map(r => stripBinaryFields(parseMatchedRules(r))), total, limit, offset } });
      return;
    }

    // Fallback: JS filtering for hostname/path regex
    let results = whereClause
      ? db.select().from(capturedTraffic).where(whereClause).all()
      : db.select().from(capturedTraffic).all();

    if (hostname && !hostnameInSql) {
      try {
        const hostnameRegex = new RegExp(hostname);
        results = results.filter((r) => {
          // Use the pre-extracted hostname column; fall back to URL parsing
          const h = r.hostname ?? (() => { try { return new URL(r.requestUrl).hostname; } catch { return ''; } })();
          return hostnameRegex.test(h);
        });
      } catch {
        // Invalid regex, skip filter
      }
    }

    if (pathFilter) {
      try {
        const pathRegex = new RegExp(pathFilter);
        results = results.filter((r) => {
          try {
            const urlObj = new URL(r.requestUrl);
            return pathRegex.test(urlObj.pathname);
          } catch {
            return false;
          }
        });
      } catch {
        // Invalid regex, skip
      }
    }

    // Sort
    const dirMul = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'bodySize') {
      results.sort((a, b) => {
        const sizeA = a.responseBody ? a.responseBody.length : 0;
        const sizeB = b.responseBody ? b.responseBody.length : 0;
        return (sizeB - sizeA); // bodySize always desc (largest first)
      });
    } else if (sortBy === 'requestMethod') {
      results.sort((a, b) => dirMul * (a.requestMethod ?? '').localeCompare(b.requestMethod ?? ''));
    } else if (sortBy === 'requestUrl') {
      results.sort((a, b) => dirMul * (a.requestUrl ?? '').localeCompare(b.requestUrl ?? ''));
    } else if (sortBy === 'responseStatus') {
      results.sort((a, b) => dirMul * ((a.responseStatus ?? 0) - (b.responseStatus ?? 0)));
    } else {
      results.sort((a, b) => {
        const timeA = a.capturedAt ? new Date(a.capturedAt).getTime() : 0;
        const timeB = b.capturedAt ? new Date(b.capturedAt).getTime() : 0;
        return dirMul * (timeB - timeA);
      });
    }

    const total = results.length;
    const paged = results.slice(offset, offset + limit);

    res.json({
      data: {
        items: paged.map(r => stripBinaryFields(parseMatchedRules(r))),
        total,
        limit,
        offset,
      },
    });
  }, { requires: ['core.traffic:read'] });

  // GET /v1/traffic/view/:id — full request/response detail
  registerEndpoint('GET', '/v1/traffic/view/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid traffic id' });
      return;
    }

    const entry = db.select().from(capturedTraffic).where(eq(capturedTraffic.id, id)).all()[0];
    if (!entry) {
      res.status(404).json({ success: false, error: 'Traffic entry not found' });
      return;
    }

    if (entry.type === 'websocket') {
      const wsMessages = db.select().from(websocketMessages)
        .where(eq(websocketMessages.trafficId, id))
        .all();
      wsMessages.sort((a, b) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timeA - timeB;
      });
      res.json({ success: true, data: { ...stripBinaryFields(parseMatchedRules(entry)), wsMessages: wsMessages.slice(0, 50) } });
      return;
    }

    res.json({ success: true, data: stripBinaryFields(parseMatchedRules(entry)) });
  }, { requires: ['core.traffic:read'] });

  // GET /v1/traffic/:id/image — serve raw image bytes for preview
  registerEndpoint('GET', '/v1/traffic/:id/image', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid traffic id' });
      return;
    }

    const entry = db.select({
      responseBodyBinary: capturedTraffic.responseBodyBinary,
      responseContentType: capturedTraffic.responseContentType,
    }).from(capturedTraffic).where(eq(capturedTraffic.id, id)).all()[0];

    if (!entry || !entry.responseBodyBinary) {
      res.status(404).json({ success: false, error: 'No image data available' });
      return;
    }

    const buf = entry.responseBodyBinary as Buffer;

    // Validate image magic bytes
    const validImage = (
      // PNG
      (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) ||
      // JPEG
      (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ||
      // GIF87a / GIF89a
      (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) ||
      // WebP (RIFF....WEBP)
      (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) ||
      // BMP
      (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) ||
      // ICO
      (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) ||
      // SVG (text-based, verify content contains <svg tag)
      (entry.responseContentType && entry.responseContentType.includes('svg') &&
        buf.toString('utf8', 0, Math.min(buf.length, 500)).includes('<svg'))
    );

    if (!validImage) {
      res.status(404).json({ success: false, error: 'Stored data is not a recognised image format' });
      return;
    }

    const contentType = entry.responseContentType || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    // Prevent script execution in SVG files served inline
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.end(buf);
  }, { requires: ['core.traffic:read'] });

  // GET /v1/traffic/search — find latest successful request matching URL pattern
  //
  // Old implementation loaded the entire captured_traffic table into heap
  // (including response_body blobs) and filtered in JS. Under an AI session
  // with thousands of captured entries this easily reached hundreds of MB
  // per request. New implementation:
  //   1. Apply status + hostname-substring filter in SQL
  //   2. Extract a literal prefix from the user's regex via SQL LIKE
  //   3. Fetch metadata-only columns (no body blobs)
  //   4. Order DESC + LIMIT at SQL level — iterate in JS until the regex matches
  //   5. Once matched, refetch the single full row to get bodies
  registerEndpoint('GET', '/v1/traffic/search', (req, res) => {
    const urlPattern = req.query.url as string | undefined;
    const statusFilter = req.query.status ? parseInt(req.query.status as string, 10) : undefined;

    if (!urlPattern) {
      res.status(400).json({ success: false, error: 'url query parameter is required' });
      return;
    }

    let urlRegex: RegExp;
    try {
      urlRegex = new RegExp(urlPattern);
    } catch {
      res.status(400).json({ success: false, error: 'Invalid URL pattern regex' });
      return;
    }

    // Build a LIKE pre-filter from the longest literal run in the user's regex.
    // Regex metachars split the pattern; we take the longest alphanumeric-ish
    // chunk and wrap it in wildcards. Worst case (pattern is pure metachars)
    // we skip the LIKE and rely on status + LIMIT alone.
    const literalChunks = urlPattern.split(/[\\^$.|?*+()[\]{}]+/).filter(s => s.length > 2);
    const longestLiteral = literalChunks.sort((a, b) => b.length - a.length)[0];

    // Status filter — default to 2xx only, matching old behaviour
    const statusClause = statusFilter !== undefined && !isNaN(statusFilter)
      ? eq(capturedTraffic.responseStatus, statusFilter)
      : and(
          gte(capturedTraffic.responseStatus, 200),
          lt(capturedTraffic.responseStatus, 300),
        );

    const whereClause = longestLiteral
      ? and(statusClause, like(capturedTraffic.requestUrl, `%${longestLiteral}%`))
      : statusClause;

    // Fetch metadata only (no body blobs) — response_body alone can be MBs.
    // LIMIT 500 is plenty: we only need the latest match, and the sort is
    // descending so earlier rows are always newer.
    const candidates = db
      .select({
        id: capturedTraffic.id,
        requestUrl: capturedTraffic.requestUrl,
        responseStatus: capturedTraffic.responseStatus,
        capturedAt: capturedTraffic.capturedAt,
      })
      .from(capturedTraffic)
      .where(whereClause)
      .orderBy(desc(capturedTraffic.capturedAt))
      .limit(500)
      .all();

    // Apply the precise regex to the narrow candidate set
    const match = candidates.find(c => urlRegex.test(c.requestUrl));

    if (!match) {
      res.status(404).json({ success: false, error: 'No matching traffic found' });
      return;
    }

    // Fetch the full row (with bodies) for the matched id
    const full = db
      .select()
      .from(capturedTraffic)
      .where(eq(capturedTraffic.id, match.id))
      .get();

    if (!full) {
      res.status(404).json({ success: false, error: 'Matched row disappeared (race)' });
      return;
    }

    res.json({ success: true, data: stripBinaryFields(full) });
  }, { requires: ['core.traffic:read'] });

  // GET /v1/traffic/rules — list filter rules
  registerEndpoint('GET', '/v1/traffic/rules', (_req, res) => {
    res.json(getFilterRules());
  }, { requires: ['core.traffic:read'] });

  // POST /v1/traffic/rules — add filter rule
  registerEndpoint('POST', '/v1/traffic/rules', (req, res) => {
    const { hostname, path, maxContentSize, contentType } = req.body;

    if (!hostname && !path && maxContentSize === undefined && !contentType) {
      res.status(400).json({ success: false, error: 'At least one filter condition is required' });
      return;
    }

    const rule = addFilterRule({ hostname, path, maxContentSize, contentType });
    res.status(201).json({ success: true, data: rule });
  }, { requires: ['core.traffic:manage'] });

  // DELETE /v1/traffic/rules/:id — remove filter rule
  registerEndpoint('DELETE', '/v1/traffic/rules/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid rule id' });
      return;
    }

    if (removeFilterRule(id)) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Rule not found' });
    }
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/traffic/ws-start — open a new WebSocket connection entry (idempotent)
  registerEndpoint('POST', '/v1/traffic/ws-start', (req, res) => {
    const { flowId, url, headers, deviceId, sessionId } = req.body;
    if (!flowId || !url) {
      res.status(400).json({ success: false, error: 'flowId and url are required' });
      return;
    }

    // Idempotent: if this flow is already registered, return success
    if (wsFlowMap.has(flowId)) {
      res.json({ success: true, existing: true });
      return;
    }

    const capturedAt = new Date();
    const result = db.insert(capturedTraffic).values({
      sessionId: sessionId || null,
      deviceId: deviceId || null,
      requestMethod: 'GET',
      requestUrl: url,
      requestHeaders: headers ? JSON.stringify(headers) : null,
      requestBody: null,
      responseStatus: 101,
      responseBody: null,
      type: 'websocket',
      wsMessageCount: 0,
      capturedAt,
    }).run();

    const insertedId = Number(result.lastInsertRowid);
    wsFlowMap.set(flowId, insertedId);

    const trafficMessage: TrafficEntryMessage = {
      type: 'traffic-entry',
      entry: {
        id: insertedId,
        sessionId: sessionId || null,
        deviceId: deviceId || null,
        requestMethod: 'GET',
        requestUrl: url,
        requestHeaders: headers ? JSON.stringify(headers) : null,
        requestBody: null,
        responseStatus: 101,
        responseHeaders: null,
        responseBody: null,
        trafficType: 'websocket',
        wsMessageCount: 0,
        capturedAt: capturedAt.toISOString(),
      },
    };
    broadcastToAll(trafficMessage);

    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/traffic/ws-message — record a WebSocket frame
  registerEndpoint('POST', '/v1/traffic/ws-message', (req, res) => {
    const { flowId, direction, opcode, payload, isBinary, payloadSize, deviceId, sessionId } = req.body;
    const trafficId = wsFlowMap.get(flowId);
    if (trafficId === undefined) {
      res.status(404).json({ success: false, error: 'Unknown WebSocket flow' });
      return;
    }

    const timestamp = new Date();
    const msgResult = db.insert(websocketMessages).values({
      trafficId,
      sessionId: sessionId || null,
      deviceId: deviceId || null,
      direction: direction || 'receive',
      opcode: opcode || 'text',
      payload: payload || null,
      isBinary: isBinary || false,
      payloadSize: payloadSize || 0,
      timestamp,
    }).run();

    db.update(capturedTraffic)
      .set({ wsMessageCount: sql`ws_message_count + 1` })
      .where(eq(capturedTraffic.id, trafficId))
      .run();

    const frameMessage: WebSocketFrameMessage = {
      type: 'ws-frame',
      trafficId,
      frame: {
        id: Number(msgResult.lastInsertRowid),
        direction: direction || 'receive',
        opcode: opcode || 'text',
        payload: payload || null,
        isBinary: isBinary || false,
        payloadSize: payloadSize || 0,
        timestamp: timestamp.toISOString(),
      },
    };
    broadcastToAll(frameMessage);

    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/traffic/ws-end — close a WebSocket connection
  registerEndpoint('POST', '/v1/traffic/ws-end', (req, res) => {
    const { flowId, closeCode, closeReason, messageCount } = req.body;
    const trafficId = wsFlowMap.get(flowId);
    if (trafficId === undefined) {
      res.status(404).json({ success: false, error: 'Unknown WebSocket flow' });
      return;
    }

    db.update(capturedTraffic)
      .set({
        wsCloseCode: closeCode ?? null,
        wsCloseReason: closeReason ?? null,
        wsMessageCount: messageCount ?? 0,
      })
      .where(eq(capturedTraffic.id, trafficId))
      .run();

    wsFlowMap.delete(flowId);

    const closedMessage: WebSocketConnectionClosedMessage = {
      type: 'ws-connection-closed',
      trafficId,
      closeCode: closeCode ?? null,
      closeReason: closeReason ?? null,
      messageCount: messageCount ?? 0,
    };
    broadcastToAll(closedMessage);

    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });

  // GET /v1/traffic/ws-messages/:trafficId — list WebSocket frames for a connection
  registerEndpoint('GET', '/v1/traffic/ws-messages/:trafficId', (req, res) => {
    const trafficId = parseInt(req.params.trafficId, 10);
    if (isNaN(trafficId)) {
      res.status(400).json({ success: false, error: 'Invalid traffic id' });
      return;
    }

    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const directionFilter = req.query.direction as string | undefined;

    const conditions: any[] = [eq(websocketMessages.trafficId, trafficId)];
    if (directionFilter) {
      conditions.push(eq(websocketMessages.direction, directionFilter));
    }

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    const total = db.select({ count: sql<number>`count(*)` })
      .from(websocketMessages).where(whereClause).all()[0].count;

    const results = db.select().from(websocketMessages)
      .where(whereClause)
      .orderBy(asc(websocketMessages.timestamp))
      .limit(limit)
      .offset(offset)
      .all();

    res.json({
      data: {
        items: results,
        total,
        limit,
        offset,
      },
    });
  }, { requires: ['core.traffic:read'] });
}
