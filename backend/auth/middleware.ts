import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { sessions, users, apiKeys } from '../db/schema';
import { oauthAccessTokens } from '../db/oauth-schema';
import { scopeMatches } from './scope-matcher';
import { OAuthTokenManager } from './oauth-token-manager';
import { tokenPrefix } from './oauth-crypto';
import { createLoggers } from '../logs';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

const { log: authLog } = createLoggers('auth');

export interface AuthUser {
  userId: number;
  username: string;
  via: 'session' | 'apikey' | 'oauth';
  sessionId?: string;
  apiKeyId?: number;
  oauthTokenId?: number;
  effectiveScopes: Set<string>;
  csrfToken?: string;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

export function createAuthMiddleware(
  db: BetterSQLite3Database<any>,
  allowlist: Array<string | RegExp>,
  /**
   * Paths that bypass auth only when the request originates from the loopback
   * interface. Used for internal service-to-service callbacks (e.g. mitmproxy
   * bridge posting traffic to /v1/traffic/*). Safe even when HOST=0.0.0.0
   * because loopback source IPs can't be spoofed across the network.
   */
  loopbackOnlyPaths: string[] = [],
) {
  const isLoopback = (ip: string | undefined): boolean =>
    ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

  return function authenticateRequest(req: Request, res: Response, next: NextFunction): void {
    const path = req.path;

    // Loopback-only bypass — trust internal callbacks from the same host.
    // Lets the mitmproxy bridge post traffic without plumbing a token.
    for (const p of loopbackOnlyPaths) {
      if (path === p || path.startsWith(p + '/')) {
        if (isLoopback(req.ip)) { next(); return; }
        break;
      }
    }

    // Determine if this path is on the allowlist.
    // Allowlisted paths don't REQUIRE auth but still TRY to authenticate
    // if credentials are present — so endpoints like /v1/auth/me can return
    // different payloads for authenticated vs unauthenticated visitors.
    let isAllowlisted = false;
    for (const pattern of allowlist) {
      if (typeof pattern === 'string') {
        if (path === pattern || path.startsWith(pattern + '/')) {
          isAllowlisted = true;
          break;
        }
      }
      if (pattern instanceof RegExp && pattern.test(path)) {
        isAllowlisted = true;
        break;
      }
    }

    // Path 1: API key via Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer darkride_pat_')) {
      const keyPlain = authHeader.substring(7); // strip 'Bearer '
      const keyHash = createHash('sha256').update(keyPlain).digest('hex');

      const key = db.select().from(apiKeys)
        .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
        .get();

      if (!key) {
        if (isAllowlisted) { next(); return; }
        res.status(401).json({ success: false, error: 'Invalid API key' });
        return;
      }
      if (key.expiresAt && key.expiresAt < new Date()) {
        if (isAllowlisted) { next(); return; }
        res.status(401).json({ success: false, error: 'API key expired' });
        return;
      }

      const user = db.select().from(users).where(eq(users.id, key.userId)).get();
      if (!user || !user.enabled) {
        if (isAllowlisted) { next(); return; }
        res.status(401).json({ success: false, error: 'API key owner is disabled' });
        return;
      }

      // Intersection invariant: effective = key.scopes ∩ user.scopes
      const userScopes = new Set((Array.isArray(user.scopes) ? user.scopes : JSON.parse(user.scopes as any)) as string[]);
      const keyScopes = (Array.isArray(key.scopes) ? key.scopes : JSON.parse(key.scopes as any)) as string[];
      const effective = new Set(
        keyScopes.filter((ks: string) => scopeMatches(userScopes, ks)),
      );

      // Update lastUsedAt only if >60s since last update (reduce write churn)
      if (!key.lastUsedAt || Date.now() - new Date(key.lastUsedAt).getTime() > 60_000) {
        db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).run();
      }

      req.authUser = {
        userId: user.id,
        username: user.username,
        via: 'apikey',
        apiKeyId: key.id,
        effectiveScopes: effective,
      };
      next();
      return;
    }

