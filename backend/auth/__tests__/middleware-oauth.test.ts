import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/create-test-db';
import * as oauthSchema from '../../db/oauth-schema';
import { users, sessions, apiKeys } from '../../db/schema';
import { createAuthMiddleware } from '../middleware';
import { OAuthTokenManager } from '../oauth-token-manager';

describe('middleware — oauth_at bearer path', () => {
  let app: express.Express;
  let db: any;
  let mgr: OAuthTokenManager;

  beforeEach(() => {
    db = createTestDb([
      users, sessions, apiKeys,
      oauthSchema.oauthClients,
      oauthSchema.oauthAccessTokens,
      oauthSchema.oauthRefreshTokens,
    ]);
    db.insert(users).values({
      id: 1, username: 'alice', providerId: 'core.local',
      scopes: '["mcp","core.devices:read"]', enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    }).run();
    mgr = new OAuthTokenManager(db);

    app = express();
    const mw = createAuthMiddleware(db, [], []);
    app.use(mw);
    app.get('/whoami', (req, res) => {
      const u = (req as any).authUser;
      if (!u) return res.status(401).json(null);
      res.json({
        userId: u.userId, username: u.username, via: u.via,
        effectiveScopes: Array.from(u.effectiveScopes),
      });
    });
  });

  it('accepts a valid oauth_at token', async () => {
    const { accessToken } = mgr.issuePair({ clientId: 'c', userId: 1, scopes: ['mcp'] });
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('alice');
    expect(res.body.via).toBe('oauth');
    expect(res.body.effectiveScopes).toContain('mcp');
    expect(res.body.effectiveScopes).toContain('core.devices:read');
  });

  it('rejects a revoked oauth_at token', async () => {
    const { accessToken } = mgr.issuePair({ clientId: 'c', userId: 1, scopes: ['mcp'] });
    mgr.revokeAccessToken(accessToken);
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired oauth_at token', async () => {
    const { accessToken } = mgr.issuePair({ clientId: 'c', userId: 1, scopes: ['mcp'], accessTtlMs: -1000 });
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });

  it('rejects oauth_at for a disabled user', async () => {
    const { accessToken } = mgr.issuePair({ clientId: 'c', userId: 1, scopes: ['mcp'] });
    db.update(users).set({ enabled: false }).where(eq(users.id, 1)).run();
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });
});
