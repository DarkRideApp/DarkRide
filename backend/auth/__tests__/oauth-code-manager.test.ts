import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import * as oauthSchema from '../../db/oauth-schema';
import { OAuthCodeManager } from '../oauth-code-manager';

describe('OAuthCodeManager', () => {
  let db: any;
  let mgr: OAuthCodeManager;
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  beforeEach(() => {
    db = createTestDb([oauthSchema.oauthAuthorizationCodes]);
    mgr = new OAuthCodeManager(db);
  });

  it('creates a code and returns plaintext + stored record', () => {
    const { code, record } = mgr.create({
      clientId: 'c1', userId: 1, scopes: ['mcp'],
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: CHALLENGE, codeChallengeMethod: 'S256',
    });
    expect(code).toMatch(/^[0-9a-f]{40}$/);
    expect(record.clientId).toBe('c1');
    expect(record.redeemedAt).toBeNull();
  });

  it('redeems a valid code with matching verifier', () => {
    const { code } = mgr.create({
      clientId: 'c1', userId: 1, scopes: ['mcp'],
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: CHALLENGE, codeChallengeMethod: 'S256',
    });
    const result = mgr.redeem({
      code, clientId: 'c1',
      redirectUri: 'http://127.0.0.1/cb',
      codeVerifier: VERIFIER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(1);
      expect(result.scopes).toEqual(['mcp']);
    }
  });

  it('rejects redemption with wrong client_id', () => {
    const { code } = mgr.create({
      clientId: 'c1', userId: 1, scopes: ['mcp'],
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: CHALLENGE, codeChallengeMethod: 'S256',
    });
    const r = mgr.redeem({ code, clientId: 'c2', redirectUri: 'http://127.0.0.1/cb', codeVerifier: VERIFIER });
    expect(r.ok).toBe(false);
  });

  it('rejects redemption with wrong redirect_uri', () => {
    const { code } = mgr.create({
      clientId: 'c1', userId: 1, scopes: ['mcp'],
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: CHALLENGE, codeChallengeMethod: 'S256',
    });
    const r = mgr.redeem({ code, clientId: 'c1', redirectUri: 'http://127.0.0.1/other', codeVerifier: VERIFIER });
    expect(r.ok).toBe(false);
  });

  it('rejects redemption with wrong PKCE verifier', () => {
    const { code } = mgr.create({
      clientId: 'c1', userId: 1, scopes: ['mcp'],
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: CHALLENGE, codeChallengeMethod: 'S256',
    });
    const r = mgr.redeem({ code, clientId: 'c1', redirectUri: 'http://127.0.0.1/cb', codeVerifier: 'wrong' });
    expect(r.ok).toBe(false);
  });

  it('rejects second redemption (single-use)', () => {
    const { code } = mgr.create({
      clientId: 'c1', userId: 1, scopes: ['mcp'],
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: CHALLENGE, codeChallengeMethod: 'S256',
    });
    mgr.redeem({ code, clientId: 'c1', redirectUri: 'http://127.0.0.1/cb', codeVerifier: VERIFIER });
    const r2 = mgr.redeem({ code, clientId: 'c1', redirectUri: 'http://127.0.0.1/cb', codeVerifier: VERIFIER });
    expect(r2.ok).toBe(false);
  });

  it('rejects expired code', () => {
    const { code } = mgr.create({
      clientId: 'c1', userId: 1, scopes: ['mcp'],
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: CHALLENGE, codeChallengeMethod: 'S256',
      ttlMs: -1000,
    });
    const r = mgr.redeem({ code, clientId: 'c1', redirectUri: 'http://127.0.0.1/cb', codeVerifier: VERIFIER });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown code', () => {
    const r = mgr.redeem({
      code: 'deadbeef' + '0'.repeat(32), clientId: 'c1',
      redirectUri: 'http://127.0.0.1/cb', codeVerifier: VERIFIER,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects codeChallengeMethod other than S256 at create time', () => {
    expect(() => mgr.create({
      clientId: 'c1', userId: 1, scopes: ['mcp'],
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: 'x', codeChallengeMethod: 'plain',
    })).toThrow(/S256/i);
  });
});
