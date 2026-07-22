import { registerEndpoint } from './api-service';
import { authenticateLocal, AuthenticationError } from '../auth/providers/local';
import { SessionManager } from '../auth/session-manager';
import { ClaimManager } from '../auth/claim-manager';
import { listProviders } from '../auth/provider-registry';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Response } from 'express';
import { completeBootstrap } from '../auth/bootstrap';
import { listSupportedScopes } from '../auth/scopes-registry';
import { scopeMatches } from '../auth/scope-matcher';

export function registerAuthEndpoints(
  db: BetterSQLite3Database<any>,
  sessionManager: SessionManager,
  claimManager: ClaimManager,
) {
  // Helper to set the session cookie
  function setSessionCookie(res: Response, sessionId: string, hostname: string): void {
    const isProduction = process.env.NODE_ENV === 'production';
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
    res.cookie('darkride_sid', sessionId, {
      httpOnly: true,
      secure: isProduction && !isLocalhost,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  // GET /v1/auth/providers — list enabled providers (public)
  registerEndpoint('GET', '/v1/auth/providers', (_req, res) => {
    res.json({ success: true, data: listProviders() });
  });

  // GET /v1/auth/scopes — catalog of known scopes, filtered to what the
  // authenticated user's grants cover. Used by the API-keys picker so
  // admins can see real options with human-readable labels rather than
  // free-texting scope strings from memory.
  registerEndpoint('GET', '/v1/auth/scopes', (req, res) => {
    if (!req.authUser) { res.status(401).json({ success: false, error: 'unauthorized' }); return; }
    const user = db.select().from(users).where(eq(users.id, req.authUser.userId)).get();
    if (!user) { res.status(401).json({ success: false, error: 'unauthorized' }); return; }
    const rawScopes = user.scopes;
    const userScopes = new Set(
      (Array.isArray(rawScopes) ? rawScopes : JSON.parse(rawScopes as any)) as string[],
    );
    // Only return scopes the user can actually grant to an API key.
    const available = listSupportedScopes().filter(s => scopeMatches(userScopes, s.key));
    res.json({ success: true, data: available });
  });

  // GET /v1/auth/me — current user status
  // This is on the auth allowlist and works both authenticated and unauthenticated
  registerEndpoint('GET', '/v1/auth/me', (req, res) => {
    if (!req.authUser) {
      // Only human users gate setup — service accounts (__system__, service:*:ai)
      // are seeded at startup and must not make setupRequired read false, or the
      // first-admin wizard never renders. Mirrors the bootstrap check in bootstrap.ts.
      const hasUsers = db.select({ id: users.id }).from(users)
        .where(eq(users.kind, 'human')).limit(1).get();
      res.json({ authenticated: false, setupRequired: !hasUsers });
      return;
    }

    const user = db.select().from(users).where(eq(users.id, req.authUser.userId)).get();
    if (!user) {
      res.json({ authenticated: false, setupRequired: false });
      return;
    }

    const scopes = (Array.isArray(user.scopes) ? user.scopes : JSON.parse(user.scopes as any)) as string[];

    res.json({
      authenticated: true,
      passwordMustChange: user.passwordMustChange,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName ?? user.username,
        email: user.email,
        scopes,
        providerId: user.providerId,
      },
      csrfToken: req.authUser.csrfToken ?? null,
    });
  });

  // POST /v1/auth/login — credentials flow login (public)
  registerEndpoint('POST', '/v1/auth/login', async (req, res) => {
    const { providerId, credentials } = req.body;

    if (!providerId || !credentials) {
      res.status(400).json({ success: false, error: 'providerId and credentials required' });
      return;
    }

    // For Plan A, only core.local is supported. Plan B adds plugin providers.
    if (providerId !== 'core.local') {
      res.status(400).json({ success: false, error: 'Unknown provider' });
      return;
    }

    const { username, password } = credentials;
    if (!username || !password) {
      res.status(400).json({ success: false, error: 'Username and password required' });
      return;
    }

    try {
      const result = await authenticateLocal(db, username, password, req.ip || '127.0.0.1');

      const session = sessionManager.create(
        result.userId,
        'core.local',
        req.headers['user-agent'] ?? null,
        req.ip ?? null,
      );

      setSessionCookie(res, session.id, req.hostname);

      const user = db.select().from(users).where(eq(users.id, result.userId)).get();
      res.json({
        success: true,
        user: {
          id: result.userId,
          username: result.username,
          displayName: user?.displayName ?? result.username,
          scopes: result.scopes,
        },
        csrfToken: session.csrfToken,
      });
    } catch (err) {
      if (err instanceof AuthenticationError) {
        res.status(401).json({ success: false, error: err.message });
        return;
      }
      throw err;
    }
  });

  // POST /v1/auth/setup — bootstrap the first admin (public)
  registerEndpoint('POST', '/v1/auth/setup', async (req, res) => {
    const { token, username, password } = req.body;
    if (!token || !username || !password) {
      res.status(400).json({ success: false, error: 'token, username, and password required' });
      return;
    }

    try {
      const { userId } = await completeBootstrap(db, token, username, password);

      // Auto-login the new admin
      const session = sessionManager.create(
        userId,
        'core.local',
        req.headers['user-agent'] ?? null,
        req.ip ?? null,
      );
      setSessionCookie(res, session.id, req.hostname);

      res.json({ success: true, csrfToken: session.csrfToken });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // POST /v1/auth/logout
  registerEndpoint('POST', '/v1/auth/logout', (req, res) => {
    if (req.authUser?.sessionId) {
      sessionManager.revoke(req.authUser.sessionId);
    }
    res.clearCookie('darkride_sid', { path: '/' });
    res.json({ success: true });
  });

  // POST /v1/auth/claim — consume a claim token and set password (public)
  registerEndpoint('POST', '/v1/auth/claim', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ success: false, error: 'token and password required' });
      return;
    }
    try {
      const { userId } = await claimManager.consumeClaim(token, password);
      const session = sessionManager.create(userId, 'core.local', req.headers['user-agent'] ?? null, req.ip ?? null);
      setSessionCookie(res, session.id, req.hostname);
      res.json({ success: true, csrfToken: session.csrfToken });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // POST /v1/admin/users — create a new user (admin only)
  registerEndpoint('POST', '/v1/admin/users', (req, res) => {
    const { username, displayName, email, scopes } = req.body;
    if (!username) {
      res.status(400).json({ success: false, error: 'username required' });
      return;
    }
    try {
      const result = claimManager.createUserWithClaim(
        username,
        displayName ?? null,
        email ?? null,
        scopes ?? [],
      );
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      if (err.message.includes('already exists')) {
        res.status(409).json({ success: false, error: err.message });
      } else {
        res.status(400).json({ success: false, error: err.message });
      }
    }
  }, { requires: ['core.users:admin'] });
}
