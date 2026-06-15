import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import { URL } from 'url';
import { handleWebSocketRestApi } from '../api/api-service';
import { getWebsocketHandler, registerWebsocketEndpoint } from './handlers';
import { createLoggers } from '../logs';
import { scopeMatches } from '../auth/scope-matcher';
import type { SessionManager } from '../auth/session-manager';
import { users } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { isFilteredChannel, getRequiredScopes } from './channel-registry';
import { verifyOrigin, buildDefaultAllowedOrigins, parseAllowedOriginsEnv } from './origin-check';

const { log, error } = createLoggers('websocket');

registerWebsocketEndpoint('__ws:subscribe', (message: any, socket: any) => {
  const channels: string[] = Array.isArray(message.channels) ? message.channels : [];
  const subs: Set<string> = socket.subscriptions ?? (socket.subscriptions = new Set());
  const authUser = socket.authUser;
  for (const ch of channels) {
    if (typeof ch !== 'string' || ch.length === 0) continue;
    const required = getRequiredScopes(ch);
    if (required.length > 0) {
      if (!authUser) {
        log(`ws subscribe denied: no auth, channel=${ch}`);
        continue;
      }
      const missing = required.filter((s) => !scopeMatches(authUser.effectiveScopes, s));
      if (missing.length > 0) {
        log(`ws subscribe denied: user=${authUser.username ?? '?'} channel=${ch} missing=${missing.join(',')}`);
        continue;
      }
    }
    subs.add(ch);
  }
});

registerWebsocketEndpoint('__ws:unsubscribe', (message: any, socket: any) => {
  const channels: string[] = Array.isArray(message.channels) ? message.channels : [];
  const subs: Set<string> | undefined = socket.subscriptions;
  if (!subs) return;
  for (const ch of channels) {
    if (typeof ch === 'string') subs.delete(ch);
  }
});

const connectedClients = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

// Startup progress tracking
let currentStartupPhase: 'initializing' | 'preparing_python' | 'starting_services' | 'ready' = 'initializing';
let currentStartupMessage = 'Initializing...';

export function setStartupPhase(
  phase: typeof currentStartupPhase,
  message: string,
): void {
  currentStartupPhase = phase;
  currentStartupMessage = message;
  broadcastToAll({
    type: 'startup-progress',
    phase,
    message,
  });
}

export function isServerReady(): boolean {
  return currentStartupPhase === 'ready';
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  }
  return cookies;
}

