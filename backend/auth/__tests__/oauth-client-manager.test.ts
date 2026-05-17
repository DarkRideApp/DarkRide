import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import * as oauthSchema from '../../db/oauth-schema';
import { OAuthClientManager } from '../oauth-client-manager';

describe('OAuthClientManager', () => {
  let db: any;
  let mgr: OAuthClientManager;

  beforeEach(() => {
    db = createTestDb([oauthSchema.oauthClients]);
    mgr = new OAuthClientManager(db);
  });

  it('registers a client with valid redirect URIs', () => {
    const c = mgr.register({
      clientName: 'Claude Code',
      redirectUris: ['http://127.0.0.1:33418/cb'],
    });
    expect(c.clientId).toMatch(/^dcr_[0-9a-f]{40}$/);
    expect(c.clientName).toBe('Claude Code');
  });

  it('defaults grantTypes and responseTypes', () => {
    const c = mgr.register({ clientName: 'X', redirectUris: ['http://127.0.0.1/cb'] });
    expect(JSON.parse(c.grantTypes)).toEqual(['authorization_code', 'refresh_token']);
    expect(JSON.parse(c.responseTypes)).toEqual(['code']);
    expect(c.tokenEndpointAuthMethod).toBe('none');
  });

  it('rejects empty clientName', () => {
    expect(() => mgr.register({ clientName: '  ', redirectUris: ['http://127.0.0.1/cb'] }))
      .toThrow(/client_name/i);
  });

  it('rejects empty redirect URIs', () => {
    expect(() => mgr.register({ clientName: 'X', redirectUris: [] }))
      .toThrow(/redirect_uri/i);
  });

  it('rejects invalid redirect URI', () => {
    expect(() => mgr.register({ clientName: 'X', redirectUris: ['not-a-url'] }))
      .toThrow(/redirect_uri/i);
  });

  it('rejects non-loopback http URIs', () => {
    expect(() => mgr.register({ clientName: 'X', redirectUris: ['http://evil.example.com/cb'] }))
      .toThrow(/http.*loopback/i);
  });

  it('accepts https URIs', () => {
    const c = mgr.register({ clientName: 'X', redirectUris: ['https://app.example.com/cb'] });
    expect(c.clientId).toBeTruthy();
  });

  it('rejects tokenEndpointAuthMethod other than none', () => {
    expect(() => mgr.register({
      clientName: 'X',
      redirectUris: ['http://127.0.0.1/cb'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    })).toThrow(/token_endpoint_auth_method/i);
  });

  it('getByClientId returns client or null', () => {
    const c = mgr.register({ clientName: 'X', redirectUris: ['http://127.0.0.1/cb'] });
    expect(mgr.getByClientId(c.clientId)?.id).toBe(c.id);
    expect(mgr.getByClientId('dcr_unknown')).toBeNull();
  });

  it('touchLastUsed updates lastUsedAt', () => {
    const c = mgr.register({ clientName: 'X', redirectUris: ['http://127.0.0.1/cb'] });
    expect(c.lastUsedAt).toBeNull();
    mgr.touchLastUsed(c.clientId);
    const after = mgr.getByClientId(c.clientId);
    expect(after?.lastUsedAt).toBeInstanceOf(Date);
  });
});
