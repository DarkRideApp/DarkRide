import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '../../test-utils/create-test-db';
import * as oauthSchema from '../../db/oauth-schema';
import { OAuthTokenManager } from '../../auth/oauth-token-manager';
import { registerOAuthGrantsRoutes } from '../oauth-grants';
import { clearEndpoints, getApiRouter } from '../api-service';

describe('oauth grants API', () => {
  let app: express.Express;
  let noAuthApp: express.Express;
  let db: any;
  let tokenMgr: OAuthTokenManager;

  beforeEach(() => {
    clearEndpoints();

    db = createTestDb([
      oauthSchema.oauthClients,
      oauthSchema.oauthAccessTokens,
      oauthSchema.oauthRefreshTokens,
    ]);
    db.insert(oauthSchema.oauthClients).values({
      clientId: 'c1', clientName: 'Claude Code', redirectUris: '["http://127.0.0.1:1234/cb"]',
      createdAt: new Date(),
    }).run();
    tokenMgr = new OAuthTokenManager(db);
    tokenMgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });

    // Register routes (adds to global endpoint registry)
    registerOAuthGrantsRoutes(app as any, db);

    // Authenticated app — every request has authUser
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).authUser = { userId: 1, username: 'alice', via: 'session', effectiveScopes: new Set(['mcp']) };
      next();
    });
    app.use(getApiRouter());

    // Unauthenticated app — no authUser set
    noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use(getApiRouter());
  });

  it('GET /v1/profile/oauth-grants returns current user grants', async () => {
    const res = await request(app).get('/v1/profile/oauth-grants');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].client_id).toBe('c1');
    expect(res.body[0].client_name).toBe('Claude Code');
    expect(res.body[0].scopes).toEqual(['mcp']);
    expect(res.body[0].active_tokens).toBe(1);
  });

  it('DELETE /v1/profile/oauth-grants/:clientId revokes the grant', async () => {
    const res = await request(app).delete('/v1/profile/oauth-grants/c1');
    expect(res.status).toBe(204);

    const after = await request(app).get('/v1/profile/oauth-grants');
    expect(after.body).toHaveLength(0);
  });

  it('requires auth', async () => {
    const res = await request(noAuthApp).get('/v1/profile/oauth-grants');
    expect(res.status).toBe(401);
  });

  it('DELETE returns 204 even for unknown client (idempotent)', async () => {
    const res = await request(app).delete('/v1/profile/oauth-grants/dcr_unknown');
    expect(res.status).toBe(204);
  });
});