    // Path 1.5: OAuth access token via Authorization header
    if (authHeader && authHeader.startsWith('Bearer oauth_at_')) {
      const tokenPlain = authHeader.substring(7); // strip 'Bearer '
      const tokenMgr = new OAuthTokenManager(db);
      const tokenRow = tokenMgr.findAccessTokenByPlaintext(tokenPlain);
      if (!tokenRow) {
        // Diagnostic: classify WHY the presented token was rejected so we can
        // tell expired vs revoked vs unknown when chasing re-auth churn.
        authLog(`OAuth token rejected: prefix=${tokenPrefix(tokenPlain)} reason=${tokenMgr.classifyAccessToken(tokenPlain)} method=${req.method} path=${req.path}`);
        if (isAllowlisted) { next(); return; }
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const user = db.select().from(users).where(eq(users.id, tokenRow.userId)).get();
      if (!user || !user.enabled) {
        if (isAllowlisted) { next(); return; }
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const userScopes = new Set((Array.isArray(user.scopes) ? user.scopes : JSON.parse(user.scopes as any)) as string[]);
      const tokenScopes: string[] = JSON.parse(tokenRow.scopes || '[]');
      // `mcp` scope grants the user's full scope set; future scope-specific logic can refine
      const effective = tokenScopes.includes('mcp')
        ? userScopes
        : new Set(tokenScopes.filter((s) => userScopes.has(s)));

      if (!tokenRow.lastUsedAt || Date.now() - tokenRow.lastUsedAt.getTime() > 60_000) {
        db.update(oauthAccessTokens).set({ lastUsedAt: new Date() })
          .where(eq(oauthAccessTokens.id, tokenRow.id)).run();
      }

      req.authUser = {
        userId: user.id,
        username: user.username,
        effectiveScopes: effective,
        via: 'oauth',
        oauthTokenId: tokenRow.id,
      };
      next();
      return;
    }

    // Path 2: Session via cookie
    const sessionId = req.cookies?.darkride_sid;
    if (sessionId) {
      const row = db
        .select({
          sId: sessions.id,
          userId: sessions.userId,
          csrfToken: sessions.csrfToken,
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
          username: users.username,
          userScopes: users.scopes,
          userEnabled: users.enabled,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.id, sessionId))
        .get();

      if (row && !row.revokedAt && row.expiresAt > new Date() && row.userEnabled) {
        const scopes = (Array.isArray(row.userScopes) ? row.userScopes : JSON.parse(row.userScopes as any)) as string[];
        req.authUser = {
          userId: row.userId,
          username: row.username,
          via: 'session',
          sessionId: row.sId,
          effectiveScopes: new Set(scopes),
          csrfToken: row.csrfToken,
        };
        next();
        return;
      }
    }

    // No valid auth — reject unless allowlisted
    if (isAllowlisted) {
      next();
      return;
    }
    res.status(401).json({ success: false, error: 'Authentication required' });
  };
}

/**
 * Express middleware factory: checks that req.authUser has ALL the required scopes.
 */
export function requireScope(...scopes: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const missing = scopes.filter(s => !scopeMatches(req.authUser!.effectiveScopes, s));
    if (missing.length > 0) {
      res.status(403).json({
        success: false,
        error: 'Insufficient scope',
        required: scopes,
        missing,
      });
      return;
    }
    next();
  };
}

/**
 * CSRF protection. Checks X-CSRF-Token on mutating requests.
 * Skips for API key auth (non-browser).
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (req.authUser?.via === 'apikey' || req.authUser?.via === 'oauth') { next(); return; }
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
  if (!req.authUser) { next(); return; }

  const token = req.headers['x-csrf-token'] as string | undefined;
  if (!token || token !== req.authUser.csrfToken) {
    res.status(403).json({ success: false, error: 'Invalid CSRF token' });
    return;
  }
  next();
}
