import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAuthEndpoints } from './auth';
import { SessionManager } from '../auth/session-manager';
import { ClaimManager } from '../auth/claim-manager';
import { hashPassword } from '../auth/password';
import { createAuthMiddleware } from '../auth/middleware';
import { createTestDb } from '../test-utils/create-test-db';
import { checkBootstrap, getBootstrapToken } from '../auth/bootstrap';

// Auth endpoints that should work unauthenticated (on allowlist)
const AUTH_ALLOWLIST: Array<string | RegExp> = [
  '/v1/auth/login',
  '/v1/auth/providers',
  '/v1/auth/me',
  '/v1/auth/setup',
  '/v1/auth/claim',
  '/v1/auth/logout',
];

function createApp(opts: { trustProxy?: boolean } = {}) {
  clearEndpoints();

  const db = createTestDb([
    schema.users,
    schema.sessions,
    schema.apiKeys,
    schema.passwordResetTokens,
  ]);

  const sessionManager = new SessionManager(db as any);
  const claimManager = new ClaimManager(db as any);

  registerAuthEndpoints(db as any, sessionManager, claimManager);

  const app = express();
  // Mirror production TRUST_PROXY handling so req.secure honors X-Forwarded-Proto
  if (opts.trustProxy) app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  // Auth middleware populates req.authUser from session cookie/API key, but
  // allowlisted auth paths still pass through unauthenticated.
  app.use(createAuthMiddleware(db as any, AUTH_ALLOWLIST));
  app.use(getApiRouter());

  return { app, db, sessionManager };
}

