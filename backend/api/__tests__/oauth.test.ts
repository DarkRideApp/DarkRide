import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '../../test-utils/create-test-db';
import * as oauthSchema from '../../db/oauth-schema';
import { settings as settingsSchema } from '../../db/schema';
import { registerOAuthRoutes } from '../oauth';

describe('oauth metadata endpoints', () => {
  let app: express.Express;
  let db: any;

  beforeEach(() => {
    db = createTestDb([oauthSchema.oauthClients, settingsSchema]);
    app = express();
    app.use(express.json());
    registerOAuthRoutes(app, db);
  });

  it('GET /.well-known/oauth-authorization-server returns metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBeDefined();
    expect(res.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(res.body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(res.body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(res.body.revocation_endpoint).toMatch(/\/oauth\/revoke$/);
    expect(res.body.response_types_supported).toEqual(['code']);
    expect(res.body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(res.body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(res.body.scopes_supported).toEqual(['mcp']);
  });

  it('GET /.well-known/oauth-protected-resource returns resource metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toMatch(/\/mcp$/);
    expect(Array.isArray(res.body.authorization_servers)).toBe(true);
    expect(res.body.scopes_supported).toEqual(['mcp']);
  });

  it('issuer uses oauth_public_base_url setting when set', async () => {
    db.insert(settingsSchema).values({ key: 'oauth_public_base_url', value: 'https://darkride.example.com' }).run();
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.issuer).toBe('https://darkride.example.com');
    expect(res.body.token_endpoint).toBe('https://darkride.example.com/oauth/token');
  });

  it('falls back to Host header when setting is absent', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server').set('Host', 'fallback.example.com');
    expect(res.body.issuer).toMatch(/fallback\.example\.com/);
  });
});

describe('POST /oauth/register', () => {
  let app: express.Express;
  let db: any;

  beforeEach(() => {
    db = createTestDb([oauthSchema.oauthClients, settingsSchema]);
    app = express();
    app.use(express.json());
    registerOAuthRoutes(app, db);
  });

  it('registers a client with required fields', async () => {
    const res = await request(app).post('/oauth/register').send({
      client_name: 'Claude Code',
      redirect_uris: ['http://127.0.0.1:33418/cb'],
    });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^dcr_[0-9a-f]{40}$/);
    expect(res.body.client_name).toBe('Claude Code');
    expect(res.body.redirect_uris).toEqual(['http://127.0.0.1:33418/cb']);
    expect(res.body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(res.body.response_types).toEqual(['code']);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.body.client_id_issued_at).toBeGreaterThan(0);
  });

  it('returns 400 when redirect_uris is missing', async () => {
    const res = await request(app).post('/oauth/register').send({ client_name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('returns 400 for invalid redirect URI', async () => {
    const res = await request(app).post('/oauth/register').send({
      client_name: 'X', redirect_uris: ['not-a-url'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('returns 400 for non-loopback http URI', async () => {
    const res = await request(app).post('/oauth/register').send({
      client_name: 'X', redirect_uris: ['http://evil.example.com/cb'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects token_endpoint_auth_method other than none', async () => {
    const res = await request(app).post('/oauth/register').send({
      client_name: 'X', redirect_uris: ['http://127.0.0.1/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when client_name is empty', async () => {
    const res = await request(app).post('/oauth/register').send({
      client_name: '  ', redirect_uris: ['http://127.0.0.1/cb'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });
});

describe('GET /oauth/authorize', () => {
  let app: express.Express;
  let db: any;
  let clientId: string;

  beforeEach(async () => {
    db = createTestDb([oauthSchema.oauthClients, settingsSchema]);
    app = express();
    app.use(express.json());

    // Helper middleware: attach fake session authUser on any request that has `?test_user=1`
    app.use((req, _res, next) => {
      if (req.query.test_user === '1') {
        (req as any).authUser = { userId: 1, username: 'alice', via: 'session', effectiveScopes: new Set(['mcp']) };
      }
      next();
    });

    registerOAuthRoutes(app, db);

    const reg = await request(app).post('/oauth/register').send({
      client_name: 'Test', redirect_uris: ['http://127.0.0.1:1234/cb'],
    });
    clientId = reg.body.client_id;
  });

  it('redirects to /ui/login?next=... when unauthenticated', async () => {
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code', client_id: clientId,
      redirect_uri: 'http://127.0.0.1:1234/cb',
      code_challenge: 'x', code_challenge_method: 'S256',
      scope: 'mcp', state: 'abc',
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/ui\/login\?next=/);
  });

  it('redirects to /ui/oauth/consent when authenticated', async () => {
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code', client_id: clientId,
      redirect_uri: 'http://127.0.0.1:1234/cb',
      code_challenge: 'x', code_challenge_method: 'S256',
      scope: 'mcp', state: 'abc', test_user: '1',
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/ui\/oauth\/consent\?/);
  });

  it('returns 400 HTML when client_id is unknown', async () => {
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code', client_id: 'dcr_nonexistent',
      redirect_uri: 'http://127.0.0.1:1234/cb',
      code_challenge: 'x', code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 HTML when redirect_uri does not match registered', async () => {
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code', client_id: clientId,
      redirect_uri: 'http://attacker.example.com/cb',
      code_challenge: 'x', code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
  });

  it('redirects to client with error when response_type is unsupported', async () => {
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'token', client_id: clientId,
      redirect_uri: 'http://127.0.0.1:1234/cb',
      code_challenge: 'x', code_challenge_method: 'S256',
      state: 'xyz',
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/127\.0\.0\.1:1234\/cb\?/);
    expect(res.headers.location).toMatch(/error=unsupported_response_type/);
    expect(res.headers.location).toMatch(/state=xyz/);
  });

  it('redirects to client with error when code_challenge_method is not S256', async () => {
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code', client_id: clientId,
      redirect_uri: 'http://127.0.0.1:1234/cb',
      code_challenge: 'x', code_challenge_method: 'plain',
      state: 'abc',
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=invalid_request/);
  });
});

describe('POST /oauth/authorize/consent', () => {
  let app: express.Express;
  let db: any;
  let clientId: string;

  beforeEach(async () => {
    db = createTestDb([
      oauthSchema.oauthClients,
      oauthSchema.oauthAuthorizationCodes,
      settingsSchema,
    ]);
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => {
      (req as any).authUser = { userId: 1, username: 'alice', via: 'session', effectiveScopes: new Set(['mcp']) };
      next();
    });
    registerOAuthRoutes(app, db);
    const reg = await request(app).post('/oauth/register').send({
      client_name: 'Test', redirect_uris: ['http://127.0.0.1:1234/cb'],
    });
    clientId = reg.body.client_id;
  });

  it('allow=true: issues code and returns client redirect_uri with code+state', async () => {
    const res = await request(app).post('/oauth/authorize/consent').send({
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:1234/cb',
      scope: 'mcp',
      state: 'xyz',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      allow: true,
    });
    expect(res.status).toBe(200);
    const url = new URL(res.body.location);
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:1234/cb');
    expect(url.searchParams.get('code')).toMatch(/^[0-9a-f]{40}$/);
    expect(url.searchParams.get('state')).toBe('xyz');
  });

  it('allow=false: returns location with error=access_denied', async () => {
    const res = await request(app).post('/oauth/authorize/consent').send({
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:1234/cb',
      state: 'xyz',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      allow: false,
    });
    expect(res.status).toBe(200);
    const url = new URL(res.body.location);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('xyz');
  });

  it('requires authentication (no authUser → 401)', async () => {
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use(express.urlencoded({ extended: false }));
    registerOAuthRoutes(noAuthApp, db);
    const res = await request(noAuthApp).post('/oauth/authorize/consent').send({
      client_id: clientId, redirect_uri: 'http://127.0.0.1:1234/cb',
      allow: true, code_challenge: 'c', code_challenge_method: 'S256',
    });
    expect(res.status).toBe(401);
  });

  it('rejects mismatched redirect_uri', async () => {
    const res = await request(app).post('/oauth/authorize/consent').send({
      client_id: clientId,
      redirect_uri: 'http://attacker.example.com/cb',
      allow: true, code_challenge: 'c', code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /oauth/token', () => {
  let app: express.Express;
  let db: any;
  let clientId: string;
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  beforeEach(async () => {
    db = createTestDb([
      oauthSchema.oauthClients,
      oauthSchema.oauthAuthorizationCodes,
      oauthSchema.oauthAccessTokens,
      oauthSchema.oauthRefreshTokens,
      settingsSchema,
    ]);
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => {
      (req as any).authUser = { userId: 1, username: 'alice', via: 'session', effectiveScopes: new Set(['mcp']) };
      next();
    });
    registerOAuthRoutes(app, db);
    const reg = await request(app).post('/oauth/register').send({
      client_name: 'Test', redirect_uris: ['http://127.0.0.1:1234/cb'],
    });
    clientId = reg.body.client_id;
  });

  async function getCode(): Promise<string> {
    const res = await request(app).post('/oauth/authorize/consent').send({
      client_id: clientId, redirect_uri: 'http://127.0.0.1:1234/cb',
      scope: 'mcp', state: 's', code_challenge: CHALLENGE, code_challenge_method: 'S256',
      allow: true,
    });
    return new URL(res.body.location).searchParams.get('code')!;
  }

  it('authorization_code: exchanges code for tokens', async () => {
    const code = await getCode();
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code, redirect_uri: 'http://127.0.0.1:1234/cb',
      client_id: clientId, code_verifier: VERIFIER,
    });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toMatch(/^oauth_at_[0-9a-f]{40}$/);
    expect(res.body.refresh_token).toMatch(/^oauth_rt_[0-9a-f]{40}$/);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBeGreaterThan(0);
    expect(res.body.scope).toBe('mcp');
  });

  it('rejects code exchange with wrong PKCE verifier', async () => {
    const code = await getCode();
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code, redirect_uri: 'http://127.0.0.1:1234/cb',
      client_id: clientId, code_verifier: 'wrong-verifier',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects second exchange of same code', async () => {
    const code = await getCode();
    await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code, redirect_uri: 'http://127.0.0.1:1234/cb',
      client_id: clientId, code_verifier: VERIFIER,
    });
    const replay = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code, redirect_uri: 'http://127.0.0.1:1234/cb',
      client_id: clientId, code_verifier: VERIFIER,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  it('refresh_token: rotates, old RT is invalidated', async () => {
    const code = await getCode();
    const first = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code, redirect_uri: 'http://127.0.0.1:1234/cb',
      client_id: clientId, code_verifier: VERIFIER,
    });
    const oldRt = first.body.refresh_token;

    const refresh = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: oldRt, client_id: clientId,
    });
    expect(refresh.status).toBe(200);
    expect(refresh.body.refresh_token).not.toBe(oldRt);

    const replay = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: oldRt, client_id: clientId,
    });
    expect(replay.status).toBe(400);
  });

  it('rejects unsupported grant_type', async () => {
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'password', username: 'x', password: 'y',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('rejects missing code_verifier', async () => {
    const code = await getCode();
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code, redirect_uri: 'http://127.0.0.1:1234/cb',
      client_id: clientId,
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /oauth/client-info/:clientId', () => {
  let app: express.Express;
  let db: any;
  let clientId: string;

  beforeEach(async () => {
    db = createTestDb([oauthSchema.oauthClients, settingsSchema]);
    app = express();
    app.use(express.json());
    registerOAuthRoutes(app, db);
    const reg = await request(app).post('/oauth/register').send({
      client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:1234/cb'],
      software_id: 'com.anthropic.claude-code',
    });
    clientId = reg.body.client_id;
  });

  it('returns public client info', async () => {
    const res = await request(app).get(`/oauth/client-info/${clientId}`);
    expect(res.status).toBe(200);
    expect(res.body.client_id).toBe(clientId);
    expect(res.body.client_name).toBe('Claude Code');
    expect(res.body.redirect_uris).toEqual(['http://127.0.0.1:1234/cb']);
    expect(res.body.software_id).toBe('com.anthropic.claude-code');
  });

  it('returns 404 for unknown client', async () => {
    const res = await request(app).get('/oauth/client-info/dcr_nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('POST /oauth/revoke', () => {
  let app: express.Express;
  let db: any;
  let clientId: string;
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  beforeEach(async () => {
    db = createTestDb([
      oauthSchema.oauthClients,
      oauthSchema.oauthAuthorizationCodes,
      oauthSchema.oauthAccessTokens,
      oauthSchema.oauthRefreshTokens,
      settingsSchema,
    ]);
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => {
      (req as any).authUser = { userId: 1, username: 'alice', via: 'session', effectiveScopes: new Set(['mcp']) };
      next();
    });
    registerOAuthRoutes(app, db);
    const reg = await request(app).post('/oauth/register').send({
      client_name: 'Test', redirect_uris: ['http://127.0.0.1:1234/cb'],
    });
    clientId = reg.body.client_id;
  });

  it('revokes an access token', async () => {
    const consent = await request(app).post('/oauth/authorize/consent').send({
      client_id: clientId, redirect_uri: 'http://127.0.0.1:1234/cb', scope: 'mcp',
      state: 's', code_challenge: CHALLENGE, code_challenge_method: 'S256', allow: true,
    });
    const code = new URL(consent.body.location).searchParams.get('code')!;
    const tokens = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code,
      redirect_uri: 'http://127.0.0.1:1234/cb', client_id: clientId, code_verifier: VERIFIER,
    });
    const at = tokens.body.access_token;

    const res = await request(app).post('/oauth/revoke').type('form').send({ token: at });
    expect(res.status).toBe(200);
  });

  it('returns 200 even for unknown tokens', async () => {
    const res = await request(app).post('/oauth/revoke').type('form').send({ token: 'oauth_at_unknown' });
    expect(res.status).toBe(200);
  });
});
