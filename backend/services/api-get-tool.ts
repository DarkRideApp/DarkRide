import type { Request, Response } from 'express';
import { getRegisteredEndpoints, pathToRegex } from '../api/api-service';
import { scopeMatches } from '../auth/scope-matcher';
import type { AiToolRegistry, ToolCaller } from './ai-tools';

/**
 * `darkride_api_get`: a read-only window onto DarkRide's own REST routes for
 * MCP clients, so a session can read a plugin's list/status endpoints without
 * a purpose-built tool for each one.
 *
 * Why an allow-list and not a deny-list: with 300+ routes and plugin routes
 * we do not control, a deny-list cannot be shown complete, and a route that
 * returns more than its MCP counterpart would slip through it. A
 * route is reachable here only if its path is on API_GET_ALLOWED_PREFIXES,
 * and a prefix goes on that list only after its GET handlers have been read.
 *
 * The call runs in process against the registered endpoint table (the same
 * one the WebSocket REST bridge uses), so it cannot reach anything that was
 * not registered with registerEndpoint, cannot use another method, and cannot
 * leave the host. The caller's own scopes are enforced against each route's
 * `requires`, and the tool refuses to run without a caller identity.
 */

/** Longest body returned, in characters. Anything past it is cut with a marker. */
export const API_GET_MAX_CHARS = 60_000;

/** How long a handler may take before the call answers 504. */
export const API_GET_TIMEOUT_MS = 15_000;

const MAX_PATH_CHARS = 512;

/**
 * Path prefixes reachable through the tool. Each entry matches itself and
 * anything below it on a segment boundary. Add to this list only after
 * reading every GET handler under the prefix for sensitive output, and add a
 * case to api-get-tool.test.ts.
 */
export const API_GET_ALLOWED_PREFIXES: readonly string[] = [
  '/disney-menus', // plugin: queue status, target list, change log (no credentials)
  '/v1/system/status',
  '/v1/plugins/list', // name + version only
  '/v1/plugins/registry',
];

/**
 * Second layer under the allow-list: any path segment that looks like it
 * names a secret is refused even under an allowed prefix, so a later route
 * such as `/disney-menus/token` is not exposed by accident.
 */
const SECRET_SEGMENT =
  /(^|[/_.-])(credentials?|secrets?|tokens?|passwords?|passwd|api-?keys?|oauth|auth|private-?keys?|keystores?|certs?)($|[/_.-])/;

export interface ApiGetInput {
  path: unknown;
  query?: unknown;
}

export interface ApiGetResult {
  status: number;
  body: unknown;
  /** Set when the body was cut to API_GET_MAX_CHARS. */
  truncated?: true;
  /** Length of the full body in characters; set only when truncated. */
  totalChars?: number;
}

type PathCheck = { ok: true; path: string } | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Accept only a plain absolute path. Rejects anything that could change the
 * target: schemes and hosts (`//host`), dot segments (raw or encoded), encoded
 * separators, backslashes, a query or fragment, and double encoding.
 */
export function validateApiGetPath(path: unknown): PathCheck {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: 'path must be a non-empty string' };
  }
  if (path.length > MAX_PATH_CHARS) {
    return { ok: false, error: `path is longer than ${MAX_PATH_CHARS} characters` };
  }
  if (!path.startsWith('/')) {
    return { ok: false, error: 'path must start with /' };
  }
  if (CONTROL_CHARS.test(path) || /[\\?#]/.test(path)) {
    return { ok: false, error: 'path must not contain control characters, backslashes, ? or # (pass query as an object)' };
  }

  const segments = path.slice(1).split('/');
  for (const raw of segments) {
    if (raw === '') return { ok: false, error: 'path must not contain empty segments' };
    if (raw === '.' || raw === '..') return { ok: false, error: 'path must not contain dot segments' };

    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { ok: false, error: 'path contains a malformed percent escape' };
    }
    if (decoded === '.' || decoded === '..') {
      return { ok: false, error: 'path must not contain encoded dot segments' };
    }
    if (/[/\\]/.test(decoded) || CONTROL_CHARS.test(decoded)) {
      return { ok: false, error: 'path must not contain encoded separators or control characters' };
    }
    if (/%[0-9a-f]{2}/i.test(decoded)) {
      return { ok: false, error: 'path must not be double encoded' };
    }
  }
  return { ok: true, path };
}

/** Is this (already validated) path reachable through the tool? */
export function isApiGetAllowed(path: string): boolean {
  const checked = validateApiGetPath(path);
  if (!checked.ok) return false;

  const decoded = '/' + path.slice(1).split('/').map(decodeURIComponent).join('/');
  const lower = decoded.toLowerCase();

  if (SECRET_SEGMENT.test(lower)) return false;
  return API_GET_ALLOWED_PREFIXES.some((p) => lower === p || lower.startsWith(p + '/'));
}

function normaliseQuery(query: unknown): Record<string, string> {
  if (query === undefined || query === null) return {};
  if (typeof query !== 'object' || Array.isArray(query)) {
    throw new Error('query must be an object of string, number or boolean values');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`query key not allowed: ${key}`);
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`query value for "${key}" must be a string, number or boolean`);
    }
    out[key] = String(value);
  }
  return out;
}

/** Cap a body for the caller. Binary is replaced; oversize text/JSON is cut. */
function shapeBody(data: unknown): Pick<ApiGetResult, 'body' | 'truncated' | 'totalChars'> {
  if (data === undefined || data === null) return { body: null };
  if (Buffer.isBuffer(data)) return { body: `[binary body omitted: ${data.length} bytes]` };

  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      return { body: '[body could not be serialised]' };
    }
  }

  if (text.length <= API_GET_MAX_CHARS) return { body: data };
  return {
    body: `${text.slice(0, API_GET_MAX_CHARS)}\n[truncated: showing ${API_GET_MAX_CHARS} of ${text.length} characters]`,
    truncated: true,
    totalChars: text.length,
  };
}

