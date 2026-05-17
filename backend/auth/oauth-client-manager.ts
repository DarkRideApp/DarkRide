import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { oauthClients } from '../db/oauth-schema';
import { generateToken } from './oauth-crypto';

export interface RegisterClientInput {
  clientName: string;
  redirectUris: string[];
  grantTypes?: string[];
  responseTypes?: string[];
  tokenEndpointAuthMethod?: string;
  softwareId?: string;
  softwareVersion?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function validateRedirectUri(uri: string): void {
  let url: URL;
  try { url = new URL(uri); } catch { throw new Error(`invalid redirect_uri: ${uri}`); }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new Error(`invalid redirect_uri: http scheme is only allowed for loopback hosts; got ${uri}`);
}

export class OAuthClientManager {
  constructor(private db: BetterSQLite3Database<Record<string, unknown>>) {}

  register(input: RegisterClientInput) {
    const name = input.clientName?.trim() ?? '';
    if (!name) throw new Error('client_name is required');
    if (name.length > 200) throw new Error('client_name too long');

    if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
      throw new Error('redirect_uris is required and must be non-empty');
    }
    for (const uri of input.redirectUris) validateRedirectUri(uri);

    if (input.tokenEndpointAuthMethod && input.tokenEndpointAuthMethod !== 'none') {
      throw new Error(`unsupported token_endpoint_auth_method: ${input.tokenEndpointAuthMethod}; only 'none' is accepted`);
    }

    const grantTypes = input.grantTypes ?? ['authorization_code', 'refresh_token'];
    const responseTypes = input.responseTypes ?? ['code'];

    const clientId = generateToken('dcr_');
    return this.db.insert(oauthClients).values({
      clientId,
      clientName: name,
      redirectUris: JSON.stringify(input.redirectUris),
      grantTypes: JSON.stringify(grantTypes),
      responseTypes: JSON.stringify(responseTypes),
      tokenEndpointAuthMethod: 'none',
      softwareId: input.softwareId ?? null,
      softwareVersion: input.softwareVersion ?? null,
      createdAt: new Date(),
    }).returning().get();
  }

  getByClientId(clientId: string) {
    return this.db.select().from(oauthClients)
      .where(eq(oauthClients.clientId, clientId)).get() ?? null;
  }

  touchLastUsed(clientId: string): void {
    this.db.update(oauthClients).set({ lastUsedAt: new Date() })
      .where(eq(oauthClients.clientId, clientId)).run();
  }
}
