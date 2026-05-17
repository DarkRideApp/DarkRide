import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAuthEndpoints } from './auth';
import { registerAdminUserEndpoints } from './admin-users';
import { SessionManager } from '../auth/session-manager';
import { ClaimManager } from '../auth/claim-manager';
import { hashPassword } from '../auth/password';
import { createAuthMiddleware } from '../auth/middleware';
import { createTestDb } from '../test-utils/create-test-db';

const AUTH_ALLOWLIST: Array<string | RegExp> = [
  '/v1/auth/login',
  '/v1/auth/providers',
  '/v1/auth/me',
  '/v1/auth/setup',
  '/v1/auth/claim',
  '/v1/auth/logout',
];

function createApp() {
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
  registerAdminUserEndpoints(db as any, claimManager, sessionManager);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(createAuthMiddleware(db as any, AUTH_ALLOWLIST));
  app.use(getApiRouter());

  return { app, db, sessionManager, claimManager };
}

async function loginAs(
  app: express.Express,
  db: ReturnType<typeof createTestDb>,
  username: string,
  password: string,
  scopes: string[],
): Promise<{ cookie: string; csrfToken: string; userId: number }> {
  const hash = await hashPassword(password);
  const now = new Date();
  const result = (db as any).insert(schema.users).values({
    username,
    passwordHash: hash,
    providerId: 'core.local',
    scopes: JSON.stringify(scopes) as any,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }).run();
  const userId = Number(result.lastInsertRowid);

  const loginRes = await request(app)
    .post('/v1/auth/login')
    .send({ providerId: 'core.local', credentials: { username, password } });

  expect(loginRes.status).toBe(200);
  const cookies = loginRes.headers['set-cookie'] as string[];
  const sessionCookie = cookies.find((c: string) => c.startsWith('darkride_sid='))!;
  return { cookie: sessionCookie, csrfToken: loginRes.body.csrfToken, userId };
}

