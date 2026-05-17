import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import * as oauthSchema from '../oauth-schema';

describe('oauth schema', () => {
  it('has all four oauth tables with required columns', () => {
    const db = createTestDb([
      oauthSchema.oauthClients,
      oauthSchema.oauthAuthorizationCodes,
      oauthSchema.oauthAccessTokens,
      oauthSchema.oauthRefreshTokens,
    ]);

    const client = db.insert(oauthSchema.oauthClients).values({
      clientId: 'dcr_test',
      clientName: 'Test Client',
      redirectUris: '["http://127.0.0.1:1234/cb"]',
      createdAt: new Date(),
    }).returning().get();
    expect(client.id).toBeGreaterThan(0);
    expect(client.grantTypes).toBe('["authorization_code","refresh_token"]');
    expect(client.tokenEndpointAuthMethod).toBe('none');

    const code = db.insert(oauthSchema.oauthAuthorizationCodes).values({
      codeHash: 'h', clientId: 'dcr_test', userId: 1,
      scopes: '["mcp"]', redirectUri: 'http://127.0.0.1:1234/cb',
      codeChallenge: 'c', codeChallengeMethod: 'S256',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    }).returning().get();
    expect(code.id).toBeGreaterThan(0);

    const at = db.insert(oauthSchema.oauthAccessTokens).values({
      tokenHash: 'h1', tokenPrefix: 'ab', clientId: 'dcr_test', userId: 1,
      scopes: '["mcp"]', issuedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
    }).returning().get();
    expect(at.id).toBeGreaterThan(0);

    const rt = db.insert(oauthSchema.oauthRefreshTokens).values({
      tokenHash: 'h2', clientId: 'dcr_test', userId: 1,
      scopes: '["mcp"]', issuedAt: new Date(), expiresAt: new Date(Date.now() + 86400_000),
    }).returning().get();
    expect(rt.id).toBeGreaterThan(0);
  });
});
