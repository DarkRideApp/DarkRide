import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { oauthAccessTokens } from '../db/oauth-schema';
import { sha256Hex } from './oauth-crypto';
import { applyMigrations } from '../test-utils/create-test-db';
import { OAuthTokenManager } from './oauth-token-manager';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

describe('OAuthTokenManager.classifyAccessToken', () => {
  let db: ReturnType<typeof createTestDb>;
  let mgr: OAuthTokenManager;

  beforeEach(() => {
    db = createTestDb();
    mgr = new OAuthTokenManager(db as any);
  });

  it('returns "unknown" for a token with no matching row', () => {
    expect(mgr.classifyAccessToken('oauth_at_doesnotexist')).toBe('unknown');
  });

  it('returns "valid" for a live, unexpired, unrevoked token', () => {
    const { accessToken } = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    expect(mgr.classifyAccessToken(accessToken)).toBe('valid');
  });

  it('returns "expired" for a token past its expiry', () => {
    const { accessToken } = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'], accessTtlMs: 1000 });
    db.update(oauthAccessTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(oauthAccessTokens.tokenHash, sha256Hex(accessToken)))
      .run();
    expect(mgr.classifyAccessToken(accessToken)).toBe('expired');
  });

  it('returns "revoked" for a revoked token (revocation wins over expiry)', () => {
    const { accessToken } = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    mgr.revokeAccessToken(accessToken);
    expect(mgr.classifyAccessToken(accessToken)).toBe('revoked');
  });
});