describe('Admin Users endpoints', () => {
  let app: express.Express;
  let db: ReturnType<typeof createTestDb>;
  let adminCookie: string;
  let adminCsrf: string;
  let adminUserId: number;

  beforeEach(async () => {
    const ctx = createApp();
    app = ctx.app;
    db = ctx.db;
    const auth = await loginAs(app, db, 'admin', 'test-password-123', ['core.users:admin']);
    adminCookie = auth.cookie;
    adminCsrf = auth.csrfToken;
    adminUserId = auth.userId;
  });

  describe('GET /v1/admin/users', () => {
    it('lists all users', async () => {
      const res = await request(app)
        .get('/v1/admin/users')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      const usernames = res.body.data.map((u: any) => u.username);
      expect(usernames).toContain('admin');
    });

    it('returns 403 for user without core.users:admin scope', async () => {
      // Create a user with limited scope and login
      const limitedAuth = await loginAs(app, db, 'limited', 'test-password-123', ['devices:read']);
      const res = await request(app)
        .get('/v1/admin/users')
        .set('Cookie', limitedAuth.cookie);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/v1/admin/users');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /v1/admin/users/:id', () => {
    it('updates user scopes', async () => {
      const res = await request(app)
        .patch(`/v1/admin/users/${adminUserId}`)
        .set('Cookie', adminCookie)
        .set('x-csrf-token', adminCsrf)
        .send({ scopes: ['core.users:admin', 'devices:read'] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 403 for user without core.users:admin scope', async () => {
      const limitedAuth = await loginAs(app, db, 'limited2', 'test-password-123', ['devices:read']);
      const res = await request(app)
        .patch(`/v1/admin/users/${adminUserId}`)
        .set('Cookie', limitedAuth.cookie)
        .set('x-csrf-token', limitedAuth.csrfToken)
        .send({ displayName: 'New Name' });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /v1/admin/users/:id', () => {
    it('blocks self-deletion', async () => {
      const res = await request(app)
        .delete(`/v1/admin/users/${adminUserId}`)
        .set('Cookie', adminCookie)
        .set('x-csrf-token', adminCsrf);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Cannot delete your own account');
    });

    it('can delete another user', async () => {
      // Create another user to delete
      const otherAuth = await loginAs(app, db, 'tobedeleted', 'test-password-123', []);
      const res = await request(app)
        .delete(`/v1/admin/users/${otherAuth.userId}`)
        .set('Cookie', adminCookie)
        .set('x-csrf-token', adminCsrf);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /v1/admin/users/:id/reset', () => {
    it('generates reset claim URL', async () => {
      // Create a target user with a password first (claimManager creates unclaimed users)
      const targetAuth = await loginAs(app, db, 'target', 'test-password-123', []);
      const res = await request(app)
        .post(`/v1/admin/users/${targetAuth.userId}/reset`)
        .set('Cookie', adminCookie)
        .set('x-csrf-token', adminCsrf);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.data.claimUrl).toContain('/ui/claim?token=');
    });

    it('returns 403 for user without core.users:admin scope', async () => {
      const limitedAuth = await loginAs(app, db, 'limited3', 'test-password-123', ['devices:read']);
      const res = await request(app)
        .post(`/v1/admin/users/${adminUserId}/reset`)
        .set('Cookie', limitedAuth.cookie)
        .set('x-csrf-token', limitedAuth.csrfToken);
      expect(res.status).toBe(403);
    });
  });
});

describe('service-account handling', () => {
  let app: express.Express;
  let db: ReturnType<typeof createTestDb>;
  let adminCookie: string;
  let adminCsrf: string;
  let pluginSvcId: number;

  beforeEach(async () => {
    const ctx = createApp();
    app = ctx.app;
    db = ctx.db;
    const auth = await loginAs(app, db, 'admin', 'test-password-123', ['core.users:admin']);
    adminCookie = auth.cookie;
    adminCsrf = auth.csrfToken;

    // Seed a plugin-service account
    const now = new Date();
    const result = (db as any).insert(schema.users).values({
      username: 'plugin:foo:ai',
      providerId: 'core.service',
      kind: 'plugin-service',
      serviceOwner: 'foo',
      scopes: JSON.stringify(['mcp']) as any,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run();
    pluginSvcId = Number(result.lastInsertRowid);
  });

  it('GET /v1/admin/users defaults to human-only', async () => {
    const res = await request(app)
      .get('/v1/admin/users')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.every((u: any) => u.kind === 'human' || !u.kind)).toBe(true);
    expect(res.body.data.find((u: any) => u.username === 'plugin:foo:ai')).toBeUndefined();
  });

  it('GET /v1/admin/users?kind=all includes service accounts', async () => {
    const res = await request(app)
      .get('/v1/admin/users?kind=all')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const hit = res.body.data.find((u: any) => u.username === 'plugin:foo:ai');
    expect(hit).toBeDefined();
    expect(hit.kind).toBe('plugin-service');
    expect(hit.serviceOwner).toBe('foo');
  });

  it('DELETE service account is rejected with 400 and explanatory message', async () => {
    const res = await request(app)
      .delete(`/v1/admin/users/${pluginSvcId}`)
      .set('Cookie', adminCookie)
      .set('x-csrf-token', adminCsrf);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uninstall.*plugin/i);
  });

  it('PATCH on service account rejects non-scope changes', async () => {
    const res = await request(app)
      .patch(`/v1/admin/users/${pluginSvcId}`)
      .set('Cookie', adminCookie)
      .set('x-csrf-token', adminCsrf)
      .send({ enabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot modify.*service account/i);
  });

  it('PATCH on service account allows scope edits', async () => {
    const res = await request(app)
      .patch(`/v1/admin/users/${pluginSvcId}`)
      .set('Cookie', adminCookie)
      .set('x-csrf-token', adminCsrf)
      .send({ scopes: ['mcp', 'core.apk:read'] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = await request(app)
      .get(`/v1/admin/users/${pluginSvcId}`)
      .set('Cookie', adminCookie);
    expect(after.body.data.scopes).toEqual(['mcp', 'core.apk:read']);
  });

  it('POST reset-password on service account is rejected', async () => {
    const res = await request(app)
      .post(`/v1/admin/users/${pluginSvcId}/reset`)
      .set('Cookie', adminCookie)
      .set('x-csrf-token', adminCsrf);
    expect(res.status).toBe(400);
  });

  it('POST revoke-sessions on service account is rejected', async () => {
    const res = await request(app)
      .post(`/v1/admin/users/${pluginSvcId}/revoke-sessions`)
      .set('Cookie', adminCookie)
      .set('x-csrf-token', adminCsrf);
    expect(res.status).toBe(400);
  });
});
