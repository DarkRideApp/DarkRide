import type { Express, Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { settings } from '../db/schema';
import { OAuthClientManager } from '../auth/oauth-client-manager';
import { OAuthCodeManager } from '../auth/oauth-code-manager';
import { OAuthTokenManager } from '../auth/oauth-token-manager';
import { matchesRedirectUri } from '../auth/oauth-crypto';
import { isSupportedScope } from '../auth/scopes-registry';

function getPublicBaseUrl(req: Request, db: BetterSQLite3Database<any>): string {
  const row = db.select().from(settings).where(eq(settings.key, 'oauth_public_base_url')).get();
  if (row?.value) return row.value.replace(/\/$/, '');
  const proto = req.protocol;
  const host = req.get('host') ?? 'localhost';
  return `${proto}://${host}`;
}

export function registerOAuthRoutes(app: Express, db: BetterSQLite3Database<any>): void {
  app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    const base = getPublicBaseUrl(req, db);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    const base = getPublicBaseUrl(req, db);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ['mcp'],
    });
  });

  app.post('/oauth/register', (req: Request, res: Response) => {
    const body = req.body ?? {};
    try {
      const mgr = new OAuthClientManager(db);
      const client = mgr.register({
        clientName: body.client_name,
        redirectUris: body.redirect_uris,
        grantTypes: body.grant_types,
        responseTypes: body.response_types,
        tokenEndpointAuthMethod: body.token_endpoint_auth_method,
        softwareId: body.software_id,
        softwareVersion: body.software_version,
      });
      res.status(201).json({
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: JSON.parse(client.redirectUris),
        grant_types: JSON.parse(client.grantTypes),
        response_types: JSON.parse(client.responseTypes),
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        ...(client.softwareId != null && { software_id: client.softwareId }),
        ...(client.softwareVersion != null && { software_version: client.softwareVersion }),
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      });
    } catch (err: any) {
      const msg = err.message || 'invalid request';
      const error = /redirect_uri|redirect uris|redirect_uris/i.test(msg) ? 'invalid_redirect_uri'
        : 'invalid_client_metadata';
      res.status(400).json({ error, error_description: msg });
    }
  });

  app.get('/oauth/authorize', (req: Request, res: Response) => {
    const {
      response_type, client_id, redirect_uri,
      code_challenge, code_challenge_method,
      scope, state,
    } = req.query as Record<string, string>;

    const mgr = new OAuthClientManager(db);
    const client = client_id ? mgr.getByClientId(client_id) : null;
    if (!client) {
      res.status(400).send('<h1>Unknown client</h1>');
      return;
    }

    const registered: string[] = JSON.parse(client.redirectUris);
    if (!redirect_uri || !matchesRedirectUri(registered, redirect_uri)) {
      res.status(400).send('<h1>Invalid redirect_uri</h1>');
      return;
    }

    // From here, errors can be reported via the client's redirect URI
    const errorRedirect = (error: string, description?: string) => {
      const u = new URL(redirect_uri);
      u.searchParams.set('error', error);
      if (description) u.searchParams.set('error_description', description);
      if (state) u.searchParams.set('state', state);
      res.redirect(302, u.toString());
    };

    if (response_type !== 'code') return errorRedirect('unsupported_response_type');
    if (!code_challenge) return errorRedirect('invalid_request', 'code_challenge is required');
    if (code_challenge_method !== 'S256') return errorRedirect('invalid_request', 'only S256 is supported');

    const requestedScopes = (scope ?? 'mcp').split(/\s+/).filter(Boolean);
    for (const s of requestedScopes) {
      if (!isSupportedScope(s)) return errorRedirect('invalid_scope', `unknown scope: ${s}`);
    }

    const authUser = (req as any).authUser;
    const fullUrl = req.originalUrl;
    if (!authUser) {
      res.redirect(302, `/ui/login?next=${encodeURIComponent(fullUrl)}`);
      return;
    }

    const consent = new URLSearchParams(req.query as Record<string, string>);
    res.redirect(302, `/ui/oauth/consent?${consent.toString()}`);
  });

  app.post('/oauth/authorize/consent', (req: Request, res: Response) => {
    const authUser = (req as any).authUser;
    if (!authUser) { res.status(401).json({ error: 'unauthorized' }); return; }

    const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, allow } = req.body ?? {};

    const mgr = new OAuthClientManager(db);
    const client = client_id ? mgr.getByClientId(client_id) : null;
    if (!client) { res.status(400).json({ error: 'invalid_client' }); return; }

    const registered: string[] = JSON.parse(client.redirectUris);
    if (!matchesRedirectUri(registered, redirect_uri)) { res.status(400).json({ error: 'invalid_redirect_uri' }); return; }

    const url = new URL(redirect_uri);
    // The frontend follows up with window.location.href = body.location so the
    // browser performs a top-level navigation to the client's redirect_uri.
    // We can't use res.redirect(302) here because the consent page POSTs via
    // fetch() — following a cross-origin redirect to the client's loopback
    // listener would be CORS-blocked and surface as "Failed to fetch".
    const isAllow = allow === true || allow === 'true';
    if (!isAllow) {
      url.searchParams.set('error', 'access_denied');
      if (state) url.searchParams.set('state', state);
      res.status(200).json({ location: url.toString() });
      return;
    }

    if (!code_challenge || code_challenge_method !== 'S256') {
      res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge + S256 required' });
      return;
    }

    const requestedScopes = (scope ?? 'mcp').split(/\s+/).filter(Boolean);
    for (const s of requestedScopes) {
      if (!isSupportedScope(s)) { res.status(400).json({ error: 'invalid_scope' }); return; }
    }

    const codeMgr = new OAuthCodeManager(db);
    const { code } = codeMgr.create({
      clientId: client.clientId,
      userId: authUser.userId,
      scopes: requestedScopes,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
    });

    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.status(200).json({ location: url.toString() });
  });

  app.get('/oauth/client-info/:clientId', (req: Request, res: Response) => {
    const mgr = new OAuthClientManager(db);
    const client = mgr.getByClientId(req.params.clientId);
    if (!client) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: JSON.parse(client.redirectUris),
      ...(client.softwareId != null && { software_id: client.softwareId }),
      ...(client.softwareVersion != null && { software_version: client.softwareVersion }),
    });
  });

  app.post('/oauth/token', (req: Request, res: Response) => {
    const body = req.body ?? {};
    const grantType = body.grant_type;

    if (grantType === 'authorization_code') {
      const { code, redirect_uri, client_id, code_verifier } = body;
      if (!code || !redirect_uri || !client_id || !code_verifier) {
        res.status(400).json({ error: 'invalid_request', error_description: 'missing required parameter' });
        return;
      }
      const codeMgr = new OAuthCodeManager(db);
      const result = codeMgr.redeem({ code, clientId: client_id, redirectUri: redirect_uri, codeVerifier: code_verifier });
      if (!result.ok) {
        res.status(400).json({ error: 'invalid_grant', error_description: result.reason });
        return;
      }
      const tokenMgr = new OAuthTokenManager(db);
      const issued = tokenMgr.issuePair({ clientId: result.clientId, userId: result.userId, scopes: result.scopes });
      const clientMgr = new OAuthClientManager(db);
      clientMgr.touchLastUsed(result.clientId);
      res.json({
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.accessExpiresIn,
        refresh_token: issued.refreshToken,
        scope: result.scopes.join(' '),
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const { refresh_token, client_id } = body;
      if (!refresh_token || !client_id) {
        res.status(400).json({ error: 'invalid_request', error_description: 'missing required parameter' });
        return;
      }
      const tokenMgr = new OAuthTokenManager(db);
      const rotated = tokenMgr.rotateRefreshToken(refresh_token, client_id);
      if (!rotated.ok) {
        res.status(400).json({ error: 'invalid_grant', error_description: rotated.reason });
        return;
      }
      res.json({
        access_token: rotated.accessToken,
        token_type: 'Bearer',
        expires_in: rotated.accessExpiresIn,
        refresh_token: rotated.refreshToken,
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  app.post('/oauth/revoke', (req: Request, res: Response) => {
    const { token } = req.body ?? {};
    if (typeof token !== 'string' || !token) { res.status(200).end(); return; }
    const tokenMgr = new OAuthTokenManager(db);
    if (token.startsWith('oauth_at_')) tokenMgr.revokeAccessToken(token);
    else if (token.startsWith('oauth_rt_')) tokenMgr.revokeRefreshToken(token);
    res.status(200).end();
  });
}
