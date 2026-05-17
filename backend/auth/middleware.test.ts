import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { requireScope, csrfProtection, createAuthMiddleware } from './middleware';
import type { AuthUser } from './middleware';

// Helper to build a minimal mock Request
function mockReq(overrides: Partial<Request> & { authUser?: AuthUser } = {}): Request {
  return {
    method: 'GET',
    headers: {},
    cookies: {},
    ...overrides,
  } as unknown as Request;
}

// Helper to build a mock Response with jest-style tracking
function mockRes() {
  const res: any = {
    statusCode: 200,
    _body: null as any,
    headersSent: false,
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res._body = body;
    res.headersSent = true;
    return res;
  };
  return res as Response & { statusCode: number; _body: any };
}

describe('requireScope', () => {
  it('returns 401 if req.authUser is undefined', () => {
    const middleware = requireScope('devices:read');
    const req = mockReq({ authUser: undefined });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as any, next);

    expect(res.statusCode).toBe(401);
    expect((res as any)._body).toMatchObject({ success: false, error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 if user lacks required scope', () => {
    const middleware = requireScope('devices:write');
    const req = mockReq({
      authUser: {
        userId: 1,
        username: 'alice',
        via: 'session',
        effectiveScopes: new Set(['devices:read']),
      },
    });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as any, next);

    expect(res.statusCode).toBe(403);
    expect((res as any)._body).toMatchObject({
      success: false,
      error: 'Insufficient scope',
      missing: ['devices:write'],
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes if user has the required scope', () => {
    const middleware = requireScope('devices:read');
    const req = mockReq({
      authUser: {
        userId: 1,
        username: 'alice',
        via: 'session',
        effectiveScopes: new Set(['devices:read', 'devices:write']),
      },
    });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('passes if user has core.admin:* (universal scope)', () => {
    const middleware = requireScope('some.obscure.area:delete');
    const req = mockReq({
      authUser: {
        userId: 1,
        username: 'admin',
        via: 'apikey',
        effectiveScopes: new Set(['core.admin:*']),
      },
    });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('passes when multiple scopes are required and user has all of them', () => {
    const middleware = requireScope('devices:read', 'automations:write');
    const req = mockReq({
      authUser: {
        userId: 2,
        username: 'bob',
        via: 'session',
        effectiveScopes: new Set(['devices:read', 'automations:write', 'capture:read']),
      },
    });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as any, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 403 listing all missing scopes when user has only some', () => {
    const middleware = requireScope('devices:read', 'automations:write');
    const req = mockReq({
      authUser: {
        userId: 2,
        username: 'bob',
        via: 'session',
        effectiveScopes: new Set(['devices:read']),
      },
    });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as any, next);

    expect(res.statusCode).toBe(403);
    expect((res as any)._body.missing).toEqual(['automations:write']);
  });
});

describe('csrfProtection', () => {
  it('passes GET requests without a CSRF token', () => {
    const req = mockReq({
      method: 'GET',
      authUser: {
        userId: 1,
        username: 'alice',
        via: 'session',
        effectiveScopes: new Set(['devices:read']),
        csrfToken: 'abc123',
      },
    });
    const res = mockRes();
    const next = vi.fn();

    csrfProtection(req, res as any, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes HEAD and OPTIONS requests without a CSRF token', () => {
    for (const method of ['HEAD', 'OPTIONS'] as const) {
      const req = mockReq({
        method,
        authUser: {
          userId: 1,
          username: 'alice',
          via: 'session',
          effectiveScopes: new Set(),
          csrfToken: 'abc123',
        },
      });
      const res = mockRes();
      const next = vi.fn();

      csrfProtection(req, res as any, next);

      expect(next).toHaveBeenCalled();
    }
  });

  it('blocks POST requests without a CSRF token when session-authenticated', () => {
    const req = mockReq({
      method: 'POST',
      headers: {} as any,
      authUser: {
        userId: 1,
        username: 'alice',
        via: 'session',
        effectiveScopes: new Set(['devices:write']),
        csrfToken: 'secret-token',
      },
    });
    const res = mockRes();
    const next = vi.fn();

    csrfProtection(req, res as any, next);

    expect(res.statusCode).toBe(403);
    expect((res as any)._body).toMatchObject({ success: false, error: 'Invalid CSRF token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks POST requests with wrong CSRF token', () => {
    const req = mockReq({
      method: 'POST',
      headers: { 'x-csrf-token': 'wrong-token' } as any,
      authUser: {
        userId: 1,
        username: 'alice',
        via: 'session',
        effectiveScopes: new Set(),
        csrfToken: 'correct-token',
      },
    });
    const res = mockRes();
    const next = vi.fn();

    csrfProtection(req, res as any, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes POST requests with correct CSRF token', () => {
    const req = mockReq({
      method: 'POST',
      headers: { 'x-csrf-token': 'correct-token' } as any,
      authUser: {
        userId: 1,
        username: 'alice',
        via: 'session',
        effectiveScopes: new Set(['devices:write']),
        csrfToken: 'correct-token',
      },
    });
    const res = mockRes();
    const next = vi.fn();

    csrfProtection(req, res as any, next);

    expect(next).toHaveBeenCalled();
  });

  it('skips CSRF check for API key auth (non-browser)', () => {
    const req = mockReq({
      method: 'POST',
      headers: {} as any,
      authUser: {
        userId: 1,
        username: 'alice',
        via: 'apikey',
        apiKeyId: 42,
        effectiveScopes: new Set(['devices:write']),
        // no csrfToken for apikey auth
      },
    });
    const res = mockRes();
    const next = vi.fn();

    csrfProtection(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('passes through when req.authUser is undefined (unauthenticated — already blocked by auth middleware)', () => {
    const req = mockReq({
      method: 'POST',
      headers: {} as any,
      authUser: undefined,
    });
    const res = mockRes();
    const next = vi.fn();

    csrfProtection(req, res as any, next);

    // CSRF doesn't block unauthenticated — that's auth middleware's job
    expect(next).toHaveBeenCalled();
  });
});

// ─── createAuthMiddleware ─────────────────────────────────────────────────────

function createMiddlewareTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function mockReqWithPath(
  path: string,
  overrides: Partial<Request> & { authUser?: AuthUser } = {},
): Request {
  return {
    method: 'GET',
    path,
    headers: {},
    cookies: {},
    ...overrides,
  } as unknown as Request;
}

describe('createAuthMiddleware', () => {
  let db: ReturnType<typeof createMiddlewareTestDb>;
  let userId: number;
  let sessionId: string;
  let csrfToken: string;

  beforeEach(() => {
    db = createMiddlewareTestDb();
    const now = new Date();

    const userResult = db.insert(schema.users).values({
      username: 'alice',
      providerId: 'core.local',
      scopes: JSON.stringify(['core.admin:*', 'devices:read']) as any,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run();
    userId = Number(userResult.lastInsertRowid);

    sessionId = randomBytes(32).toString('hex');
    csrfToken = randomBytes(32).toString('hex');
    db.insert(schema.sessions).values({
      id: sessionId,
      userId,
      providerId: 'core.local',
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      csrfToken,
    }).run();
  });

  it('allowlisted exact path passes unauthenticated', () => {
    const mw = createAuthMiddleware(db, ['/v1/auth/login']);
    const req = mockReqWithPath('/v1/auth/login');
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);
    expect(next).toHaveBeenCalled();
    expect((res as any).statusCode).toBe(200);
  });

  it('allowlisted regex path passes unauthenticated', () => {
    const mw = createAuthMiddleware(db, [/^\/v1\/public\//]);
    const req = mockReqWithPath('/v1/public/info');
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('non-allowlisted path without auth returns 401', () => {
    const mw = createAuthMiddleware(db, ['/v1/auth/login']);
    const req = mockReqWithPath('/v1/devices');
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);
    expect((res as any).statusCode).toBe(401);
    expect((res as any)._body).toMatchObject({ success: false });
    expect(next).not.toHaveBeenCalled();
  });

  it('loopback-only path passes when req.ip is 127.0.0.1', () => {
    const mw = createAuthMiddleware(db, [], ['/v1/traffic/ingest']);
    const req = mockReqWithPath('/v1/traffic/ingest', { ip: '127.0.0.1' } as any);
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).authUser).toBeUndefined();
  });

  it('loopback-only path passes for IPv6 loopback', () => {
    const mw = createAuthMiddleware(db, [], ['/v1/traffic/ingest']);
    const req = mockReqWithPath('/v1/traffic/ingest', { ip: '::ffff:127.0.0.1' } as any);
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('loopback-only path falls through to auth when req.ip is not loopback', () => {
    const mw = createAuthMiddleware(db, [], ['/v1/traffic/ingest']);
    const req = mockReqWithPath('/v1/traffic/ingest', { ip: '203.0.113.5' } as any);
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);
    expect((res as any).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('loopback-only prefix matches child paths', () => {
    const mw = createAuthMiddleware(db, [], ['/v1/traffic']);
    const req = mockReqWithPath('/v1/traffic/ws-start', { ip: '127.0.0.1' } as any);
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('valid API key populates req.authUser', () => {
    const keyPlain = 'darkride_pat_' + randomBytes(20).toString('hex');
    const keyHash = createHash('sha256').update(keyPlain).digest('hex');
    const now = new Date();
    db.insert(schema.apiKeys).values({
      userId,
      name: 'Test Key',
      keyHash,
      keyPrefix: keyPlain.substring(13, 21),
      scopes: JSON.stringify(['devices:read']) as any,
      createdAt: now,
    }).run();

    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      headers: { authorization: `Bearer ${keyPlain}` } as any,
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.authUser).toBeDefined();
    expect(req.authUser!.via).toBe('apikey');
    expect(req.authUser!.username).toBe('alice');
  });

  it('expired API key returns 401', () => {
    const keyPlain = 'darkride_pat_' + randomBytes(20).toString('hex');
    const keyHash = createHash('sha256').update(keyPlain).digest('hex');
    const now = new Date();
    db.insert(schema.apiKeys).values({
      userId,
      name: 'Expired Key',
      keyHash,
      keyPrefix: keyPlain.substring(13, 21),
      scopes: JSON.stringify(['devices:read']) as any,
      expiresAt: new Date(Date.now() - 1000), // expired 1s ago
      createdAt: now,
    }).run();

    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      headers: { authorization: `Bearer ${keyPlain}` } as any,
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    expect((res as any).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('revoked API key returns 401', () => {
    const keyPlain = 'darkride_pat_' + randomBytes(20).toString('hex');
    const keyHash = createHash('sha256').update(keyPlain).digest('hex');
    const now = new Date();
    db.insert(schema.apiKeys).values({
      userId,
      name: 'Revoked Key',
      keyHash,
      keyPrefix: keyPlain.substring(13, 21),
      scopes: JSON.stringify(['devices:read']) as any,
      revokedAt: new Date(Date.now() - 1000),
      createdAt: now,
    }).run();

    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      headers: { authorization: `Bearer ${keyPlain}` } as any,
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    expect((res as any).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('API key owner disabled returns 401', () => {
    const keyPlain = 'darkride_pat_' + randomBytes(20).toString('hex');
    const keyHash = createHash('sha256').update(keyPlain).digest('hex');
    const now = new Date();
    db.insert(schema.apiKeys).values({
      userId,
      name: 'Disabled Owner Key',
      keyHash,
      keyPrefix: keyPlain.substring(13, 21),
      scopes: JSON.stringify(['devices:read']) as any,
      createdAt: now,
    }).run();
    db.update(schema.users).set({ enabled: false }).where(eq(schema.users.id, userId)).run();

    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      headers: { authorization: `Bearer ${keyPlain}` } as any,
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    expect((res as any).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('scope intersection: key scope not in user scopes is filtered out of effectiveScopes', () => {
    // User only has 'devices:read'; key requests 'traffic:read' which user doesn't have
    const keyPlain = 'darkride_pat_' + randomBytes(20).toString('hex');
    const keyHash = createHash('sha256').update(keyPlain).digest('hex');
    const now = new Date();
    db.insert(schema.apiKeys).values({
      userId,
      name: 'Scope Test Key',
      keyHash,
      keyPrefix: keyPlain.substring(13, 21),
      scopes: JSON.stringify(['devices:read', 'traffic:read']) as any,
      createdAt: now,
    }).run();
    // Override user's scopes to only devices:read (not core.admin:*)
    db.update(schema.users)
      .set({ scopes: JSON.stringify(['devices:read']) as any })
      .where(eq(schema.users.id, userId))
      .run();

    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      headers: { authorization: `Bearer ${keyPlain}` } as any,
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    expect(next).toHaveBeenCalled();
    // traffic:read should be filtered out — user doesn't have it
    expect(req.authUser!.effectiveScopes.has('traffic:read')).toBe(false);
    // devices:read should remain — user has it
    expect(req.authUser!.effectiveScopes.has('devices:read')).toBe(true);
  });

  it('valid session cookie populates req.authUser', () => {
    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      cookies: { darkride_sid: sessionId },
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.authUser).toBeDefined();
    expect(req.authUser!.via).toBe('session');
    expect(req.authUser!.username).toBe('alice');
    expect(req.authUser!.csrfToken).toBe(csrfToken);
  });

  it('expired session returns 401', () => {
    db.update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.id, sessionId))
      .run();

    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      cookies: { darkride_sid: sessionId },
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    expect((res as any).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('revoked session returns 401', () => {
    db.update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.sessions.id, sessionId))
      .run();

    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      cookies: { darkride_sid: sessionId },
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    expect((res as any).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  // CG-4: allowlisted path with invalid Bearer token passes through
  it('passes through on allowlisted path even with an invalid Bearer token', () => {
    const mw = createAuthMiddleware(db, ['/v1/auth']);
    const req = mockReqWithPath('/v1/auth/me', {
      headers: { authorization: 'Bearer darkride_pat_invalid' } as any,
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.authUser).toBeUndefined();
    expect((res as any).statusCode).toBe(200);
  });

  // IG-9: non-PAT Bearer token falls through to session path, then returns 401
  it('ignores non-PAT Bearer tokens and falls through to cookie path', () => {
    const mw = createAuthMiddleware(db, []);
    // Token does NOT start with "darkride_pat_" so PAT path is skipped
    const req = mockReqWithPath('/v1/devices', {
      headers: { authorization: 'Bearer some-other-token' } as any,
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    // No cookie either, so should reach the "no valid auth" branch
    expect((res as any).statusCode).toBe(401);
    expect((res as any)._body).toMatchObject({ success: false, error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  // MG-5: lastUsedAt is set on first API key use and NOT updated again within 60s
  it('sets lastUsedAt on API key first use', () => {
    const keyPlain = 'darkride_pat_' + randomBytes(20).toString('hex');
    const keyHash = createHash('sha256').update(keyPlain).digest('hex');
    const now = new Date();
    const insertResult = db.insert(schema.apiKeys).values({
      userId,
      name: 'LastUsed Key',
      keyHash,
      keyPrefix: keyPlain.substring(13, 21),
      scopes: JSON.stringify(['devices:read']) as any,
      createdAt: now,
    }).run();
    const keyId = Number(insertResult.lastInsertRowid);

    // Before first use, lastUsedAt should be null
    const beforeRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, keyId)).get();
    expect(beforeRow!.lastUsedAt).toBeNull();

    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      headers: { authorization: `Bearer ${keyPlain}` } as any,
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);
    expect(next).toHaveBeenCalled();

    // After first use, lastUsedAt should be set
    const afterRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, keyId)).get();
    expect(afterRow!.lastUsedAt).not.toBeNull();
    expect(afterRow!.lastUsedAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('does not update lastUsedAt again within 60 seconds', () => {
    const keyPlain = 'darkride_pat_' + randomBytes(20).toString('hex');
    const keyHash = createHash('sha256').update(keyPlain).digest('hex');
    // Use a round-second timestamp to avoid SQLite millisecond truncation issues
    const recentlyUsedMs = Math.floor((Date.now() - 5_000) / 1000) * 1000; // 5s ago, truncated to second
    const recentlyUsed = new Date(recentlyUsedMs);
    const insertResult = db.insert(schema.apiKeys).values({
      userId,
      name: 'Throttle Key',
      keyHash,
      keyPrefix: keyPlain.substring(13, 21),
      scopes: JSON.stringify(['devices:read']) as any,
      createdAt: new Date(),
      lastUsedAt: recentlyUsed,
    }).run();
    const keyId = Number(insertResult.lastInsertRowid);

    const mw = createAuthMiddleware(db, []);
    const req = mockReqWithPath('/v1/devices', {
      headers: { authorization: `Bearer ${keyPlain}` } as any,
    });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);
    expect(next).toHaveBeenCalled();

    // lastUsedAt should still be the original recentlyUsed value (not updated)
    const afterRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, keyId)).get();
    expect(afterRow!.lastUsedAt!.getTime()).toBe(recentlyUsed.getTime());
  });

  // IG-10: allowlist prefix matching does not over-match
  it('does not allowlist /v1/authsomething when pattern is /v1/auth', () => {
    const mw = createAuthMiddleware(db, ['/v1/auth']);
    const req = mockReqWithPath('/v1/authsomething');
    const res = mockRes();
    const next = vi.fn();
    mw(req, res as any, next);

    // /v1/authsomething is NOT under /v1/auth/ — must NOT be allowlisted
    expect((res as any).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
