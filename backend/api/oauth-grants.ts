import type { Express } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { oauthClients } from '../db/oauth-schema';
import { OAuthTokenManager } from '../auth/oauth-token-manager';
import { registerEndpoint } from './api-service';

export function registerOAuthGrantsRoutes(_app: Express, db: BetterSQLite3Database<any>): void {
  registerEndpoint('GET', '/v1/profile/oauth-grants', (req, res) => {
    const authUser = (req as any).authUser;
    if (!authUser) { res.status(401).json({ error: 'unauthorized' }); return; }
    const mgr = new OAuthTokenManager(db);
    const grants = mgr.listGrantsForUser(authUser.userId);
    const payload = grants.map(g => {
      const client = db.select().from(oauthClients).where(eq(oauthClients.clientId, g.clientId)).get();
      return {
        client_id: g.clientId,
        client_name: client?.clientName ?? '(unknown)',
        software_id: client?.softwareId ?? null,
        scopes: g.scopes,
        granted_at: Math.floor(g.grantedAt.getTime() / 1000),
        last_used_at: g.lastUsedAt ? Math.floor(g.lastUsedAt.getTime() / 1000) : null,
        active_tokens: g.activeAccessTokens,
        active_refresh_tokens: g.activeRefreshTokens,
      };
    });
    res.json(payload);
  });

  registerEndpoint('DELETE', '/v1/profile/oauth-grants/:clientId', (req, res) => {
    const authUser = (req as any).authUser;
    if (!authUser) { res.status(401).json({ error: 'unauthorized' }); return; }
    const mgr = new OAuthTokenManager(db);
    mgr.revokeGrant(authUser.userId, req.params.clientId);
    res.status(204).end();
  });
}
