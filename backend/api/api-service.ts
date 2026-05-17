import { Router, Request, Response } from 'express';
import type { WebSocket } from 'ws';
import { scopeMatches } from '../auth/scope-matcher';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

interface EndpointOpts {
  requires?: string[];
  public?: boolean;
  csrfExempt?: boolean;
}

interface EndpointRegistration {
  method: HttpMethod;
  path: string;
  handler: (req: Request, res: Response) => void | Promise<void>;
  opts?: EndpointOpts;
}

const apiRouter = Router();
const registeredEndpoints: EndpointRegistration[] = [];

/**
 * Convert an Express-style path pattern (/v1/proxy/view/:id) to a regex
 * for matching incoming WebSocket restapi requests.
 */
function pathToRegex(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, paramName) => {
    paramNames.push(paramName);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

export function registerEndpoint(
  method: HttpMethod,
  path: string,
  handler: (req: Request, res: Response) => void | Promise<void>,
  opts?: EndpointOpts,
): void {
  registeredEndpoints.push({ method, path, handler, opts });

  const routeMethod = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
  apiRouter[routeMethod](path, async (req: Request, res: Response) => {
    try {
      // Scope check — only runs if authUser is present (auth middleware authenticated the request).
      // If authUser is undefined, the auth middleware already handled rejection or allowed through.
      if (opts?.requires && opts.requires.length > 0 && req.authUser) {
        const missing = opts.requires.filter(s => !scopeMatches(req.authUser!.effectiveScopes, s));
        if (missing.length > 0) {
          res.status(403).json({ success: false, error: 'Insufficient scope', required: opts.requires, missing });
          return;
        }
      }
      await handler(req, res);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
      }
    }
  });
}

/**
 * Route a REST-over-WebSocket request to the matching registered endpoint.
 */
export async function handleWebSocketRestApi(
  wsMethod: string,
  wsPath: string,
  wsBody: any,
  requestId: string,
  socket: WebSocket,
  authUser?: Request['authUser'],
): Promise<void> {
  const upperMethod = wsMethod.toUpperCase();
  const [pathname] = wsPath.split('?');

  for (const endpoint of registeredEndpoints) {
    if (endpoint.method !== upperMethod) continue;

    const { regex, paramNames } = pathToRegex(endpoint.path);
    // Parse query string from path
    const [, queryString] = wsPath.split('?');
    const match = pathname.match(regex);
    if (!match) continue;

    // Extract path params
    const params: Record<string, string> = {};
    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]] = decodeURIComponent(match[i + 1]);
    }

    // Parse query params
    const query: Record<string, string> = {};
    if (queryString) {
      for (const pair of queryString.split('&')) {
        const [key, val] = pair.split('=');
        if (key) query[decodeURIComponent(key)] = decodeURIComponent(val || '');
      }
    }

    // Build mock req
    const mockReq = {
      params,
      query,
      body: wsBody || {},
      method: upperMethod,
      path: pathname,
      authUser,
    } as unknown as Request;

    // Build mock res
    let statusCode = 200;
    let responded = false;

    const mockRes = {
      status(code: number) {
        statusCode = code;
        return mockRes;
      },
      json(data: any) {
        if (responded) return mockRes;
        responded = true;
        socket.send(JSON.stringify({
          type: 'restapi',
          id: requestId,
          status: statusCode,
          body: data,
        }));
        return mockRes;
      },
      send(data: any) {
        if (responded) return mockRes;
        responded = true;
        socket.send(JSON.stringify({
          type: 'restapi',
          id: requestId,
          status: statusCode,
          body: data,
        }));
        return mockRes;
      },
      // Support res.status(204).end() — sends an empty body response
      end() {
        if (responded) return mockRes;
        responded = true;
        socket.send(JSON.stringify({
          type: 'restapi',
          id: requestId,
          status: statusCode,
          body: null,
        }));
        return mockRes;
      },
      // Support res.set() for header manipulation (no-op in WS context)
      set(_field: string, _value?: string) {
        return mockRes;
      },
    } as unknown as Response;

    // Scope check for WS REST API — only runs if authUser is present
    if (endpoint.opts?.requires && endpoint.opts.requires.length > 0 && authUser) {
      const missing = endpoint.opts.requires.filter(s => !scopeMatches(authUser.effectiveScopes, s));
      if (missing.length > 0) {
        socket.send(JSON.stringify({
          type: 'restapi',
          id: requestId,
          status: 403,
          body: { success: false, error: 'Insufficient scope', required: endpoint.opts.requires, missing },
        }));
        return;
      }
    }

    try {
      await endpoint.handler(mockReq, mockRes);
    } catch (err: any) {
      if (!responded) {
        socket.send(JSON.stringify({
          type: 'restapi',
          id: requestId,
          status: 500,
          body: { success: false, error: err.message || 'Internal Server Error' },
        }));
      }
    }
    return;
  }

  // No matching endpoint found
  console.error(`[ws-restapi] No matching endpoint: ${upperMethod} ${pathname} (${registeredEndpoints.length} registered)`);
  socket.send(JSON.stringify({
    type: 'restapi',
    id: requestId,
    status: 404,
    body: { success: false, error: `Not found: ${upperMethod} ${pathname}` },
  }));
}

export function getApiRouter(): Router {
  return apiRouter;
}

export function getRegisteredEndpoints(): EndpointRegistration[] {
  return registeredEndpoints;
}

/**
 * Clear all registered endpoints (for testing).
 */
export function clearEndpoints(): void {
  registeredEndpoints.length = 0;
  // Reset the router by replacing route stack
  apiRouter.stack.length = 0;
}
