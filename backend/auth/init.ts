import type { Express } from 'express';
import cookieParser from 'cookie-parser';
import { createAuthMiddleware, csrfProtection } from './middleware';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/**
 * Install auth middleware on the Express app.
 * Called from index.ts after DB is initialized.
 */
export function initAuth(app: Express, db: BetterSQLite3Database<any>): void {
  // Cookie parser must come before auth middleware
  app.use(cookieParser());

  const authMiddleware = createAuthMiddleware(db, [
    '/v1/auth',              // all auth endpoints (login, logout, me, providers, setup, claim)
    '/v1/automation/run',    // passcode-protected, own auth mechanism
    '/health',
    '/favicon.ico',
    '/favicon.svg',
    /^\/ui(\/|$)/,           // React SPA static files
    /^\/assets\//,           // built assets
    /^\/screenshots\//,      // screenshot images
    /^\/oauth(\/|$)/,        // OAuth endpoints (public — handled by OAuth layer)
    /^\/\.well-known\/oauth-/, // OAuth discovery endpoints
    '/mcp',                  // MCP endpoint — handler enforces auth + emits WWW-Authenticate
  ], [
    // Internal callbacks from mitmproxy bridge — only trusted over loopback.
    '/v1/traffic/ingest',
    '/v1/traffic/intercept',
    '/v1/traffic/request-started',
    '/v1/traffic/ws-start',
    '/v1/traffic/ws-message',
    '/v1/traffic/ws-end',
    '/v1/intercept/hold',    // interactive-intercept long-poll from the bridge
  ]);

  app.use(authMiddleware);
  app.use(csrfProtection);
}