export function setupWebSocket(
  server: HttpServer,
  sessionManager?: SessionManager,
  db?: AppDatabase,
  opts?: { allowedOrigins?: string[] },
): WebSocketServer {
  // CSWSH defence: reject WS upgrades from non-allow-listed Origins. See
  // origin-check.ts for the threat model. Default allowlist covers same-host
  // + Vite dev origin; operators can extend via WEBSOCKET_ALLOWED_ORIGINS.
  const envOrigins = parseAllowedOriginsEnv(process.env.WEBSOCKET_ALLOWED_ORIGINS);
  const defaultOrigins = buildDefaultAllowedOrigins(
    process.env.HOST || '127.0.0.1',
    parseInt(process.env.PORT || '3000', 10),
  );
  const allowedOrigins = opts?.allowedOrigins ?? [...defaultOrigins, ...envOrigins];

  // Use noServer mode so the upgrade event is handled by our shared router
  // below, keeping all path dispatch in one place.
  wss = new WebSocketServer({ noServer: true });

  // Shared upgrade router: a single 'upgrade' listener dispatches to the
  // right WSS instance based on the request path.
  const routes = new Map<string, WebSocketServer>([['/ws', wss]]);

  server.on('upgrade', (req, socket, head) => {
    // Origin allow-list check (CSWSH defence) — was previously handled by
    // the verifyClient callback in the WSS constructor options.
    if (!verifyOrigin(req.headers.origin, allowedOrigins)) {
      log(`ws upgrade rejected: disallowed origin "${req.headers.origin}" — add it to WEBSOCKET_ALLOWED_ORIGINS env var to allow (current allowlist: ${allowedOrigins.join(',') || '(empty=disabled)'})`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const path = (req.url ?? '/').split('?')[0];
    const target = routes.get(path);
    if (!target) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => {
      target.emit('connection', ws, req);
    });
  });

  wss.on('connection', (socket: WebSocket, req) => {
    // Authenticate the WebSocket connection via session cookie
    const cookieHeader = req.headers.cookie || '';
    const cookies = parseCookies(cookieHeader);
    const sessionId = cookies.darkride_sid;

    if (sessionId && sessionManager) {
      const session = sessionManager.validate(sessionId);
      if (session) {
        (socket as any).authUser = {
          userId: session.userId,
          username: session.username,
          effectiveScopes: new Set(session.scopes),
          sessionId: session.id,
          via: 'session' as const,
        };
      }
    }

    // If no auth, check if auth is required (users table has entries)
    if (!(socket as any).authUser && db) {
      const hasUsers = db.select({ id: users.id }).from(users).limit(1).get();
      if (hasUsers) {
        socket.close(4001, 'Authentication required');
        return;
      }
    }

    connectedClients.add(socket);
    (socket as any).subscriptions = new Set<string>();
    log(`Client connected (${connectedClients.size} total)`);

    // Send current startup state immediately
    socket.send(JSON.stringify({
      type: 'startup-progress',
      phase: currentStartupPhase,
      message: currentStartupMessage,
    }));

    socket.on('message', async (data) => {
      let message: any;
      try {
        message = JSON.parse(data.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      const action = message.action;
      if (!action) {
        socket.send(JSON.stringify({ type: 'error', error: 'Missing action field' }));
        return;
      }

      if (action === 'restapi') {
        await handleWebSocketRestApi(
          message.method || 'GET',
          message.path || '/',
          message.body,
          message.id || '',
          socket,
          (socket as any).authUser,
        );
        return;
      }

      // Route to registered WebSocket-only handlers
      const entry = getWebsocketHandler(action);
      if (entry) {
        // Check scope requirements
        if (entry.requires && entry.requires.length > 0) {
          const authUser = (socket as any).authUser;
          if (!authUser) {
            socket.send(JSON.stringify({ type: 'error', error: 'Authentication required' }));
            return;
          }
          const missing = entry.requires.filter((s: string) => !scopeMatches(authUser.effectiveScopes, s));
          if (missing.length > 0) {
            socket.send(JSON.stringify({ type: 'error', error: 'Insufficient scope', required: entry.requires, missing }));
            return;
          }
        }
        try {
          await entry.handler(message, socket);
        } catch (err: any) {
          error(`WebSocket handler error for action "${action}": ${err.message}`);
        }
      } else {
        socket.send(JSON.stringify({ type: 'error', error: `Unknown action: ${action}` }));
      }
    });

    socket.on('close', () => {
      connectedClients.delete(socket);
      log(`Client disconnected (${connectedClients.size} total)`);
    });

    socket.on('error', (err) => {
      error(`WebSocket error: ${err.message}`);
      connectedClients.delete(socket);
    });
  });

  log('WebSocket server initialized');
  return wss;
}

export function getConnectedClients(): Set<WebSocket> {
  return connectedClients;
}

type BroadcastListener = (message: any) => void;
const broadcastListeners: BroadcastListener[] = [];

export function onBroadcast(listener: BroadcastListener): () => void {
  broadcastListeners.push(listener);
  return () => {
    const idx = broadcastListeners.indexOf(listener);
    if (idx >= 0) broadcastListeners.splice(idx, 1);
  };
}

export function broadcastToAll(message: Record<string, any>): void {
  const channelType = typeof message?.type === 'string' ? message.type : null;
  const filtered = channelType !== null && isFilteredChannel(channelType);
  const data = JSON.stringify(message);

  for (const client of connectedClients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (filtered) {
      const subs = (client as any).subscriptions as Set<string> | undefined;
      if (!subs || !subs.has(channelType as string)) continue;
    }
    client.send(data);
  }
  // Notify in-process listeners (e.g., notification service) — these are
  // never filtered; they're internal consumers, not WS clients.
  for (const listener of broadcastListeners) {
    try { listener(message); } catch (err: any) { error(`Broadcast listener error: ${err.message}`); }
  }
}

export function getWebSocketServer(): WebSocketServer | null {
  return wss;
}
