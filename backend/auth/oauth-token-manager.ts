import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { oauthAccessTokens, oauthRefreshTokens } from '../db/oauth-schema';
import { generateToken, sha256Hex, tokenPrefix } from './oauth-crypto';

const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssuePairInput {
  clientId: string;
  userId: number;
  scopes: string[];
  accessTtlMs?: number;
  refreshTtlMs?: number;
  rotatedFromId?: number;
}

export interface IssuePairResult {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
}

export type RotateResult =
  | { ok: true; accessToken: string; refreshToken: string; accessExpiresIn: number }
  | { ok: false; reason: string };

export interface GrantSummary {
  clientId: string;
  scopes: string[];
  grantedAt: Date;
  lastUsedAt: Date | null;
  activeAccessTokens: number;
  activeRefreshTokens: number;
}

/**
 * OAuth token issuance, rotation, and revocation.
 *
 * Reuse detection policy (v1): when a previously-revoked refresh token is
 * presented, we revoke ALL tokens for that `(userId, clientId)` pair — not
 * just the specific rotation chain. This is broader than the RFC 6749 OAuth 2.1
 * recommendation to revoke only the compromised chain, but:
 *   - For single-device use (e.g. Claude Code on one machine), it's equivalent.
 *   - For multi-device use, a stolen token on one device will log the user out
 *     on all devices authorized through the same client. This is a deliberate
 *     tradeoff: we favor safety over device continuity in an attack scenario.
 *
 * The `rotated_from_id` column on refresh tokens is currently audit-only —
 * populated on rotation but not queried. It's preserved so a future release
 * can implement chain-specific revocation without a schema migration.
 */
export class OAuthTokenManager {
  constructor(private db: BetterSQLite3Database<Record<string, unknown>>) {}

  issuePair(input: IssuePairInput): IssuePairResult {
    const accessTtl = input.accessTtlMs ?? ACCESS_TTL_MS;
    const refreshTtl = input.refreshTtlMs ?? REFRESH_TTL_MS;
    const now = new Date();

    const rt = generateToken('oauth_rt_');
    const rtRow = this.db.insert(oauthRefreshTokens).values({
      tokenHash: sha256Hex(rt),
      clientId: input.clientId,
      userId: input.userId,
      scopes: JSON.stringify(input.scopes),
      expiresAt: new Date(now.getTime() + refreshTtl),
      issuedAt: now,
      rotatedFromId: input.rotatedFromId ?? null,
    }).returning().get();

    const at = generateToken('oauth_at_');
    this.db.insert(oauthAccessTokens).values({
      tokenHash: sha256Hex(at),
      tokenPrefix: tokenPrefix(at),
      clientId: input.clientId,
      userId: input.userId,
      scopes: JSON.stringify(input.scopes),
      refreshTokenId: rtRow.id,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + accessTtl),
    }).run();

    return { accessToken: at, refreshToken: rt, accessExpiresIn: Math.floor(accessTtl / 1000) };
  }

  findAccessTokenByPlaintext(token: string) {
    const row = this.db.select().from(oauthAccessTokens)
      .where(and(
        eq(oauthAccessTokens.tokenHash, sha256Hex(token)),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date()),
      )).get();
    return row ?? null;
  }

  /**
   * Diagnostic: why a presented access token would be rejected. Looks the token
   * up by hash ignoring the validity filters so callers can distinguish an
   * expired token from a revoked or entirely unknown one. For logging only.
   */
  classifyAccessToken(token: string): 'valid' | 'expired' | 'revoked' | 'unknown' {
    const row = this.db.select().from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.tokenHash, sha256Hex(token))).get();
    if (!row) return 'unknown';
    if (row.revokedAt) return 'revoked';
    if (row.expiresAt.getTime() <= Date.now()) return 'expired';
    return 'valid';
  }

  rotateRefreshToken(plaintext: string, clientId: string): RotateResult {
    const hash = sha256Hex(plaintext);
    const rt = this.db.select().from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, hash)).get();
    if (!rt) return { ok: false, reason: 'unknown refresh_token' };

    if (rt.clientId !== clientId) return { ok: false, reason: 'client_id mismatch' };

    if (rt.revokedAt) {
      // Reuse detection → chain revocation: wipe all tokens for this (user, client)
      this.revokeGrant(rt.userId, rt.clientId);
      return { ok: false, reason: 'refresh_token already used — chain revoked' };
    }
    if (rt.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'refresh_token expired' };

    // Wrap revoke + issue in a transaction so a crash mid-way can't destroy the grant.
    const scopes: string[] = JSON.parse(rt.scopes);
    const issued = (this.db as any).transaction((): IssuePairResult => {
      this.db.update(oauthRefreshTokens).set({ revokedAt: new Date() })
        .where(eq(oauthRefreshTokens.id, rt.id)).run();
      return this.issuePair({
        clientId: rt.clientId, userId: rt.userId, scopes,
        rotatedFromId: rt.id,
      });
    });
    return { ok: true, ...issued };
  }

  revokeAccessToken(plaintext: string): void {
    this.db.update(oauthAccessTokens).set({ revokedAt: new Date() })
      .where(eq(oauthAccessTokens.tokenHash, sha256Hex(plaintext))).run();
  }

  revokeRefreshToken(plaintext: string): void {
    this.db.update(oauthRefreshTokens).set({ revokedAt: new Date() })
      .where(eq(oauthRefreshTokens.tokenHash, sha256Hex(plaintext))).run();
  }

  revokeGrant(userId: number, clientId: string): void {
    const now = new Date();
    this.db.update(oauthAccessTokens).set({ revokedAt: now })
      .where(and(
        eq(oauthAccessTokens.userId, userId),
        eq(oauthAccessTokens.clientId, clientId),
        isNull(oauthAccessTokens.revokedAt),
      )).run();
    this.db.update(oauthRefreshTokens).set({ revokedAt: now })
      .where(and(
        eq(oauthRefreshTokens.userId, userId),
        eq(oauthRefreshTokens.clientId, clientId),
        isNull(oauthRefreshTokens.revokedAt),
      )).run();
  }

  listGrantsForUser(userId: number): GrantSummary[] {
    const rts = this.db.select().from(oauthRefreshTokens)
      .where(and(
        eq(oauthRefreshTokens.userId, userId),
        isNull(oauthRefreshTokens.revokedAt),
        gt(oauthRefreshTokens.expiresAt, new Date()),
      )).all();

    const ats = this.db.select().from(oauthAccessTokens)
      .where(and(
        eq(oauthAccessTokens.userId, userId),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date()),
      )).all();

    const byClient = new Map<string, GrantSummary>();
    for (const rt of rts) {
      const existing = byClient.get(rt.clientId);
      if (existing) {
        existing.activeRefreshTokens += 1;
        if (rt.issuedAt < existing.grantedAt) existing.grantedAt = rt.issuedAt;
      } else {
        byClient.set(rt.clientId, {
          clientId: rt.clientId,
          scopes: JSON.parse(rt.scopes),
          grantedAt: rt.issuedAt,
          lastUsedAt: null,
          activeAccessTokens: 0,
          activeRefreshTokens: 1,
        });
      }
    }
    for (const at of ats) {
      const existing = byClient.get(at.clientId);
      if (!existing) continue;
      existing.activeAccessTokens += 1;
      if (at.lastUsedAt && (!existing.lastUsedAt || at.lastUsedAt > existing.lastUsedAt)) {
        existing.lastUsedAt = at.lastUsedAt;
      }
    }
    return [...byClient.values()];
  }
}
