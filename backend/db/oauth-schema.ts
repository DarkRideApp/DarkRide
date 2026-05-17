import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const oauthClients = sqliteTable('oauth_clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: text('client_id').notNull().unique(),
  clientName: text('client_name').notNull(),
  redirectUris: text('redirect_uris').notNull(),
  grantTypes: text('grant_types').notNull().default('["authorization_code","refresh_token"]'),
  responseTypes: text('response_types').notNull().default('["code"]'),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
  softwareId: text('software_id'),
  softwareVersion: text('software_version'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
});

export const oauthAuthorizationCodes = sqliteTable('oauth_authorization_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  codeHash: text('code_hash').notNull().unique(),
  clientId: text('client_id').notNull(),
  userId: integer('user_id').notNull(),
  scopes: text('scopes').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  redeemedAt: integer('redeemed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const oauthAccessTokens = sqliteTable('oauth_access_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  clientId: text('client_id').notNull(),
  userId: integer('user_id').notNull(),
  scopes: text('scopes').notNull(),
  refreshTokenId: integer('refresh_token_id'),
  issuedAt: integer('issued_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
});

export const oauthRefreshTokens = sqliteTable('oauth_refresh_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenHash: text('token_hash').notNull().unique(),
  clientId: text('client_id').notNull(),
  userId: integer('user_id').notNull(),
  scopes: text('scopes').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  issuedAt: integer('issued_at', { mode: 'timestamp' }).notNull(),
  rotatedFromId: integer('rotated_from_id'),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
});
