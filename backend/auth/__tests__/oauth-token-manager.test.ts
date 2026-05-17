import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import * as oauthSchema from '../../db/oauth-schema';
import { OAuthTokenManager } from '../oauth-token-manager';

describe('OAuthTokenManager', () => {
  let db: any;
  let mgr: OAuthTokenManager;

  beforeEach(() => {
    db = createTestDb([oauthSchema.oauthAccessTokens, oauthSchema.oauthRefreshTokens]);
    mgr = new OAuthTokenManager(db);
  });

  it('issues an access + refresh token pair', () => {
    const { accessToken, refreshToken, accessExpiresIn } = mgr.issuePair({
      clientId: 'c1', userId: 1, scopes: ['mcp'],
    });
    expect(accessToken).toMatch(/^oauth_at_[0-9a-f]{40}$/);
    expect(refreshToken).toMatch(/^oauth_rt_[0-9a-f]{40}$/);
    expect(accessExpiresIn).toBeGreaterThan(0);
  });

  it('findAccessTokenByPlaintext returns record for valid token', () => {
    const { accessToken } = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    const row = mgr.findAccessTokenByPlaintext(accessToken);
    expect(row?.userId).toBe(1);
    expect(row?.clientId).toBe('c1');
  });

  it('findAccessTokenByPlaintext returns null for unknown token', () => {
    expect(mgr.findAccessTokenByPlaintext('oauth_at_unknown')).toBeNull();
  });

  it('rotates refresh token: old revoked, new issued', () => {
    const first = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    const result = mgr.rotateRefreshToken(first.refreshToken, 'c1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const replay = mgr.rotateRefreshToken(first.refreshToken, 'c1');
    expect(replay.ok).toBe(false);

    expect(result.refreshToken).not.toBe(first.refreshToken);
    expect(result.accessToken).not.toBe(first.accessToken);
  });

  it('detected reuse of old RT revokes all (user, client) tokens', () => {
    const first = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    const second = mgr.rotateRefreshToken(first.refreshToken, 'c1');
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const replay = mgr.rotateRefreshToken(first.refreshToken, 'c1');
    expect(replay.ok).toBe(false);

    const afterReplay = mgr.rotateRefreshToken(second.refreshToken, 'c1');
    expect(afterReplay.ok).toBe(false);

    const atRow = mgr.findAccessTokenByPlaintext(first.accessToken);
    expect(atRow).toBeNull();

    // The AT issued during the legitimate rotation is also revoked — this is
    // the token a theft attacker would be holding.
    expect(mgr.findAccessTokenByPlaintext(second.accessToken)).toBeNull();
  });

  it('rejects rotation with wrong client_id', () => {
    const first = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    const result = mgr.rotateRefreshToken(first.refreshToken, 'c2');
    expect(result.ok).toBe(false);
  });

  it('rejects expired refresh token', () => {
    const first = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'], refreshTtlMs: -1000 });
    const result = mgr.rotateRefreshToken(first.refreshToken, 'c1');
    expect(result.ok).toBe(false);
  });

  it('revokeGrant revokes all AT+RT for (user, client)', () => {
    const first = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    mgr.revokeGrant(1, 'c1');

    expect(mgr.findAccessTokenByPlaintext(first.accessToken)).toBeNull();
    const reuse = mgr.rotateRefreshToken(first.refreshToken, 'c1');
    expect(reuse.ok).toBe(false);
  });

  it('revokeAccessToken revokes single token', () => {
    const { accessToken } = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    mgr.revokeAccessToken(accessToken);
    expect(mgr.findAccessTokenByPlaintext(accessToken)).toBeNull();
  });

  it('revokeRefreshToken revokes single RT', () => {
    const { refreshToken } = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    mgr.revokeRefreshToken(refreshToken);
    const r = mgr.rotateRefreshToken(refreshToken, 'c1');
    expect(r.ok).toBe(false);
  });

  it('revokeRefreshToken does NOT cascade to the paired AT', () => {
    const { accessToken, refreshToken } = mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    mgr.revokeRefreshToken(refreshToken);
    // Paired AT is still valid until it expires or is revoked individually
    expect(mgr.findAccessTokenByPlaintext(accessToken)?.userId).toBe(1);
  });

  it('listGrantsForUser returns one entry per (user, client) with counts', () => {
    mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    mgr.issuePair({ clientId: 'c1', userId: 1, scopes: ['mcp'] });
    mgr.issuePair({ clientId: 'c2', userId: 1, scopes: ['mcp'] });
    mgr.issuePair({ clientId: 'c1', userId: 2, scopes: ['mcp'] });
    const grants = mgr.listGrantsForUser(1);
    expect(grants).toHaveLength(2);
    expect(grants.find(g => g.clientId === 'c1')?.activeRefreshTokens).toBe(2);
    expect(grants.find(g => g.clientId === 'c2')?.activeRefreshTokens).toBe(1);
  });
});
