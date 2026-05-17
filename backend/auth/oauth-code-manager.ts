import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { oauthAuthorizationCodes } from '../db/oauth-schema';
import { sha256Hex, verifyPkceS256 } from './oauth-crypto';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface CreateCodeInput {
  clientId: string;
  userId: number;
  scopes: string[];
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  ttlMs?: number;
}

export type RedeemResult =
  | { ok: true; userId: number; scopes: string[]; clientId: string }
  | { ok: false; reason: string };

export interface RedeemInput {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}

export class OAuthCodeManager {
  constructor(private db: BetterSQLite3Database<Record<string, unknown>>) {}

  create(input: CreateCodeInput): { code: string; record: any } {
    if (input.codeChallengeMethod !== 'S256') {
      throw new Error('only S256 code_challenge_method is supported');
    }
    const code = randomBytes(20).toString('hex');
    const codeHash = sha256Hex(code);
    const ttl = input.ttlMs ?? CODE_TTL_MS;
    const record = this.db.insert(oauthAuthorizationCodes).values({
      codeHash,
      clientId: input.clientId,
      userId: input.userId,
      scopes: JSON.stringify(input.scopes),
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      expiresAt: new Date(Date.now() + ttl),
      createdAt: new Date(),
    }).returning().get();
    return { code, record };
  }

  redeem(input: RedeemInput): RedeemResult {
    const row = this.db.select().from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, sha256Hex(input.code))).get();
    if (!row) return { ok: false, reason: 'unknown code' };
    if (row.redeemedAt) return { ok: false, reason: 'code already redeemed' };
    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'code expired' };
    if (row.clientId !== input.clientId) return { ok: false, reason: 'client_id mismatch' };
    if (row.redirectUri !== input.redirectUri) return { ok: false, reason: 'redirect_uri mismatch' };
    if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) return { ok: false, reason: 'PKCE verification failed' };

    this.db.update(oauthAuthorizationCodes).set({ redeemedAt: new Date() })
      .where(eq(oauthAuthorizationCodes.id, row.id)).run();

    return { ok: true, userId: row.userId, scopes: JSON.parse(row.scopes), clientId: row.clientId };
  }
}
