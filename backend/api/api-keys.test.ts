import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAuthEndpoints } from './auth';
import { registerApiKeyEndpoints } from './api-keys';
import { SessionManager } from '../auth/session-manager';
import { ClaimManager } from '../auth/claim-manager';
import { ApiKeyManager } from '../auth/api-key-manager';
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
  const apiKeyManager = new ApiKeyManager(db as any);

  registerAuthEndpoints(db as any, sessionManager, claimManager);
  registerApiKeyEndpoints(db as any, apiKeyManager);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(createAuthMiddleware(db as any, AUTH_ALLOWLIST));
  app.use(getApiRouter());

  return { app, db, sessionManager, apiKeyManager };
}

async function loginAs(
  app: express.Express,
  db: ReturnType<typeof createTestDb>,
  username: string,
  password: string,
  scopes: string[],
): Promise<{ cookie: string; csrfToken: string }> {
  const hash = await hashPassword(password);
  const now = new Date();
  (db as any).insert(schema.users).values({
    username,
    passwordHash: hash,
    providerId: 'core.local',
    scopes: JSON.stringify(scopes) as any,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }).run();

  const loginRes = await request(app)
    .post('/v1/auth/login')
    .send({ providerId: 'core.local', credentials: { username, password } });

  expect(loginRes.status).toBe(200);
  const cookies = loginRes.headers['set-cookie'] as string[];
  const sessionCookie = cookies.find((c: string) => c.startsWith('darkride_sid='))!;
  return { cookie: sessionCookie, csrfToken: loginRes.body.csrfToken };
}

describe('API Keys endpoints', () => {
  let app: express.Express;
  let db: ReturnType<typeof createTestDb>;
  let cookie: string;
  let csrfToken: string;

  beforeEach(async () => {
    const ctx = createApp();
    app = ctx.app;
    db = ctx.db;
    const auth = await loginAs(app, db, 'alice', 'test-password-123', ['core.admin:*']);
    cookie = auth.cookie;
    csrfToken = auth.csrfToken;
  });

  describe('GET /v1/profile/api-keys', () => {
    it('returns empty list initially', async () => {
      const res = await request(app)
        .get('/v1/profile/api-keys')
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/v1/profile/api-keys');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /v1/profile/api-keys', () => {
    it('creates a key and returns the plaintext', async () => {
      const res = await request(app)
        .post('/v1/profile/api-keys')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .send({ name: 'My Test Key', scopes: ['devices:read'] });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.key).toMatch(/^darkride_pat_[0-9a-f]{40}$/);
      expect(typeof res.body.data.id).toBe('number');
    });

    it('rejects wildcard scopes', async () => {
      const res = await request(app)
        .post('/v1/profile/api-keys')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .send({ name: 'Wild Key', scopes: ['devices:*'] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/v1/profile/api-keys')
        .send({ name: 'Key', scopes: ['devices:read'] });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /v1/profile/api-keys/:id', () => {
    it('revokes a key', async () => {
      // Create a key first
      const createRes = await request(app)
        .post('/v1/profile/api-keys')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .send({ name: 'To Revoke', scopes: ['devices:read'] });
      expect(createRes.status).toBe(201);
      const keyId = createRes.body.data.id;

      // Revoke it
      const deleteRes = await request(app)
        .delete(`/v1/profile/api-keys/${keyId}`)
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);

      // Verify it's gone from the list
      const listRes = await request(app)
        .get('/v1/profile/api-keys')
        .set('Cookie', cookie);
      expect(listRes.body.data).toHaveLength(0);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .delete('/v1/profile/api-keys/1')
        .set('x-csrf-token', csrfToken);
      expect(res.status).toBe(401);
    });
  });
});