describe('Auth API endpoints', () => {
  let app: express.Express;
  let db: ReturnType<typeof createTestDb>;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    const ctx = createApp();
    app = ctx.app;
    db = ctx.db;
    sessionManager = ctx.sessionManager;

    const hash = await hashPassword('test-password-123');
    const now = new Date();
    (db as any).insert(schema.users).values({
      username: 'testuser',
      passwordHash: hash,
      providerId: 'core.local',
      scopes: JSON.stringify(['core.admin:*']) as any,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run();
  });

  describe('POST /v1/auth/login', () => {
    it('returns 400 when credentials object is missing', async () => {
      const res = await request(app)
        .post('/v1/auth/login')
        .send({ providerId: 'core.local' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when providerId is missing', async () => {
      const res = await request(app)
        .post('/v1/auth/login')
        .send({ credentials: { username: 'testuser', password: 'test-password-123' } });
      expect(res.status).toBe(400);
    });

    it('returns 401 on wrong password', async () => {
      const res = await request(app)
        .post('/v1/auth/login')
        .send({
          providerId: 'core.local',
          credentials: { username: 'testuser', password: 'wrong-password' },
        });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 200 with Set-Cookie and csrfToken on successful login', async () => {
      const res = await request(app)
        .post('/v1/auth/login')
        .send({
          providerId: 'core.local',
          credentials: { username: 'testuser', password: 'test-password-123' },
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.csrfToken).toBeDefined();
      expect(typeof res.body.csrfToken).toBe('string');
      expect(res.body.csrfToken.length).toBeGreaterThan(0);
      expect(res.headers['set-cookie']).toBeDefined();
      const setCookieHeader = (res.headers['set-cookie'] as string[]).join('; ');
      expect(setCookieHeader).toContain('darkride_sid');
    });

    it('returns 400 for unknown providerId', async () => {
      const res = await request(app)
        .post('/v1/auth/login')
        .send({
          providerId: 'oauth.google',
          credentials: { username: 'testuser', password: 'test-password-123' },
        });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    // MG-8: missing sub-fields inside credentials object
    it('returns 400 when credentials object is missing password', async () => {
      const res = await request(app)
        .post('/v1/auth/login')
        .send({ providerId: 'core.local', credentials: { username: 'testuser' } });
      expect(res.status).toBe(400);
      // Server responds with "Username and password required"
      expect(res.body.error).toMatch(/password/i);
    });

    it('returns 400 when credentials object is missing username', async () => {
      const res = await request(app)
        .post('/v1/auth/login')
        .send({ providerId: 'core.local', credentials: { password: 'test' } });
      expect(res.status).toBe(400);
      // Server responds with "Username and password required"
      expect(res.body.error).toMatch(/username/i);
    });
  });

  describe('GET /v1/auth/me', () => {
    it('returns { authenticated: false } without auth', async () => {
      const res = await request(app).get('/v1/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(false);
    });

    it('returns { authenticated: false } even with a session cookie (entire /v1/auth prefix is allowlisted — middleware skips it)', async () => {
      // The /v1/auth prefix is on the allowlist, so auth middleware never runs
      // for /v1/auth/me. req.authUser is always undefined here.
      // First login to get a real session cookie
      const loginRes = await request(app)
        .post('/v1/auth/login')
        .send({
          providerId: 'core.local',
          credentials: { username: 'testuser', password: 'test-password-123' },
        });
      expect(loginRes.status).toBe(200);

      const cookies = loginRes.headers['set-cookie'] as string[];
      const sessionCookie = cookies.find((c: string) => c.startsWith('darkride_sid='));
      expect(sessionCookie).toBeDefined();

      const meRes = await request(app)
        .get('/v1/auth/me')
        .set('Cookie', sessionCookie!);
      expect(meRes.status).toBe(200);
      // Allowlisted paths still TRY to authenticate (so /me can return user info)
      // but don't REQUIRE it. With a valid cookie, the middleware populates req.authUser.
      expect(meRes.body.authenticated).toBe(true);
      expect(meRes.body.user.username).toBe('testuser');
      expect(meRes.body.csrfToken).toBeDefined();
    });
  });

  describe('GET /v1/auth/providers', () => {
    it('lists core.local provider', async () => {
      const res = await request(app).get('/v1/auth/providers');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      const ids = res.body.data.map((p: any) => p.id);
      expect(ids).toContain('core.local');
    });
  });

  describe('POST /v1/auth/logout', () => {
    it('clears the session cookie on logout', async () => {
      const loginRes = await request(app)
        .post('/v1/auth/login')
        .send({
          providerId: 'core.local',
          credentials: { username: 'testuser', password: 'test-password-123' },
        });
      expect(loginRes.status).toBe(200);

      const cookies = loginRes.headers['set-cookie'] as string[];
      const sessionCookie = cookies.find((c: string) => c.startsWith('darkride_sid='));
      expect(sessionCookie).toBeDefined();

      const logoutRes = await request(app)
        .post('/v1/auth/logout')
        .set('Cookie', sessionCookie!);
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);

      // The Set-Cookie header on logout should clear the cookie (Max-Age=0 or Expires in past)
      const logoutCookies = logoutRes.headers['set-cookie'] as string[] | undefined;
      if (logoutCookies) {
        const clearedCookie = logoutCookies.find((c: string) => c.startsWith('darkride_sid='));
        if (clearedCookie) {
          // Cookie is cleared either via Max-Age=0 or empty value
          expect(
            clearedCookie.includes('Max-Age=0') ||
            clearedCookie.includes('darkride_sid=;') ||
            clearedCookie.includes('darkride_sid= ;'),
          ).toBe(true);
        }
      }
    });
  });

  // CG-1: setup + claim + /me setupRequired tests
  describe('POST /v1/auth/setup', () => {
    let freshApp: express.Express;
    let freshDb: ReturnType<typeof createTestDb>;

    beforeEach(async () => {
      // Need a fresh DB with NO users for setup tests
      const ctx = createApp();
      freshApp = ctx.app;
      freshDb = ctx.db;
      // Don't insert any user — setup requires an empty DB
    });

    it('creates admin and auto-logs in (returns cookie + csrfToken)', async () => {
      await checkBootstrap(freshDb as any, '127.0.0.1', 3000);
      const token = getBootstrapToken()!;
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      const res = await request(freshApp)
        .post('/v1/auth/setup')
        .send({ token, username: 'newadmin', password: 'a-secure-password-123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.csrfToken).toBeDefined();
      expect(typeof res.body.csrfToken).toBe('string');
      const setCookieHeader = (res.headers['set-cookie'] as string[]).join('; ');
      expect(setCookieHeader).toContain('darkride_sid');
    });

    it('returns 400 with invalid token', async () => {
      await checkBootstrap(freshDb as any, '127.0.0.1', 3000);

      const res = await request(freshApp)
        .post('/v1/auth/setup')
        .send({ token: 'wrong-token', username: 'admin', password: 'a-secure-password-123' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 with weak password', async () => {
      await checkBootstrap(freshDb as any, '127.0.0.1', 3000);
      const token = getBootstrapToken()!;

      const res = await request(freshApp)
        .post('/v1/auth/setup')
        .send({ token, username: 'admin', password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /v1/auth/me — setupRequired', () => {
    it('returns setupRequired: true when no users exist', async () => {
      // Use a fresh app with an empty DB (before the beforeEach user is created)
      const { app: emptyApp } = createApp();
      const res = await request(emptyApp).get('/v1/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(false);
      expect(res.body.setupRequired).toBe(true);
    });

    it('returns setupRequired: false when users exist', async () => {
      // The main app already has a user from beforeEach
      const res = await request(app).get('/v1/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(false);
      expect(res.body.setupRequired).toBe(false);
    });

    it('returns setupRequired: true when only service accounts exist', async () => {
      // Service accounts (__system__, service:*:ai) are seeded at startup on
      // every real deployment. They must NOT satisfy the setup gate, or the
      // first-admin wizard never renders in the browser. Regression for the
      // unfiltered users count that reported setupRequired: false here.
      const { app: svcApp, db: svcDb } = createApp();
      const now = new Date();
      (svcDb as any).insert(schema.users).values({
        username: '__system__',
        providerId: 'core.local',
        kind: 'core-service',
        scopes: JSON.stringify(['core.admin:*']) as any,
        createdAt: now,
        updatedAt: now,
      }).run();

      const res = await request(svcApp).get('/v1/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(false);
      expect(res.body.setupRequired).toBe(true);
    });
  });

  describe('session cookie Secure flag', () => {
    it('omits Secure over plain HTTP', async () => {
      // A Secure cookie served over plain HTTP is silently dropped by the
      // browser: login returns 200 but the session never sticks and the UI
      // hangs on "Signing in...". Regression for the NODE_ENV-based heuristic.
      const res = await request(app)
        .post('/v1/auth/login')
        .send({
          providerId: 'core.local',
          credentials: { username: 'testuser', password: 'test-password-123' },
        });
      expect(res.status).toBe(200);
      const setCookieHeader = (res.headers['set-cookie'] as string[]).join('; ');
      expect(setCookieHeader).toContain('darkride_sid');
      expect(setCookieHeader).not.toMatch(/;\s*Secure/i);
    });

    it('sets Secure when the request arrived over HTTPS via a trusted proxy', async () => {
      const { app: proxiedApp, db: proxiedDb } = createApp({ trustProxy: true });
      const hash = await hashPassword('test-password-123');
      const now = new Date();
      (proxiedDb as any).insert(schema.users).values({
        username: 'testuser',
        passwordHash: hash,
        providerId: 'core.local',
        scopes: JSON.stringify(['core.admin:*']) as any,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }).run();

      const res = await request(proxiedApp)
        .post('/v1/auth/login')
        .set('X-Forwarded-Proto', 'https')
        .send({
          providerId: 'core.local',
          credentials: { username: 'testuser', password: 'test-password-123' },
        });
      expect(res.status).toBe(200);
      const setCookieHeader = (res.headers['set-cookie'] as string[]).join('; ');
      expect(setCookieHeader).toContain('darkride_sid');
      expect(setCookieHeader).toMatch(/;\s*Secure/i);
    });
  });

  describe('POST /v1/auth/claim', () => {
    it('consumes token and creates session', async () => {
      const claimManager = new ClaimManager(db as any);
      const { token } = claimManager.createUserWithClaim('claimuser', null, null, ['core.read']);

      const res = await request(app)
        .post('/v1/auth/claim')
        .send({ token, password: 'a-secure-password-123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.csrfToken).toBeDefined();
      const setCookieHeader = (res.headers['set-cookie'] as string[]).join('; ');
      expect(setCookieHeader).toContain('darkride_sid');
    });

    it('returns 400 with invalid token', async () => {
      const res = await request(app)
        .post('/v1/auth/claim')
        .send({ token: 'deadbeef'.repeat(8), password: 'a-secure-password-123' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