/**
 * A Response stand-in that records status and body. Only the methods a plain
 * JSON/text handler needs exist; calling anything else (sendFile, write,
 * pipe, redirect, cookie) throws, which the caller reports as a 500 naming
 * the method, so a streaming or file route fails loudly instead of hanging.
 */
function captureResponse(finish: (status: number, data: unknown) => void): Response {
  let status = 200;
  let finished = false;
  const done = (data: unknown) => {
    if (finished) return;
    finished = true;
    finish(status, data);
  };

  const res: Record<string | symbol, unknown> = {
    locals: {},
    get statusCode() { return status; },
    set statusCode(v: number) { status = v; },
    get headersSent() { return finished; },
    status(code: number) { status = code; return proxy; },
    sendStatus(code: number) { status = code; done(String(code)); return proxy; },
    json(data: unknown) { done(data); return proxy; },
    send(data: unknown) { done(data); return proxy; },
    end(data?: unknown) { done(data); return proxy; },
    set() { return proxy; },
    setHeader() { return proxy; },
    header() { return proxy; },
    type() { return proxy; },
    contentType() { return proxy; },
    append() { return proxy; },
    vary() { return proxy; },
    get() { return undefined; },
    getHeader() { return undefined; },
  };

  const proxy: Response = new Proxy(res, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return () => {
        throw new Error(`res.${prop}() is not supported by darkride_api_get`);
      };
    },
  }) as unknown as Response;
  return proxy;
}

function buildRequest(path: string, query: Record<string, string>, params: Record<string, string>, caller: ToolCaller): Request {
  const qs = new URLSearchParams(query).toString();
  return {
    method: 'GET',
    path,
    url: qs ? `${path}?${qs}` : path,
    originalUrl: qs ? `${path}?${qs}` : path,
    baseUrl: '',
    params,
    query,
    body: {},
    headers: {},
    get: () => undefined,
    header: () => undefined,
    authUser: {
      userId: caller.userId,
      username: caller.username,
      via: caller.via,
      effectiveScopes: new Set(caller.effectiveScopes),
    },
  } as unknown as Request;
}

function failure(status: number, error: string): ApiGetResult {
  return { status, body: { success: false, error } };
}

/**
 * Run one GET against the registered endpoint table.
 *
 * Throws for a bad request (no caller, bad path, bad query); answers with a
 * status for everything the route itself decides (403 not allowed or missing
 * scope, 404, 500, 504).
 */
export async function runApiGet(
  input: ApiGetInput,
  caller: ToolCaller | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<ApiGetResult> {
  if (!caller) {
    throw new Error('darkride_api_get needs an authenticated caller; it is only available over MCP');
  }
  const checked = validateApiGetPath(input.path);
  if (!checked.ok) throw new Error(`Invalid path: ${checked.error}`);
  const query = normaliseQuery(input.query);
  const path = checked.path;

  if (!isApiGetAllowed(path)) {
    return failure(
      403,
      `${path} is not available through darkride_api_get. Allowed prefixes: ${API_GET_ALLOWED_PREFIXES.join(', ')}`,
    );
  }

  const pathname = path;
  let matched: { handler: (req: Request, res: Response) => void | Promise<void>; requires?: string[]; params: Record<string, string> } | undefined;
  for (const endpoint of getRegisteredEndpoints()) {
    if (endpoint.method !== 'GET') continue;
    const { regex, paramNames } = pathToRegex(endpoint.path);
    const m = pathname.match(regex);
    if (!m) continue;
    const params: Record<string, string> = {};
    paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
    matched = { handler: endpoint.handler, requires: endpoint.opts?.requires, params };
    break;
  }
  if (!matched) return failure(404, `Not found: GET ${path}`);

  const missing = (matched.requires ?? []).filter((s) => !scopeMatches(caller.effectiveScopes, s));
  if (missing.length > 0) {
    return { status: 403, body: { success: false, error: 'Insufficient scope', required: matched.requires, missing } };
  }

  const timeoutMs = opts.timeoutMs ?? API_GET_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ApiGetResult>((resolve) => {
      timer = setTimeout(() => resolve(failure(504, `Handler did not respond within ${timeoutMs}ms`)), timeoutMs);
      const res = captureResponse((status, data) => resolve({ status, ...shapeBody(data) }));
      const req = buildRequest(path, query, matched!.params, caller);
      Promise.resolve()
        .then(() => matched!.handler(req, res))
        .catch((err: any) => resolve(failure(500, err?.message || 'Internal Server Error')));
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerApiGetTool(registry: AiToolRegistry): void {
  registry.register({
    name: 'darkride_api_get',
    description:
      'Read-only. Issue a GET against an allow-listed DarkRide REST route and return { status, body }. ' +
      'GET only: there is no way to send a method, body or headers. ' +
      `Allowed path prefixes: ${API_GET_ALLOWED_PREFIXES.join(', ')}. ` +
      'Paths containing credential, token, secret, password, api-key, oauth, auth or cert segments are always refused. ' +
      `Bodies over ${API_GET_MAX_CHARS} characters are cut and flagged truncated. ` +
      'Your own scopes are enforced against each route.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute route path such as /disney-menus/targets/12. No scheme, host, query string or "..".',
        },
        query: {
          type: 'object',
          description: 'Query parameters, e.g. { status: "failing", limit: 200 }.',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
        },
      },
      required: ['path'],
    },
    context: ['api'],
    async execute(params: ApiGetInput, ctx) {
      return runApiGet(params, ctx?.caller);
    },
  });
}
