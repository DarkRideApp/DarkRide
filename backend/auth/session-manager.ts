import { randomBytes, createHash } from 'crypto';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { sessions, users } from '../db/schema';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const SLIDE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days before expiry
const SLIDE_COOLDOWN_MS = 60 * 60 * 1000;            // 1 hour between bumps

export interface SessionInfo {
  id: string;
  userId: number;
  providerId: string;
  csrfToken: string;
  expiresAt: Date;
  createdAt: Date;
  userAgent: string | null;
}

export interface ValidatedSession extends SessionInfo {
  scopes: string[];
  username: string;
}

export class SessionManager {
  constructor(private db: BetterSQLite3Database<any>) {}

  create(
    userId: number,
    providerId: string,
    userAgent: string | null,
    ip: string | null,
  ): SessionInfo {
    const id = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const ipHash = ip
      ? createHash('sha256').update(ip + ':darkride').digest('hex').substring(0, 16)
      : null;

    this.db.insert(sessions).values({
      id,
      userId,
      providerId,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt,
      userAgent: userAgent ?? null,
      ipHash,
      csrfToken,
    }).run();

    return { id, userId, providerId, csrfToken, expiresAt, createdAt: now, userAgent: userAgent ?? null };
  }

  validate(sessionId: string): ValidatedSession | null {
    const row = this.db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        providerId: sessions.providerId,
        csrfToken: sessions.csrfToken,
        expiresAt: sessions.expiresAt,
        createdAt: sessions.createdAt,
        userAgent: sessions.userAgent,
        lastAccessedAt: sessions.lastAccessedAt,
        revokedAt: sessions.revokedAt,
        username: users.username,
        userScopes: users.scopes,
        userEnabled: users.enabled,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, sessionId))
      .get();

    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt < new Date()) return null;
    if (!row.userEnabled) return null;

    // Sliding expiry
    const now = new Date();
    const timeToExpiry = row.expiresAt.getTime() - now.getTime();
    const timeSinceLastAccess = now.getTime() - row.lastAccessedAt.getTime();
    if (timeToExpiry < SLIDE_THRESHOLD_MS && timeSinceLastAccess > SLIDE_COOLDOWN_MS) {
      const newExpiry = new Date(now.getTime() + SESSION_TTL_MS);
      this.db.update(sessions)
        .set({ expiresAt: newExpiry, lastAccessedAt: now })
        .where(eq(sessions.id, sessionId))
        .run();
    }

    // Normalise scopes — Drizzle json mode returns parsed array, but in-memory
    // test DBs created with raw SQL may return the raw JSON string.
    const rawScopes = row.userScopes;
    const scopes: string[] = Array.isArray(rawScopes)
      ? rawScopes
      : JSON.parse(rawScopes as unknown as string);

    return {
      id: row.id,
      userId: row.userId,
      providerId: row.providerId,
      csrfToken: row.csrfToken,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      userAgent: row.userAgent,
      scopes,
      username: row.username,
    };
  }

  revoke(sessionId: string): void {
    this.db.update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  revokeAllForUser(userId: number): void {
    this.db.update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .run();
  }

  listForUser(userId: number): SessionInfo[] {
    return this.db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        providerId: sessions.providerId,
        csrfToken: sessions.csrfToken,
        expiresAt: sessions.expiresAt,
        createdAt: sessions.createdAt,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ))
      .all();
  }
}
