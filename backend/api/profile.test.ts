import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAuthEndpoints } from './auth';
import { registerProfileEndpoints } from './profile';
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
  registerProfileEndpoints(db as any, sessionManager);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(createAuthMiddleware(db as any, AUTH_ALLOWLIST));
  app.use(getApiRouter());

  return { app, db, sessionManager };
}

async function loginAs(
  app: express.Express,
  db: ReturnType<typeof createTestDb>,
  username: string,
  password: string,
  scopes: string[] = ['core.admin:*'],
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

describe('Profile endpoints', () => {
  let app: express.Express;
  let db: ReturnType<typeof createTestDb>;
  let cookie: string;
  let csrfToken: string;

  beforeEach(async () => {
    const ctx = createApp();
    app = ctx.app;
    db = ctx.db;
    const auth = await loginAs(app, db, 'alice', 'test-password-123');
    cookie = auth.cookie;
    csrfToken = auth.csrfToken;
  });

  describe('GET /v1/profile', () => {
    it('returns current user info', async () => {
      const res = await request(app)
        .get('/v1/profile')
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.username).toBe('alice');
      expect(Array.isArray(res.body.data.scopes)).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/v1/profile');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /v1/profile', () => {
    it('updates displayName', async () => {
      const res = await request(app)
        .patch('/v1/profile')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .send({ displayName: 'Alice Wonderland' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify with GET /v1/profile
      const profileRes = await request(app)
        .get('/v1/profile')
        .set('Cookie', cookie);
      expect(profileRes.body.data.displayName).toBe('Alice Wonderland');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .patch('/v1/profile')
        .send({ displayName: 'Test' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /v1/profile/password', () => {
    it('changes password when current password is correct', async () => {
      const res = await request(app)
        .post('/v1/profile/password')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .send({ currentPassword: 'test-password-123', newPassword: 'new-secure-password-456' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects when current password is wrong', async () => {
      const res = await request(app)
        .post('/v1/profile/password')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .send({ currentPassword: 'wrong-password', newPassword: 'new-secure-password-456' });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('skips current password check when passwordMustChange is true', async () => {
      // Set passwordMustChange = true on the user
      const user = (db as any).select().from(schema.users).where(eq(schema.users.username, 'alice')).get();
      (db as any).update(schema.users)
        .set({ passwordMustChange: true })
        .where(eq(schema.users.id, user.id))
        .run();

      const res = await request(app)
        .post('/v1/profile/password')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .send({ newPassword: 'new-secure-password-456' }); // no currentPassword
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/v1/profile/password')
        .send({ currentPassword: 'test-password-123', newPassword: 'new-secure-password-456' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/profile/sessions', () => {
    it('lists sessions with current flag', async () => {
      const res = await request(app)
        .get('/v1/profile/sessions')
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      // The current session should be marked
      const currentSession = res.body.data.find((s: any) => s.current === true);
      expect(currentSession).toBeDefined();
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/v1/profile/sessions');
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /v1/profile/sessions/:id', () => {
    it('revokes a session', async () => {
      // Get list of sessions to find the current session ID
      const listRes = await request(app)
        .get('/v1/profile/sessions')
        .set('Cookie', cookie);
      expect(listRes.status).toBe(200);
      const sessions = listRes.body.data;
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const targetSessionId = sessions[0].id;

      const deleteRes = await request(app)
        .delete(`/v1/profile/sessions/${targetSessionId}`)
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).delete('/v1/profile/sessions/someid');
      expect(res.status).toBe(401);
    });
  });
});
